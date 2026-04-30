"""Very small rate-limit + in-flight dedup helpers backed by Redis or files.

Caps are tuned for a paid-B2C service where the expensive operation is
a GPT-4o summary generation. Reads (cache hits) are cheap and unmetered.
"""
from __future__ import annotations

import logging
import os
import time
from datetime import datetime, timezone
from pathlib import Path

from src.services import storage

logger = logging.getLogger(__name__)

# Defaults are conservative for launch; override via env.
DAILY_LIMIT_ANON = int(os.environ.get("RATE_LIMIT_ANON_PER_DAY", "20"))
DAILY_LIMIT_USER = int(os.environ.get("RATE_LIMIT_USER_PER_DAY", "100"))
INFLIGHT_TTL_SECONDS = int(os.environ.get("SUMMARY_INFLIGHT_TTL", "120"))


def _today_utc() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%d")


def _usage_key(scope: str, date: str) -> str:
    return f"usage:{date}:{scope}"


def _usage_file(scope: str, date: str) -> Path:
    safe = scope.replace("/", "_").replace(":", "_")
    base = Path("/tmp/data") if storage.is_vercel() else Path("data")
    return base / "usage" / date / f"{safe}.json"


def _read_count(scope: str, date: str) -> int:
    if storage._has_redis:
        try:
            val = storage._get_redis().get(_usage_key(scope, date))
            if val is None:
                return 0
            return int(val) if not isinstance(val, int) else val
        except Exception:
            return 0
    path = _usage_file(scope, date)
    if not path.exists():
        return 0
    try:
        import json
        return int(json.loads(path.read_text()).get("count", 0))
    except Exception:
        return 0


def _incr_count(scope: str, date: str) -> int:
    if storage._has_redis:
        try:
            redis = storage._get_redis()
            key = _usage_key(scope, date)
            new_val = redis.incr(key)
            # Expire at 36h so old days self-clean.
            try:
                redis.expire(key, 60 * 60 * 36)
            except Exception:
                pass
            return int(new_val) if not isinstance(new_val, int) else new_val
        except Exception:
            return 0
    path = _usage_file(scope, date)
    path.parent.mkdir(parents=True, exist_ok=True)
    import json
    current = 0
    if path.exists():
        try:
            current = int(json.loads(path.read_text()).get("count", 0))
        except Exception:
            current = 0
    current += 1
    path.write_text(json.dumps({"count": current}), encoding="utf-8")
    return current


def check_and_consume(scope: str, limit: int) -> tuple[bool, int, int]:
    """Increment the day's counter for scope and return (allowed, used, limit)."""
    if limit <= 0:
        return True, 0, 0  # 0 means unlimited
    date = _today_utc()
    used = _incr_count(scope, date)
    allowed = used <= limit
    return allowed, used, limit


def peek(scope: str) -> int:
    return _read_count(scope, _today_utc())


# ---------------------------------------------------------------------------
# Summary in-flight dedup
# ---------------------------------------------------------------------------

def _inflight_key(paper_id: str) -> str:
    return f"summary_inflight:{paper_id.replace('/', '_')}"


def _inflight_file(paper_id: str) -> Path:
    safe = paper_id.replace("/", "_").replace(":", "_")
    base = Path("/tmp/data") if storage.is_vercel() else Path("data")
    return base / "inflight" / f"{safe}.json"


def try_acquire_inflight(paper_id: str, ttl_seconds: int = INFLIGHT_TTL_SECONDS) -> bool:
    """Return True if this caller gets to run the expensive summary work.

    Uses Redis SET NX when available; a file-based fallback provides best-effort
    protection on local dev.
    """
    if storage._has_redis:
        try:
            redis = storage._get_redis()
            # Upstash supports SET with NX + EX in one call.
            result = redis.set(_inflight_key(paper_id), "1", nx=True, ex=ttl_seconds)
            return bool(result)
        except TypeError:
            try:
                redis = storage._get_redis()
                if redis.get(_inflight_key(paper_id)) is not None:
                    return False
                redis.set(_inflight_key(paper_id), "1")
                redis.expire(_inflight_key(paper_id), ttl_seconds)
                return True
            except Exception:
                return True
        except Exception:
            return True
    path = _inflight_file(paper_id)
    now = int(time.time())
    if path.exists():
        try:
            import json
            record = json.loads(path.read_text())
            exp = int(record.get("expires_at", 0))
            if exp > now:
                return False
        except Exception:
            pass
    path.parent.mkdir(parents=True, exist_ok=True)
    import json
    path.write_text(json.dumps({"expires_at": now + ttl_seconds}), encoding="utf-8")
    return True


def release_inflight(paper_id: str) -> None:
    if storage._has_redis:
        try:
            storage._get_redis().delete(_inflight_key(paper_id))
        except Exception:
            pass
        return
    path = _inflight_file(paper_id)
    if path.exists():
        try:
            path.unlink()
        except Exception:
            pass
