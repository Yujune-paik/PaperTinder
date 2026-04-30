"""Storage abstraction: file-based (local) vs Upstash Redis + Vercel Blob (Vercel).

When UPSTASH_REDIS_REST_URL is set, all JSON persistence goes through Upstash Redis.
When BLOB_READ_WRITE_TOKEN is set, figure uploads go to Vercel Blob.
Otherwise, falls back to local filesystem (data/ directory).
"""
from __future__ import annotations

import json
import logging
import os
from pathlib import Path

import httpx

logger = logging.getLogger(__name__)

_redis_client = None
_is_vercel = bool(os.environ.get("VERCEL") or os.environ.get("UPSTASH_REDIS_REST_URL"))
_has_redis = bool(os.environ.get("UPSTASH_REDIS_REST_URL"))
_blob_token = os.environ.get("BLOB_READ_WRITE_TOKEN", "")

DATA_DIR = Path("data")
READING_LIST_PATH = DATA_DIR / "reading_list.json"
PAPERS_CACHE_PATH = DATA_DIR / "papers_cache.json"
PROGRESS_DIR = DATA_DIR / "progress"
FIGURES_DIR = DATA_DIR / "figures"


TMP_DATA_DIR = Path("/tmp/data")
TMP_READING_LIST = TMP_DATA_DIR / "reading_list.json"
TMP_PAPERS_CACHE = TMP_DATA_DIR / "papers_cache.json"
TMP_PROGRESS_DIR = TMP_DATA_DIR / "progress"


def _get_redis():
    global _redis_client
    if _redis_client is None:
        from upstash_redis import Redis
        _redis_client = Redis(
            url=os.environ["UPSTASH_REDIS_REST_URL"].strip(),
            token=os.environ["UPSTASH_REDIS_REST_TOKEN"].strip(),
        )
    return _redis_client


def init_local_dirs():
    """Create data directories for storage."""
    if _is_vercel:
        for d in [TMP_DATA_DIR, TMP_PROGRESS_DIR]:
            d.mkdir(parents=True, exist_ok=True)
    else:
        for d in [DATA_DIR, PROGRESS_DIR, FIGURES_DIR]:
            d.mkdir(parents=True, exist_ok=True)


# ---------------------------------------------------------------------------
# Reading List
# ---------------------------------------------------------------------------

def _read_json_file(path: Path, default=None):
    if path.exists():
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return default
    return default


def _write_json_file(path: Path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")


def _reading_list_redis_key(user_id: str | None) -> str:
    return "reading_list" if not user_id else f"reading_list:{user_id}"


def _reading_list_file(user_id: str | None) -> Path:
    base = TMP_DATA_DIR if _is_vercel else DATA_DIR
    if not user_id:
        return TMP_READING_LIST if _is_vercel else READING_LIST_PATH
    safe = user_id.replace("/", "_")
    return base / "reading_lists" / f"{safe}.json"


def load_reading_list_raw(user_id: str | None = None) -> list[dict]:
    if _has_redis:
        data = _get_redis().get(_reading_list_redis_key(user_id))
        if data is None:
            return []
        if isinstance(data, str):
            return json.loads(data)
        return data
    return _read_json_file(_reading_list_file(user_id), [])


def save_reading_list_raw(items: list[dict], user_id: str | None = None):
    if _has_redis:
        _get_redis().set(
            _reading_list_redis_key(user_id),
            json.dumps(items, ensure_ascii=False),
        )
    else:
        _write_json_file(_reading_list_file(user_id), items)


# ---------------------------------------------------------------------------
# Papers Cache
# ---------------------------------------------------------------------------

def load_papers_cache_raw() -> dict[str, dict]:
    if _has_redis:
        data = _get_redis().get("papers_cache")
        if data is None:
            return {}
        if isinstance(data, str):
            return json.loads(data)
        return data
    path = TMP_PAPERS_CACHE if _is_vercel else PAPERS_CACHE_PATH
    return _read_json_file(path, {})


def save_papers_cache_raw(data: dict[str, dict]):
    if _has_redis:
        _get_redis().set("papers_cache", json.dumps(data, ensure_ascii=False))
    else:
        path = TMP_PAPERS_CACHE if _is_vercel else PAPERS_CACHE_PATH
        try:
            _write_json_file(path, data)
        except Exception:
            logger.warning("Failed to save papers cache")


# ---------------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------------

def _progress_redis_key(venue: str, year: int, user_id: str | None) -> str:
    base = f"{venue.lower().replace(' ', '_')}_{year}"
    return f"progress:{base}" if not user_id else f"progress:{user_id}:{base}"


def _progress_redis_prefix(user_id: str | None) -> str:
    return "progress:" if not user_id else f"progress:{user_id}:"


def _progress_dir(user_id: str | None) -> Path:
    base = TMP_PROGRESS_DIR if _is_vercel else PROGRESS_DIR
    if not user_id:
        return base
    safe = user_id.replace("/", "_")
    return base.parent / "progress_users" / safe


def load_progress_raw(venue: str, year: int, user_id: str | None = None) -> dict | None:
    key = f"{venue.lower().replace(' ', '_')}_{year}"
    if _has_redis:
        data = _get_redis().get(_progress_redis_key(venue, year, user_id))
        if data is None:
            return None
        if isinstance(data, str):
            return json.loads(data)
        return data
    prog_dir = _progress_dir(user_id)
    path = prog_dir / f"{key}.json"
    return _read_json_file(path)


def save_progress_raw(progress_data: dict, venue: str, year: int, user_id: str | None = None):
    key = f"{venue.lower().replace(' ', '_')}_{year}"
    if _has_redis:
        _get_redis().set(
            _progress_redis_key(venue, year, user_id),
            json.dumps(progress_data, ensure_ascii=False),
        )
    else:
        prog_dir = _progress_dir(user_id)
        path = prog_dir / f"{key}.json"
        _write_json_file(path, progress_data)


def load_all_progress_raw(user_id: str | None = None) -> list[dict]:
    if _has_redis:
        redis = _get_redis()
        prefix = _progress_redis_prefix(user_id)
        all_keys = redis.keys(f"{prefix}*") or []
        # When user_id is None we must exclude user-scoped keys (they match pattern too).
        if not user_id:
            all_keys = [k for k in all_keys if k.count(":") == 1]
        results = []
        for k in all_keys:
            data = redis.get(k)
            if data:
                if isinstance(data, str):
                    results.append(json.loads(data))
                else:
                    results.append(data)
        return results
    prog_dir = _progress_dir(user_id)
    results = []
    if prog_dir.exists():
        for path in prog_dir.glob("*.json"):
            results.append(_read_json_file(path, {}))
    return results


# ---------------------------------------------------------------------------
# Figures (Vercel Blob / local filesystem)
# ---------------------------------------------------------------------------

def get_pdf_cache_dir() -> Path:
    """Return the directory for temporary PDF storage."""
    if _is_vercel:
        tmp = Path("/tmp/pdf_cache")
        tmp.mkdir(parents=True, exist_ok=True)
        return tmp
    cache_dir = DATA_DIR / "pdf_cache"
    cache_dir.mkdir(parents=True, exist_ok=True)
    return cache_dir


def get_figures_dir(paper_id_safe: str) -> Path:
    """Return the directory for figure storage."""
    if _is_vercel:
        fig_dir = Path(f"/tmp/figures/{paper_id_safe}")
        fig_dir.mkdir(parents=True, exist_ok=True)
        return fig_dir
    fig_dir = FIGURES_DIR / paper_id_safe
    fig_dir.mkdir(parents=True, exist_ok=True)
    return fig_dir


async def upload_to_blob(file_bytes: bytes, pathname: str) -> str | None:
    """Upload bytes to Vercel Blob, return the public URL."""
    if not _blob_token:
        return None
    try:
        async with httpx.AsyncClient(timeout=30.0) as client:
            resp = await client.put(
                f"https://blob.vercel-storage.com/{pathname}",
                content=file_bytes,
                headers={
                    "Authorization": f"Bearer {_blob_token}",
                    "x-api-version": "7",
                    "x-content-type": "image/png",
                },
            )
            if resp.status_code in (200, 201):
                data = resp.json()
                return data.get("url")
            logger.warning(f"Blob upload failed ({resp.status_code}): {pathname}")
            return None
    except Exception:
        logger.warning(f"Blob upload error: {pathname}")
        return None


async def delete_blob_by_url(url: str) -> bool:
    """Delete a file from Vercel Blob given its public URL. Best-effort."""
    if not _blob_token or not url:
        return False
    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            resp = await client.post(
                "https://blob.vercel-storage.com/delete",
                json={"urls": [url]},
                headers={
                    "Authorization": f"Bearer {_blob_token}",
                    "x-api-version": "7",
                },
            )
            return resp.status_code < 400
    except Exception:
        logger.warning(f"Blob delete error: {url}")
        return False


def delete_local_figure_by_url(url: str) -> bool:
    """Delete a local figure file given its /figures/... URL. Returns success."""
    if _is_vercel:
        return False
    if not url or not url.startswith("/figures/"):
        return False
    rel = url[len("/figures/"):]
    path = FIGURES_DIR / rel
    if path.exists():
        try:
            path.unlink()
            return True
        except Exception:
            return False
    return False


def delete_figure_urls(paper_id: str) -> None:
    """Remove the figure URL list entry (does not delete underlying files)."""
    if _has_redis:
        try:
            _get_redis().delete(f"figures:{paper_id.replace('/', '_')}")
        except Exception:
            pass
        return
    path = TMP_FIGURES_CACHE if _is_vercel else FIGURES_CACHE_PATH
    cache = _read_json_file(path, {})
    if paper_id in cache:
        del cache[paper_id]
        try:
            _write_json_file(path, cache)
        except Exception:
            pass


def delete_summary(paper_id: str) -> None:
    """Remove a cached summary."""
    if _has_redis:
        try:
            _get_redis().delete(_safe_redis_key(paper_id))
        except Exception:
            pass
        return
    path = TMP_SUMMARIES_CACHE if _is_vercel else SUMMARIES_CACHE_PATH
    cache = _read_json_file(path, {})
    if paper_id in cache:
        del cache[paper_id]
        try:
            _write_json_file(path, cache)
        except Exception:
            pass


# ---------------------------------------------------------------------------
# Admin cache inspection helpers
# ---------------------------------------------------------------------------

def list_cached_summary_ids() -> list[str]:
    """Return all paper_ids that currently have a cached summary."""
    if _has_redis:
        keys = _get_redis().keys("summary:*") or []
        return [k.replace("summary:", "", 1) for k in keys]
    path = TMP_SUMMARIES_CACHE if _is_vercel else SUMMARIES_CACHE_PATH
    cache = _read_json_file(path, {})
    return list(cache.keys())


def list_cached_figure_ids() -> list[str]:
    """Return all paper_ids that currently have cached figure URLs."""
    if _has_redis:
        keys = _get_redis().keys("figures:*") or []
        return [k.replace("figures:", "", 1) for k in keys]
    path = TMP_FIGURES_CACHE if _is_vercel else FIGURES_CACHE_PATH
    cache = _read_json_file(path, {})
    return list(cache.keys())


def cache_stats() -> dict:
    """Return aggregate cache stats for admin inspection.

    Counts entries across all storage layers and (for local fs) sums
    on-disk byte sizes for the heavy figure/PDF blobs.
    """
    summary_ids = list_cached_summary_ids()
    figure_ids = list_cached_figure_ids()

    # An "empty" summary is one whose values are all blank strings.
    empty_summaries = 0
    for pid in summary_ids:
        s = load_summary(pid) or {}
        if not any((v or "").strip() for v in s.values()):
            empty_summaries += 1

    decks = load_all_decks()
    total_paper_ids_in_decks = sum(len(d.get("paper_ids") or []) for d in decks)

    papers_cache = load_papers_cache_raw()

    pdf_count = 0
    pdf_bytes = 0
    figures_dir_bytes = 0
    if not _is_vercel:
        pdf_dir = DATA_DIR / "pdf_cache"
        if pdf_dir.exists():
            for p in pdf_dir.glob("*.pdf"):
                pdf_count += 1
                try:
                    pdf_bytes += p.stat().st_size
                except Exception:
                    pass
        if FIGURES_DIR.exists():
            for p in FIGURES_DIR.rglob("*"):
                if p.is_file():
                    try:
                        figures_dir_bytes += p.stat().st_size
                    except Exception:
                        pass

    return {
        "summaries": {
            "count": len(summary_ids),
            "empty": empty_summaries,
        },
        "figures": {
            "count": len(figure_ids),
            "total_bytes": figures_dir_bytes,
        },
        "decks": {
            "count": len(decks),
            "total_paper_ids": total_paper_ids_in_decks,
        },
        "papers_metadata": {
            "count": len(papers_cache),
        },
        "pdf_files": {
            "count": pdf_count,
            "total_bytes": pdf_bytes,
        },
        "backend": "redis" if _has_redis else "filesystem",
    }


def get_pdf_cache_info(paper_id: str) -> dict:
    """Return whether a PDF is locally cached and its size."""
    if _is_vercel:
        return {"cached": False, "bytes": 0}
    safe = paper_id.replace("/", "_")
    path = DATA_DIR / "pdf_cache" / f"{safe}.pdf"
    if path.exists():
        try:
            return {"cached": True, "bytes": path.stat().st_size}
        except Exception:
            return {"cached": True, "bytes": 0}
    return {"cached": False, "bytes": 0}


def delete_pdf_cache(paper_id: str) -> bool:
    if _is_vercel:
        return False
    safe = paper_id.replace("/", "_")
    path = DATA_DIR / "pdf_cache" / f"{safe}.pdf"
    if path.exists():
        try:
            path.unlink()
            return True
        except Exception:
            return False
    return False


def get_figure_url(paper_id_safe: str, filename: str) -> str:
    """Return the URL for a figure (local /figures/ path or Blob URL placeholder)."""
    if _is_vercel:
        return f"/api/figures/{paper_id_safe}/{filename}"
    return f"/figures/{paper_id_safe}/{filename}"


# ---------------------------------------------------------------------------
# Summaries Cache
# ---------------------------------------------------------------------------

SUMMARIES_CACHE_PATH = DATA_DIR / "summaries_cache.json"
TMP_SUMMARIES_CACHE = TMP_DATA_DIR / "summaries_cache.json"


def _safe_redis_key(paper_id: str) -> str:
    return f"summary:{paper_id.replace('/', '_')}"


def save_summary(paper_id: str, summary: dict):
    """Persist a single paper's parsed summary."""
    if _has_redis:
        _get_redis().set(
            _safe_redis_key(paper_id),
            json.dumps(summary, ensure_ascii=False),
        )
        return

    path = TMP_SUMMARIES_CACHE if _is_vercel else SUMMARIES_CACHE_PATH
    cache = _read_json_file(path, {})
    cache[paper_id] = summary
    try:
        _write_json_file(path, cache)
    except Exception:
        logger.warning("Failed to save summaries cache")


def load_summary(paper_id: str) -> dict | None:
    """Load a single paper's parsed summary."""
    if _has_redis:
        data = _get_redis().get(_safe_redis_key(paper_id))
        if data is None:
            return None
        if isinstance(data, str):
            return json.loads(data)
        return data

    path = TMP_SUMMARIES_CACHE if _is_vercel else SUMMARIES_CACHE_PATH
    cache = _read_json_file(path, {})
    return cache.get(paper_id)


def load_all_summaries(paper_ids: list[str]) -> dict[str, dict]:
    """Load summaries for multiple papers at once."""
    if _has_redis:
        redis = _get_redis()
        result = {}
        for pid in paper_ids:
            data = redis.get(_safe_redis_key(pid))
            if data is not None:
                if isinstance(data, str):
                    result[pid] = json.loads(data)
                else:
                    result[pid] = data
        return result

    path = TMP_SUMMARIES_CACHE if _is_vercel else SUMMARIES_CACHE_PATH
    cache = _read_json_file(path, {})
    return {pid: cache[pid] for pid in paper_ids if pid in cache}


FIGURES_CACHE_PATH = DATA_DIR / "figures_cache.json"
TMP_FIGURES_CACHE = TMP_DATA_DIR / "figures_cache.json"


def save_figure_urls(paper_id: str, urls: list[str]):
    """Persist figure URLs for a paper so they can be included in exports."""
    if not urls:
        return
    if _has_redis:
        _get_redis().set(
            f"figures:{paper_id.replace('/', '_')}",
            json.dumps(urls, ensure_ascii=False),
        )
        return
    path = TMP_FIGURES_CACHE if _is_vercel else FIGURES_CACHE_PATH
    cache = _read_json_file(path, {})
    cache[paper_id] = urls
    try:
        _write_json_file(path, cache)
    except Exception:
        logger.warning("Failed to save figures cache")


def load_figure_urls(paper_id: str) -> list[str]:
    """Load figure URLs for a paper."""
    if _has_redis:
        data = _get_redis().get(f"figures:{paper_id.replace('/', '_')}")
        if data is None:
            return []
        if isinstance(data, str):
            return json.loads(data)
        return data
    path = TMP_FIGURES_CACHE if _is_vercel else FIGURES_CACHE_PATH
    cache = _read_json_file(path, {})
    return cache.get(paper_id, [])


def load_all_figure_urls(paper_ids: list[str]) -> dict[str, list[str]]:
    """Load figure URLs for multiple papers."""
    if _has_redis:
        redis = _get_redis()
        result = {}
        for pid in paper_ids:
            data = redis.get(f"figures:{pid.replace('/', '_')}")
            if data is not None:
                if isinstance(data, str):
                    result[pid] = json.loads(data)
                else:
                    result[pid] = data
        return result
    path = TMP_FIGURES_CACHE if _is_vercel else FIGURES_CACHE_PATH
    cache = _read_json_file(path, {})
    return {pid: cache[pid] for pid in paper_ids if pid in cache}


# ---------------------------------------------------------------------------
# Decks (pre-built card sets per venue+year)
# ---------------------------------------------------------------------------

DECKS_DIR = DATA_DIR / "decks"
TMP_DECKS_DIR = TMP_DATA_DIR / "decks"


def _deck_key(venue: str, year: int) -> str:
    return f"{venue.lower().replace(' ', '_')}_{year}"


def save_deck(venue: str, year: int, paper_ids: list[str]):
    key = _deck_key(venue, year)
    payload = {"venue": venue, "year": year, "paper_ids": paper_ids}
    if _has_redis:
        _get_redis().set(f"deck:{key}", json.dumps(payload, ensure_ascii=False))
        return
    deck_dir = TMP_DECKS_DIR if _is_vercel else DECKS_DIR
    deck_dir.mkdir(parents=True, exist_ok=True)
    _write_json_file(deck_dir / f"{key}.json", payload)


def load_deck(venue: str, year: int) -> dict | None:
    key = _deck_key(venue, year)
    if _has_redis:
        data = _get_redis().get(f"deck:{key}")
        if data is None:
            return None
        return json.loads(data) if isinstance(data, str) else data
    deck_dir = TMP_DECKS_DIR if _is_vercel else DECKS_DIR
    return _read_json_file(deck_dir / f"{key}.json")


def load_all_decks() -> list[dict]:
    if _has_redis:
        redis = _get_redis()
        keys = redis.keys("deck:*")
        results = []
        for k in keys or []:
            data = redis.get(k)
            if data:
                parsed = json.loads(data) if isinstance(data, str) else data
                results.append(parsed)
        return results
    deck_dir = TMP_DECKS_DIR if _is_vercel else DECKS_DIR
    results = []
    if deck_dir.exists():
        for path in deck_dir.glob("*.json"):
            d = _read_json_file(path)
            if d:
                results.append(d)
    return results


def delete_deck(venue: str, year: int):
    key = _deck_key(venue, year)
    if _has_redis:
        _get_redis().delete(f"deck:{key}")
        return
    deck_dir = TMP_DECKS_DIR if _is_vercel else DECKS_DIR
    path = deck_dir / f"{key}.json"
    if path.exists():
        path.unlink()


def is_vercel() -> bool:
    return _is_vercel


# ---------------------------------------------------------------------------
# Users (Google OAuth) and per-user preferences
# ---------------------------------------------------------------------------

USERS_DIR = DATA_DIR / "users"
TMP_USERS_DIR = TMP_DATA_DIR / "users"
SESSIONS_DIR = DATA_DIR / "sessions"
TMP_SESSIONS_DIR = TMP_DATA_DIR / "sessions"


def _users_dir() -> Path:
    d = TMP_USERS_DIR if _is_vercel else USERS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def _sessions_dir() -> Path:
    d = TMP_SESSIONS_DIR if _is_vercel else SESSIONS_DIR
    d.mkdir(parents=True, exist_ok=True)
    return d


def save_user(user: dict):
    """Create or update a user record keyed by google_id."""
    google_id = user.get("google_id")
    if not google_id:
        return
    if _has_redis:
        _get_redis().set(f"user:{google_id}", json.dumps(user, ensure_ascii=False))
        return
    _write_json_file(_users_dir() / f"{google_id}.json", user)


def load_user(google_id: str) -> dict | None:
    if _has_redis:
        data = _get_redis().get(f"user:{google_id}")
        if data is None:
            return None
        return json.loads(data) if isinstance(data, str) else data
    return _read_json_file(_users_dir() / f"{google_id}.json")


def save_user_preferences(google_id: str, preferences: dict):
    if _has_redis:
        _get_redis().set(
            f"user_prefs:{google_id}",
            json.dumps(preferences, ensure_ascii=False),
        )
        return
    _write_json_file(_users_dir() / f"{google_id}_prefs.json", preferences)


def load_user_preferences(google_id: str) -> dict | None:
    if _has_redis:
        data = _get_redis().get(f"user_prefs:{google_id}")
        if data is None:
            return None
        return json.loads(data) if isinstance(data, str) else data
    return _read_json_file(_users_dir() / f"{google_id}_prefs.json")


def save_session(session_id: str, google_id: str, ttl_seconds: int | None = None):
    if _has_redis:
        redis = _get_redis()
        if ttl_seconds:
            try:
                redis.set(f"session:{session_id}", google_id, ex=ttl_seconds)
                return
            except TypeError:
                # Fall back for Redis clients that don't support ex kwarg
                redis.set(f"session:{session_id}", google_id)
                try:
                    redis.expire(f"session:{session_id}", ttl_seconds)
                except Exception:
                    pass
                return
        redis.set(f"session:{session_id}", google_id)
        return
    record = {"google_id": google_id}
    if ttl_seconds:
        import time
        record["expires_at"] = int(time.time()) + ttl_seconds
    _write_json_file(_sessions_dir() / f"{session_id}.json", record)


def load_session(session_id: str) -> str | None:
    if _has_redis:
        # Redis auto-expires; a missing key just returns None.
        data = _get_redis().get(f"session:{session_id}")
        if data is None:
            return None
        return data if isinstance(data, str) else data.get("google_id") if isinstance(data, dict) else None
    path = _sessions_dir() / f"{session_id}.json"
    record = _read_json_file(path)
    if not record:
        return None
    exp = record.get("expires_at")
    if exp is not None:
        import time
        if int(time.time()) >= int(exp):
            try:
                path.unlink()
            except Exception:
                pass
            return None
    return record.get("google_id")


def delete_session(session_id: str):
    if _has_redis:
        _get_redis().delete(f"session:{session_id}")
        return
    path = _sessions_dir() / f"{session_id}.json"
    if path.exists():
        path.unlink()


def cleanup_expired_sessions() -> int:
    """Remove expired file-based session records. Redis handles its own TTL.

    Returns the number of sessions deleted. Intended to be called periodically
    (admin endpoint or scheduled job); safe to call during a request.
    """
    if _has_redis:
        return 0
    import time
    now = int(time.time())
    removed = 0
    d = _sessions_dir()
    if not d.exists():
        return 0
    for path in d.glob("*.json"):
        record = _read_json_file(path)
        if not record:
            continue
        exp = record.get("expires_at")
        if exp is not None and now >= int(exp):
            try:
                path.unlink()
                removed += 1
            except Exception:
                pass
    return removed
