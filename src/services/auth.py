"""Google OAuth authentication utilities.

Only a Google ID token from the frontend is verified server-side.
A random session id is handed back as an httpOnly cookie and mapped
to the Google user via the storage layer.
"""
from __future__ import annotations

import logging
import os
import secrets
from datetime import datetime, timezone

from fastapi import Request

from src.services import storage

logger = logging.getLogger(__name__)

SESSION_COOKIE = "pt_session"
SESSION_TTL_SECONDS = 60 * 60 * 24 * 30  # 30 days


def _client_id() -> str | None:
    cid = os.environ.get("GOOGLE_CLIENT_ID", "").strip()
    return cid or None


def is_configured() -> bool:
    return _client_id() is not None


def verify_google_token(id_token_str: str) -> dict | None:
    """Verify a Google ID token and return claims (or None on failure)."""
    client_id = _client_id()
    if not client_id:
        logger.warning("GOOGLE_CLIENT_ID not set; rejecting Google login")
        return None
    try:
        from google.oauth2 import id_token
        from google.auth.transport import requests as google_requests
    except Exception:
        logger.exception("google-auth package not installed")
        return None

    try:
        claims = id_token.verify_oauth2_token(
            id_token_str,
            google_requests.Request(),
            client_id,
        )
    except Exception as e:
        logger.warning(f"Google token verification failed: {e}")
        return None

    if claims.get("iss") not in (
        "accounts.google.com",
        "https://accounts.google.com",
    ):
        logger.warning("Invalid token issuer")
        return None

    return claims


def login_with_google(id_token_str: str) -> tuple[dict, str] | None:
    """Verify token, upsert user, and return (user_dict, session_id)."""
    claims = verify_google_token(id_token_str)
    if not claims:
        return None

    google_id = claims.get("sub")
    if not google_id:
        return None

    existing = storage.load_user(google_id) or {}
    user = {
        "google_id": google_id,
        "email": claims.get("email", existing.get("email", "")),
        "name": claims.get("name", existing.get("name")),
        "picture": claims.get("picture", existing.get("picture")),
        "created_at": existing.get("created_at") or datetime.now(timezone.utc).isoformat(),
    }
    storage.save_user(user)

    session_id = secrets.token_urlsafe(32)
    storage.save_session(session_id, google_id)
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
