"""Google OAuth authentication utilities.

Only a Google ID token from the frontend is verified server-side.
A random session id is handed back as an httpOnly cookie and mapped
to the Google user via the storage layer.

The ID token (a JWT signed with RS256) is verified manually against
Google's published certificates so we don't need ``google-auth`` plus
its ``requests``/``urllib3`` transport dependencies — that combination
fails to install reliably on Vercel's vendored Python runtime, leaving
the function with ``ModuleNotFoundError: requests``.
"""
from __future__ import annotations

import base64
import json
import logging
import os
import secrets
import time
import urllib.request
from datetime import datetime, timezone
from typing import Any

from cryptography.hazmat.primitives.asymmetric.padding import PKCS1v15
from cryptography.hazmat.primitives.hashes import SHA256
from cryptography.x509 import load_pem_x509_certificate
from fastapi import HTTPException, Request

from src.services import storage

logger = logging.getLogger(__name__)

SESSION_COOKIE = "pt_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days

GOOGLE_CERTS_URL = "https://www.googleapis.com/oauth2/v1/certs"
GOOGLE_ISSUERS = ("accounts.google.com", "https://accounts.google.com")
_CERTS_TTL_SECONDS = 3600  # Google rotates ~daily; an hour is plenty.

# Per-process cert cache. Keys = the kid → PEM map from Google.
_CERTS_CACHE: dict[str, Any] = {"keys": None, "fetched_at": 0.0}


def _client_id() -> str | None:
    cid = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    return cid or None


def _admin_emails() -> set[str]:
    raw = os.environ.get("ADMIN_EMAILS", "")
    return {e.strip().lower() for e in raw.split(",") if e.strip()}


def _is_admin_email(email: str | None) -> bool:
    if not email:
        return False
    return email.strip().lower() in _admin_emails()


def is_configured() -> bool:
    return _client_id() is not None


def _b64url_decode(s: str) -> bytes:
    """Base64-url-safe decode that tolerates missing padding (per RFC 7515)."""
    return base64.urlsafe_b64decode(s + "=" * (-len(s) % 4))


def _fetch_google_certs() -> dict[str, str]:
    """Fetch (and cache for an hour) Google's OAuth2 PEM certs."""
    now = time.time()
    cached = _CERTS_CACHE.get("keys")
    if cached and (now - _CERTS_CACHE.get("fetched_at", 0.0)) < _CERTS_TTL_SECONDS:
        return cached
    with urllib.request.urlopen(GOOGLE_CERTS_URL, timeout=10) as resp:
        data = json.loads(resp.read())
    _CERTS_CACHE["keys"] = data
    _CERTS_CACHE["fetched_at"] = now
    return data


def verify_google_token(id_token_str: str) -> dict | None:
    """Verify a Google ID token (RS256 JWT) and return its claims.

    Returns ``None`` if the token is malformed, has an invalid signature,
    is expired, or doesn't target our ``GOOGLE_CLIENT_ID``.
    """
    client_id = _client_id()
    if not client_id:
        logger.warning("GOOGLE_CLIENT_ID not set; rejecting Google login")
        return None
    try:
        parts = id_token_str.split(".")
        if len(parts) != 3:
            logger.warning("Token is not a JWT (does not have 3 parts)")
            return None
        header_b64, payload_b64, signature_b64 = parts
        header = json.loads(_b64url_decode(header_b64))
        payload = json.loads(_b64url_decode(payload_b64))
        signature = _b64url_decode(signature_b64)

        kid = header.get("kid")
        alg = header.get("alg")
        if alg != "RS256" or not kid:
            logger.warning(f"Unexpected JWT header: alg={alg} kid={kid}")
            return None

        certs = _fetch_google_certs()
        cert_pem = certs.get(kid)
        if not cert_pem:
            logger.warning(f"No Google cert matches kid={kid}")
            return None
        cert = load_pem_x509_certificate(cert_pem.encode())
        public_key = cert.public_key()

        signed_input = f"{header_b64}.{payload_b64}".encode()
        public_key.verify(signature, signed_input, PKCS1v15(), SHA256())

        # Claim validation
        if payload.get("aud") != client_id:
            logger.warning(
                f"Token aud mismatch (expected {client_id}, got {payload.get('aud')})"
            )
            return None
        if payload.get("iss") not in GOOGLE_ISSUERS:
            logger.warning(f"Invalid token issuer: {payload.get('iss')}")
            return None
        now = int(time.time())
        if int(payload.get("exp", 0)) < now:
            logger.warning("Token has expired")
            return None
        if int(payload.get("iat", 0)) > now + 300:  # 5-min clock skew tolerance
            logger.warning("Token iat is in the future")
            return None

        return payload
    except Exception as e:
        logger.warning(f"Google token verification failed: {e}")
        return None


def login_with_google(id_token_str: str) -> tuple[dict, str] | None:
    """Verify token, upsert user, and return (user_dict, session_id)."""
    claims = verify_google_token(id_token_str)
    if not claims:
        return None

    google_id = claims.get("sub")
    if not google_id:
        return None

    existing = storage.load_user(google_id) or {}
    email = claims.get("email", existing.get("email", ""))
    user = {
        "google_id": google_id,
        "email": email,
        "name": claims.get("name", existing.get("name")),
        "picture": claims.get("picture", existing.get("picture")),
        "created_at": existing.get("created_at") or datetime.now(timezone.utc).isoformat(),
        "role": "admin" if _is_admin_email(email) else existing.get("role", "user"),
    }
    # Re-evaluate admin on every login so ADMIN_EMAILS changes take effect.
    if _is_admin_email(email):
        user["role"] = "admin"
    elif user.get("role") == "admin" and not _is_admin_email(email):
        # Previously admin but email was removed from ADMIN_EMAILS → demote.
        user["role"] = "user"
    storage.save_user(user)

    session_id = secrets.token_urlsafe(32)
    storage.save_session(session_id, google_id, ttl_seconds=SESSION_TTL_SECONDS)
    return user, session_id


def get_current_user(request: Request) -> dict | None:
    """Return the user record tied to the request's session cookie, if any."""
    session_id = request.cookies.get(SESSION_COOKIE)
    if not session_id:
        return None
    google_id = storage.load_session(session_id)
    if not google_id:
        return None
    return storage.load_user(google_id)


def logout(request: Request) -> None:
    session_id = request.cookies.get(SESSION_COOKIE)
    if session_id:
        storage.delete_session(session_id)


def is_admin(user: dict | None) -> bool:
    if not user:
        return False
    if user.get("role") == "admin":
        return True
    # Fallback for users created before the role field was introduced.
    return _is_admin_email(user.get("email"))


def require_admin(request: Request) -> dict:
    """Raise 401/403 unless the request carries a valid admin session."""
    user = get_current_user(request)
    if not user:
        raise HTTPException(401, "Login required")
    if not is_admin(user):
        raise HTTPException(403, "Admin access required")
    return user
