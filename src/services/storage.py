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


def load_reading_list_raw() -> list[dict]:
    if _has_redis:
        data = _get_redis().get("reading_list")
        if data is None:
            return []
        if isinstance(data, str):
            return json.loads(data)
        return data
    path = TMP_READING_LIST if _is_vercel else READING_LIST_PATH
    return _read_json_file(path, [])


def save_reading_list_raw(items: list[dict]):
    if _has_redis:
        _get_redis().set("reading_list", json.dumps(items, ensure_ascii=False))
    else:
        path = TMP_READING_LIST if _is_vercel else READING_LIST_PATH
        _write_json_file(path, items)


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

def load_progress_raw(venue: str, year: int) -> dict | None:
    key = f"{venue.lower().replace(' ', '_')}_{year}"
    if _has_redis:
        data = _get_redis().get(f"progress:{key}")
        if data is None:
            return None
        if isinstance(data, str):
            return json.loads(data)
        return data
    prog_dir = TMP_PROGRESS_DIR if _is_vercel else PROGRESS_DIR
    path = prog_dir / f"{key}.json"
    return _read_json_file(path)


def save_progress_raw(progress_data: dict, venue: str, year: int):
    key = f"{venue.lower().replace(' ', '_')}_{year}"
    if _has_redis:
        _get_redis().set(f"progress:{key}", json.dumps(progress_data, ensure_ascii=False))
    else:
        prog_dir = TMP_PROGRESS_DIR if _is_vercel else PROGRESS_DIR
        path = prog_dir / f"{key}.json"
        _write_json_file(path, progress_data)


def load_all_progress_raw() -> list[dict]:
    if _has_redis:
        redis = _get_redis()
        keys = redis.keys("progress:*")
        results = []
        for k in keys or []:
            data = redis.get(k)
            if data:
                if isinstance(data, str):
                    results.append(json.loads(data))
                else:
                    results.append(data)
        return results
    prog_dir = TMP_PROGRESS_DIR if _is_vercel else PROGRESS_DIR
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


def save_session(session_id: str, google_id: str):
    if _has_redis:
        _get_redis().set(f"session:{session_id}", google_id)
        return
    _write_json_file(_sessions_dir() / f"{session_id}.json", {"google_id": google_id})


def load_session(session_id: str) -> str | None:
    if _has_redis:
        data = _get_redis().get(f"session:{session_id}")
        if data is None:
            return None
        return data if isinstance(data, str) else data.get("google_id") if isinstance(data, dict) else None
    record = _read_json_file(_sessions_dir() / f"{session_id}.json")
    if not record:
        return None
    return record.get("google_id")


def delete_session(session_id: str):
    if _has_redis:
        _get_redis().delete(f"session:{session_id}")
        return
    path = _sessions_dir() / f"{session_id}.json"
    if path.exists():
        path.unlink()
