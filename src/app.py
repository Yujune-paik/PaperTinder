from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

import yaml
from fastapi import FastAPI, HTTPException, Request, Response, UploadFile, File as FastAPIFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from src.models import PaperMeta, ProgressData, ReadingListItem, SearchRequest
from src.services import pdf_processor, semantic_scholar, summarizer
from src.services import storage
from src.services import auth as auth_service
from src.services import venues as venues_service
from src.services import scrapbox as scrapbox_exporter
from src.services import notebooklm as notebooklm_service
from src.services import rate_limit

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="PaperTinder", version="0.1.0")


def _cors_origins() -> list[str]:
    """Resolve allowed CORS origins from ALLOWED_ORIGINS env.

    Comma-separated list, or "*" to allow all. When unset, defaults to "*"
    for local development. In production, set ALLOWED_ORIGINS to your
    deployed domain(s).
    """
    raw = os.environ.get("ALLOWED_ORIGINS", "").strip()
    if not raw:
        return ["*"]
    return [o.strip() for o in raw.split(",") if o.strip()]


_allowed_origins = _cors_origins()
_allow_credentials = _allowed_origins != ["*"]

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins,
    allow_methods=["*"],
    allow_headers=["*"],
    allow_credentials=_allow_credentials,
)

storage.init_local_dirs()

_papers_cache: dict[str, PaperMeta] = {}

try:
    with open("config.yaml") as f:
        config = yaml.safe_load(f)
except Exception:
    config = {}


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

def _load_papers_cache():
    try:
        data = storage.load_papers_cache_raw()
        for paper_id, paper_data in data.items():
            _papers_cache[paper_id] = PaperMeta(**paper_data)
        logger.info(f"Loaded {len(_papers_cache)} papers from cache")
    except Exception:
        logger.warning("Failed to load papers cache")


def _save_papers_cache():
    try:
        data = {pid: p.model_dump() for pid, p in _papers_cache.items()}
        storage.save_papers_cache_raw(data)
    except Exception:
        logger.warning("Failed to save papers cache")


_load_papers_cache()

if storage.is_vercel():
    logger.info(f"Running on Vercel (redis={'yes' if storage._has_redis else 'no'}, blob={'yes' if storage._blob_token else 'no'})")
if os.environ.get("OPENAI_API_KEY"):
    logger.info("OPENAI_API_KEY is set")
else:
    logger.warning("OPENAI_API_KEY is NOT set - summaries will fail")


def _user_id_from_request(request: Request | None) -> str | None:
    if request is None:
        return None
    user = auth_service.get_current_user(request)
    return user.get("google_id") if user else None


def _load_reading_list(user_id: str | None = None) -> list[ReadingListItem]:
    data = storage.load_reading_list_raw(user_id)
    return [ReadingListItem(**item) for item in data]


def _save_reading_list(items: list[ReadingListItem], user_id: str | None = None):
    storage.save_reading_list_raw([item.model_dump() for item in items], user_id)


def _load_progress(venue: str, year: int, user_id: str | None = None) -> ProgressData:
    data = storage.load_progress_raw(venue, year, user_id)
    if data:
        return ProgressData(**data)
    return ProgressData(venue=venue, year=year)


def _save_progress(progress: ProgressData, user_id: str | None = None):
    storage.save_progress_raw(progress.model_dump(), progress.venue, progress.year, user_id)


def _rate_limit_scope(request: Request | None, user: dict | None) -> tuple[str, int]:
    """Return (scope, daily_limit) for this caller.

    Admin users are unlimited. Logged-in users have DAILY_LIMIT_USER. Anonymous
    traffic is bucketed by IP and subject to DAILY_LIMIT_ANON.
    """
    if user:
        if auth_service.is_admin(user):
            return f"user:{user['google_id']}", 0  # 0 = unlimited
        return f"user:{user['google_id']}", rate_limit.DAILY_LIMIT_USER
    ip = "unknown"
    if request is not None:
        ip = (request.client.host if request.client else None) or "unknown"
    return f"ip:{ip}", rate_limit.DAILY_LIMIT_ANON


async def _wait_for_cached_summary(paper_id: str, timeout_seconds: int | None = None) -> dict | None:
    """Poll the cache until another inflight generation completes or we time out.

    Default timeout is read from ``SUMMARY_DEDUP_WAIT_SECONDS`` (defaults to
    45s) so it stays under the Vercel function ``maxDuration`` (60s).
    """
    import asyncio
    if timeout_seconds is None:
        timeout_seconds = int(os.environ.get("SUMMARY_DEDUP_WAIT_SECONDS", "45"))
    waited = 0.0
    interval = 1.0
    while waited < timeout_seconds:
        cached = storage.load_summary(paper_id)
        if cached and any(v for v in cached.values()):
            return cached
        await asyncio.sleep(interval)
        waited += interval
        interval = min(interval * 1.3, 3.0)
    return None


def _summary_event_stream(meta: PaperMeta, request: Request | None = None):
    """Shared SSE generator for summary streaming."""

    async def _gen():
        yield f"data: {json.dumps({'type': 'connected'})}\n\n"
        acquired = False
        try:
            # ── Fast path: return cached summary immediately ──
            cached = storage.load_summary(meta.paper_id)
            if cached and any(v for v in cached.values()):
                logger.info(f"[stream] Cache hit: {meta.paper_id}")
                cached_figs = storage.load_figure_urls(meta.paper_id)
                if cached_figs:
                    yield f"data: {json.dumps({'type': 'figures', 'urls': cached_figs})}\n\n"
                yield f"data: {json.dumps({'type': 'summary', 'data': cached})}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return

            # ── Rate-limit cold generations (cache hits above are free) ──
            user = auth_service.get_current_user(request) if request else None
            scope, limit = _rate_limit_scope(request, user)
            allowed, used, lim = rate_limit.check_and_consume(scope, limit)
            if not allowed:
                yield f"data: {json.dumps({'type': 'rate_limited', 'used': used, 'limit': lim, 'message': f'本日の生成上限 ({lim}件) に達しました。明日またお試しください。'}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return

            # ── Dedup: if another worker is already generating this paper,
            #    wait for their cache write and stream that instead. ──
            if not rate_limit.try_acquire_inflight(meta.paper_id):
                logger.info(f"[stream] Waiting for inflight: {meta.paper_id}")
                yield f"data: {json.dumps({'type': 'waiting', 'message': '他のユーザーが同じ論文を生成中です…'})}\n\n"
                cached = await _wait_for_cached_summary(meta.paper_id)
                if cached:
                    cached_figs = storage.load_figure_urls(meta.paper_id)
                    if cached_figs:
                        yield f"data: {json.dumps({'type': 'figures', 'urls': cached_figs})}\n\n"
                    yield f"data: {json.dumps({'type': 'summary', 'data': cached})}\n\n"
                    yield f"data: {json.dumps({'type': 'done'})}\n\n"
                    return
                # The other worker didn't finish in time; fall through and try
                # ourselves. The inflight key will have expired by now.
            acquired = True

            doi = meta.doi
            if not doi and meta.semantic_scholar_url and "doi.org/" in meta.semantic_scholar_url:
                doi = meta.semantic_scholar_url

            logger.info(f"[stream] Start: {meta.paper_id} pdf_url={bool(meta.pdf_url)} doi={bool(doi)}")

            figure_urls: list[str] = []
            md_text = ""

            processed = await pdf_processor.process_pdf(meta.pdf_url, meta.paper_id, doi)
            md_text = processed.markdown_text
            figure_urls = processed.figure_paths
            logger.info(f"[stream] PDF done: figures={len(figure_urls)} md_len={len(md_text)}")

            if not figure_urls and doi:
                logger.info(f"[stream] Trying DOI thumbnail for {meta.paper_id}")
                try:
                    figure_urls = await pdf_processor.fetch_thumbnail(meta.paper_id, doi)
                except Exception:
                    logger.warning(f"[stream] Thumbnail fetch failed for {meta.paper_id}")
                    figure_urls = []

            if figure_urls:
                storage.save_figure_urls(meta.paper_id, figure_urls)
                yield f"data: {json.dumps({'type': 'figures', 'urls': figure_urls})}\n\n"

            logger.info(f"[stream] Starting OpenAI summary for {meta.paper_id}")
            full_text = ""
            async for chunk in summarizer.stream_quick_summary(meta, md_text):
                full_text += chunk
                yield f"data: {json.dumps({'type': 'chunk', 'text': chunk})}\n\n"

            parsed = summarizer.parse_tier1_response(full_text)
            # When the model didn't follow the CLAIM:/WHAT:/... structure
            # (typical for paywalled papers where md_text was empty), all
            # fields end up blank. Treat that as an error rather than caching
            # the empty result — otherwise the UI is stuck on "preparing"
            # forever and a retry would just hit the empty cache.
            if not any((v or "").strip() for v in parsed.values()):
                logger.warning(f"[stream] Empty structured output for {meta.paper_id}; raw len={len(full_text)}")
                yield f"data: {json.dumps({'type': 'error', 'message': 'PDF本文が取得できず、構造化要約を生成できませんでした。アブストラクトをご覧ください。'}, ensure_ascii=False)}\n\n"
                yield f"data: {json.dumps({'type': 'done'})}\n\n"
                return
            storage.save_summary(meta.paper_id, parsed)
            yield f"data: {json.dumps({'type': 'summary', 'data': parsed})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            logger.info(f"[stream] Done: {meta.paper_id}")
        except Exception as e:
            logger.exception(f"Summary stream error for {meta.paper_id}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"
        finally:
            if acquired:
                rate_limit.release_inflight(meta.paper_id)

    return _gen()


# ---------------------------------------------------------------------------
# Paper Search (streaming)
# ---------------------------------------------------------------------------

@app.post("/api/papers/stream")
async def stream_search_papers(req: SearchRequest, request: Request):
    # Papers seen per venue during this search so we can persist a deck
    # at the end — this way any subsequent user hitting the same venue/year
    # gets the cached deck without re-calling OpenAlex.
    venue_papers: dict[str, list[str]] = {}
    user_id = _user_id_from_request(request)

    async def event_stream():
        async for event in semantic_scholar.stream_search_venues(
            venues=req.venues,
            year=req.year,
            keyword=req.keyword,
            limit_per_venue=req.limit,
        ):
            if event["type"] == "papers":
                for p_data in event["papers"]:
                    meta = PaperMeta(**p_data)
                    _papers_cache[meta.paper_id] = meta
                    v = meta.venue or event.get("venue") or "unknown"
                    venue_papers.setdefault(v, []).append(meta.paper_id)
                _save_papers_cache()

            if event["type"] == "venue_done":
                venue = event["venue"]
                prog = _load_progress(venue, req.year, user_id)
                prog.total = max(prog.total, event.get("venue_total", event["venue_count"]))
                _save_progress(prog, user_id)

                # Auto-save deck: only write if the same venue+year is not
                # already stored, to preserve manually curated decks.
                pids = venue_papers.get(venue) or venue_papers.get(event["venue"]) or []
                if pids:
                    existing = storage.load_deck(venue, req.year)
                    if not existing:
                        try:
                            storage.save_deck(venue, req.year, pids)
                        except Exception:
                            logger.warning(f"Failed to auto-save deck {venue} {req.year}")

            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)


# ---------------------------------------------------------------------------
# Summary SSE
# ---------------------------------------------------------------------------

@app.get("/api/stream/{paper_id:path}")
async def stream_summary(paper_id: str, request: Request):
    meta = _papers_cache.get(paper_id)
    if not meta:
        raise HTTPException(404, "Paper not in cache")
    return StreamingResponse(_summary_event_stream(meta, request), media_type="text/event-stream", headers=SSE_HEADERS)


@app.post("/api/stream-inline")
async def stream_summary_inline(body: dict, request: Request):
    try:
        meta = PaperMeta(**body)
    except Exception:
        raise HTTPException(400, "Invalid paper metadata")
    _papers_cache[meta.paper_id] = meta
    _save_papers_cache()
    return StreamingResponse(_summary_event_stream(meta, request), media_type="text/event-stream", headers=SSE_HEADERS)


# ---------------------------------------------------------------------------
# Deep Summary SSE
# ---------------------------------------------------------------------------

@app.get("/api/stream-deep/{paper_id:path}")
async def stream_deep_summary(paper_id: str, request: Request):
    meta = _papers_cache.get(paper_id)
    if not meta:
        raise HTTPException(404, "Paper not in cache")

    user_id = _user_id_from_request(request)
    reading_list = _load_reading_list(user_id)
    session_titles = [item.title for item in reading_list if item.paper_id != paper_id]

    async def event_stream():
        md_text = ""
        if meta.pdf_url:
            processed = await pdf_processor.process_pdf(meta.pdf_url, paper_id)
            md_text = processed.markdown_text

        async for chunk in summarizer.stream_deep_summary(meta, md_text, session_titles):
            yield f"data: {json.dumps({'type': 'chunk', 'text': chunk})}\n\n"
        yield f"data: {json.dumps({'type': 'done'})}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)


# ---------------------------------------------------------------------------
# Reading List
# ---------------------------------------------------------------------------

@app.get("/api/reading-list")
async def get_reading_list(request: Request):
    user_id = _user_id_from_request(request)
    return {"items": [item.model_dump() for item in _load_reading_list(user_id)]}


@app.post("/api/reading-list")
async def add_to_reading_list(item: ReadingListItem, request: Request):
    user_id = _user_id_from_request(request)
    items = _load_reading_list(user_id)
    if any(i.paper_id == item.paper_id for i in items):
        return {"status": "already_exists"}
    item.saved_at = datetime.now(timezone.utc).isoformat()
    items.append(item)
    _save_reading_list(items, user_id)
    return {"status": "saved"}


@app.delete("/api/reading-list/{paper_id:path}")
async def remove_from_reading_list(paper_id: str, request: Request):
    user_id = _user_id_from_request(request)
    items = _load_reading_list(user_id)
    items = [i for i in items if i.paper_id != paper_id]
    _save_reading_list(items, user_id)
    return {"status": "removed"}


@app.post("/api/reading-list/merge")
async def merge_reading_list(body: dict, request: Request):
    """Merge a list of items (typically from localStorage) into the current user's list.

    Called once when an anonymous user signs in and wants to preserve what
    they saved while logged out.
    """
    user_id = _user_id_from_request(request)
    if not user_id:
        raise HTTPException(401, "Login required")
    incoming = body.get("items") or []
    if not isinstance(incoming, list):
        raise HTTPException(400, "items must be a list")
    items = _load_reading_list(user_id)
    existing_ids = {i.paper_id for i in items}
    added = 0
    for raw in incoming:
        if not isinstance(raw, dict):
            continue
        try:
            new_item = ReadingListItem(**raw)
        except Exception:
            continue
        if new_item.paper_id in existing_ids:
            continue
        if not new_item.saved_at:
            new_item.saved_at = datetime.now(timezone.utc).isoformat()
        items.append(new_item)
        existing_ids.add(new_item.paper_id)
        added += 1
    _save_reading_list(items, user_id)
    return {"status": "ok", "added": added, "total": len(items)}


# ---------------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------------

@app.get("/api/progress")
async def get_all_progress(request: Request):
    user_id = _user_id_from_request(request)
    return {"progress": storage.load_all_progress_raw(user_id)}


@app.get("/api/progress/{venue}/{year}")
async def get_progress(venue: str, year: int, request: Request):
    user_id = _user_id_from_request(request)
    return _load_progress(venue, year, user_id).model_dump()


@app.post("/api/progress/{venue}/{year}/seen")
async def mark_seen(venue: str, year: int, body: dict, request: Request):
    paper_id = body.get("paper_id")
    if not paper_id:
        raise HTTPException(400, "paper_id required")
    user_id = _user_id_from_request(request)
    prog = _load_progress(venue, year, user_id)
    if paper_id not in prog.seen:
        prog.seen.append(paper_id)
    _save_progress(prog, user_id)
    return {"status": "ok", "seen_count": len(prog.seen)}


@app.post("/api/progress/{venue}/{year}/saved")
async def mark_saved(venue: str, year: int, body: dict, request: Request):
    paper_id = body.get("paper_id")
    if not paper_id:
        raise HTTPException(400, "paper_id required")
    user_id = _user_id_from_request(request)
    prog = _load_progress(venue, year, user_id)
    if paper_id not in prog.saved:
        prog.saved.append(paper_id)
    _save_progress(prog, user_id)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------

def _collect_export_data(user_id: str | None = None) -> tuple[str, list[dict], dict[str, dict], dict[str, list[str]]]:
    """Gather papers + summaries + figures for export."""
    items = _load_reading_list(user_id)
    date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")

    papers = []
    paper_ids = [item.paper_id for item in items]

    for item in items:
        meta = _papers_cache.get(item.paper_id)
        paper_dict = {
            "paper_id": item.paper_id,
            "title": item.title,
            "venue": item.venue,
            "year": item.year,
        }
        if meta:
            paper_dict.update({
                "authors": meta.authors,
                "abstract": meta.abstract,
                "doi": meta.doi,
                "semantic_scholar_url": meta.semantic_scholar_url,
            })

        papers.append(paper_dict)

    summaries_map = storage.load_all_summaries(paper_ids)
    figures_map = storage.load_all_figure_urls(paper_ids)
    return date_str, papers, summaries_map, figures_map


# ---------------------------------------------------------------------------
# Export: status
# ---------------------------------------------------------------------------

@app.get("/api/export/status")
async def export_status():
    """Return which export services are configured."""
    return {
        "scrapbox": scrapbox_exporter.is_configured(),
        "notebooklm": notebooklm_service.is_configured(),
        "notebooklm_doc": True,
    }


# ---------------------------------------------------------------------------
# Export: Scrapbox
# ---------------------------------------------------------------------------

@app.get("/api/export/scrapbox")
async def export_scrapbox(request: Request):
    """Generate Scrapbox import JSON (clipboard copy fallback)."""
    user_id = _user_id_from_request(request)
    items = _load_reading_list(user_id)
    if not items:
        return {"text": "保存した論文がありません。", "pages": []}

    date_str, papers, summaries_map, figures_map = _collect_export_data(user_id)
    page = scrapbox_exporter.build_daily_page(date_str, papers, summaries_map, figures_map)

    text = "\n".join(page["lines"])
    return {"text": text, "pages": [page]}


@app.post("/api/export/scrapbox/push")
async def push_scrapbox(request: Request):
    """Push the daily summary page directly to Scrapbox via import API."""
    user_id = _user_id_from_request(request)
    items = _load_reading_list(user_id)
    if not items:
        return {"status": "error", "message": "保存した論文がありません。"}

    if not scrapbox_exporter.is_configured():
        return {"status": "error", "message": "Scrapbox未設定: SCRAPBOX_SID と SCRAPBOX_PROJECT を設定してください。"}

    try:
        date_str, papers, summaries_map, figures_map = _collect_export_data(user_id)
        page = scrapbox_exporter.build_daily_page(date_str, papers, summaries_map, figures_map)
        result = await scrapbox_exporter.push_to_scrapbox([page])
        return result
    except Exception as e:
        logger.exception("Scrapbox push failed")
        return {"status": "error", "message": str(e)}


# ---------------------------------------------------------------------------
# Export: NotebookLM document
# ---------------------------------------------------------------------------

@app.get("/api/export/notebooklm-doc")
async def export_notebooklm_doc(request: Request):
    """Generate a Markdown document optimised for NotebookLM ingestion."""
    user_id = _user_id_from_request(request)
    items = _load_reading_list(user_id)
    if not items:
        return {"text": "保存した論文がありません。", "title": ""}

    date_str, papers, summaries_map, _figures_map = _collect_export_data(user_id)
    title = f"論文セッション {date_str}"
    text = notebooklm_service.build_session_document(date_str, papers, summaries_map)
    return {"text": text, "title": title}


# ---------------------------------------------------------------------------
# Decks (pre-built card sets)
# ---------------------------------------------------------------------------

@app.get("/api/decks")
async def list_decks():
    """Return all available pre-built decks with per-deck stats."""
    decks = storage.load_all_decks()
    result = []
    for d in decks:
        venue = d.get("venue", "")
        year = d.get("year", 0)
        paper_ids = d.get("paper_ids", [])
        missing_fig = 0
        missing_sum = 0
        for pid in paper_ids:
            figs = storage.load_figure_urls(pid)
            summ = storage.load_summary(pid)
            if not figs:
                missing_fig += 1
            if not summ or not any(v for v in summ.values()):
                missing_sum += 1
        result.append({
            "venue": venue,
            "year": year,
            "count": len(paper_ids),
            "missing_figures": missing_fig,
            "missing_summary": missing_sum,
        })
    return {"decks": result}


@app.get("/api/decks/{venue}/{year}")
async def get_deck(venue: str, year: int, offset: int = 0, limit: int = 0):
    """Return cards in a pre-built deck with summaries and figure URLs.

    Supports pagination via ``offset`` and ``limit`` query parameters.
    When ``limit`` is 0 (default), all cards are returned for backward
    compatibility.
    """
    deck = storage.load_deck(venue, year)
    if not deck:
        raise HTTPException(404, "Deck not found")

    paper_ids = deck.get("paper_ids", [])
    deck_total = len(paper_ids)

    if limit > 0:
        paper_ids = paper_ids[offset : offset + limit]

    cards = []
    for pid in paper_ids:
        meta = _papers_cache.get(pid)
        if not meta:
            continue
        summary = storage.load_summary(pid)
        figures = storage.load_figure_urls(pid)
        has_summary = bool(summary and any(v for v in summary.values()))
        cards.append({
            **meta.model_dump(),
            "summary": summary,
            "figure_urls": figures or [],
            "has_summary": has_summary,
            "has_figures": bool(figures),
        })

    return {
        "venue": venue,
        "year": year,
        "cards": cards,
        "total": deck_total,
        "offset": offset,
        "has_more": (offset + len(cards)) < deck_total,
    }


# ---------------------------------------------------------------------------
# Admin: pre-build cards
# ---------------------------------------------------------------------------

@app.post("/api/admin/prebuild")
async def admin_prebuild(req: SearchRequest, request: Request):
    """Search papers then pre-generate summaries + figures for every card.

    Streams SSE progress so the admin page can show a live dashboard.
    On completion, saves the result as a deck per venue.
    """
    auth_service.require_admin(request)

    async def event_stream():
        yield f"data: {json.dumps({'type': 'phase', 'phase': 'search'}, ensure_ascii=False)}\n\n"

        all_papers: list[PaperMeta] = []
        venue_papers: dict[str, list[str]] = {}
        async for event in semantic_scholar.stream_search_venues(
            venues=req.venues, year=req.year,
            keyword=req.keyword, limit_per_venue=req.limit,
        ):
            if event["type"] == "papers":
                for p_data in event["papers"]:
                    meta = PaperMeta(**p_data)
                    _papers_cache[meta.paper_id] = meta
                    all_papers.append(meta)
                    v = meta.venue or "unknown"
                    venue_papers.setdefault(v, []).append(meta.paper_id)
                _save_papers_cache()
            if event["type"] == "venue_done":
                v_name = event["venue"]
                v_total = event.get("venue_total", event.get("venue_count", 0))
                prog = _load_progress(v_name, req.year)
                prog.total = max(prog.total, v_total)
                _save_progress(prog)
                yield f"data: {json.dumps({'type': 'venue_done', 'venue': v_name, 'count': event.get('venue_count', 0), 'venue_total': v_total}, ensure_ascii=False)}\n\n"

        total = len(all_papers)
        yield f"data: {json.dumps({'type': 'phase', 'phase': 'build', 'total': total}, ensure_ascii=False)}\n\n"

        missing_figures: list[dict] = []
        errors: list[dict] = []

        for idx, meta in enumerate(all_papers):
            pid = meta.paper_id
            paper_title = meta.title or "Untitled"

            cached_summary = storage.load_summary(pid)
            cached_figures = storage.load_figure_urls(pid)
            has_summary = cached_summary and any(v for v in cached_summary.values())
            has_figures = bool(cached_figures)

            if has_summary and has_figures:
                yield f"data: {json.dumps({'type': 'progress', 'current': idx + 1, 'total': total, 'paper_id': pid, 'title': paper_title, 'status': 'cached', 'has_summary': True, 'has_figures': True, 'figures_count': len(cached_figures)}, ensure_ascii=False)}\n\n"
                continue

            try:
                doi = meta.doi
                if not doi and meta.semantic_scholar_url and "doi.org/" in meta.semantic_scholar_url:
                    doi = meta.semantic_scholar_url

                figure_urls: list[str] = cached_figures or []
                md_text = ""
                if not has_figures or not has_summary:
                    processed = await pdf_processor.process_pdf(meta.pdf_url, pid, doi)
                    md_text = processed.markdown_text
                    if not has_figures:
                        figure_urls = processed.figure_paths
                        if not figure_urls and doi:
                            try:
                                figure_urls = await pdf_processor.fetch_thumbnail(pid, doi)
                            except Exception:
                                pass
                        if figure_urls:
                            storage.save_figure_urls(pid, figure_urls)

                if not has_summary:
                    if md_text:
                        full_text = ""
                        async for chunk in summarizer.stream_quick_summary(meta, md_text):
                            full_text += chunk
                        parsed = summarizer.parse_tier1_response(full_text)
                        storage.save_summary(pid, parsed)
                        has_summary = True
                    elif meta.abstract:
                        full_text = ""
                        async for chunk in summarizer.stream_quick_summary(meta, meta.abstract):
                            full_text += chunk
                        parsed = summarizer.parse_tier1_response(full_text)
                        storage.save_summary(pid, parsed)
                        has_summary = True

                has_figures = bool(figure_urls)
                if not has_figures:
                    missing_figures.append({"paper_id": pid, "title": paper_title})

                yield f"data: {json.dumps({'type': 'progress', 'current': idx + 1, 'total': total, 'paper_id': pid, 'title': paper_title, 'status': 'built', 'has_summary': has_summary, 'has_figures': has_figures, 'figures_count': len(figure_urls)}, ensure_ascii=False)}\n\n"

            except Exception as e:
                logger.exception(f"Prebuild failed for {pid}")
                errors.append({"paper_id": pid, "title": paper_title, "error": str(e)})
                yield f"data: {json.dumps({'type': 'progress', 'current': idx + 1, 'total': total, 'paper_id': pid, 'title': paper_title, 'status': 'error', 'error': str(e)}, ensure_ascii=False)}\n\n"

        for venue_name, pids in venue_papers.items():
            storage.save_deck(venue_name, req.year, pids)

        yield f"data: {json.dumps({'type': 'done', 'total': total, 'missing_figures': missing_figures, 'errors': errors, 'decks_saved': list(venue_papers.keys())}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.get("/api/admin/card-status")
async def admin_card_status(request: Request, venues: str = "", year: int = 2024):
    """Return cache status for all papers matching the given venues/year."""
    auth_service.require_admin(request)
    venue_list = [v.strip() for v in venues.split(",") if v.strip()]
    results = []

    for pid, meta in _papers_cache.items():
        if venue_list and (meta.venue or "") not in venue_list:
            continue
        if meta.year and meta.year != year:
            continue

        cached_summary = storage.load_summary(pid)
        cached_figures = storage.load_figure_urls(pid)
        has_summary = bool(cached_summary and any(v for v in cached_summary.values()))
        has_figures = bool(cached_figures)

        results.append({
            "paper_id": pid,
            "title": meta.title,
            "venue": meta.venue,
            "year": meta.year,
            "has_summary": has_summary,
            "has_figures": has_figures,
            "figures_count": len(cached_figures) if cached_figures else 0,
            "figure_urls": cached_figures or [],
        })

    return {"papers": results, "total": len(results)}


@app.post("/api/admin/figures/{paper_id:path}")
async def admin_upload_figure(paper_id: str, request: Request, file: UploadFile = FastAPIFile(...)):
    """Manually upload a figure for a paper that is missing one."""
    auth_service.require_admin(request)
    if paper_id not in _papers_cache:
        raise HTTPException(404, "Paper not in cache")

    content_type = file.content_type or ""
    if not content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")

    img_bytes = await file.read()
    ext = content_type.split("/")[-1].replace("jpeg", "jpg")
    filename = f"manual_0.{ext}"
    url = await pdf_processor._save_figure_bytes(img_bytes, paper_id, filename)

    existing = storage.load_figure_urls(paper_id) or []
    existing.append(url)
    storage.save_figure_urls(paper_id, existing)

    return {"status": "ok", "url": url, "figures_count": len(existing)}


@app.post("/api/admin/sessions/cleanup")
async def admin_cleanup_sessions(request: Request):
    """Manually trigger expired-session cleanup (file storage only)."""
    auth_service.require_admin(request)
    removed = storage.cleanup_expired_sessions()
    return {"status": "ok", "removed": removed}


# ---------------------------------------------------------------------------
# Admin: cache inspection
# ---------------------------------------------------------------------------

@app.get("/api/admin/cache/stats")
async def admin_cache_stats(request: Request):
    """Aggregate counts/sizes across every cache layer."""
    auth_service.require_admin(request)
    return storage.cache_stats()


@app.get("/api/admin/cache/papers")
async def admin_cache_papers(
    request: Request,
    has_summary: bool | None = None,
    has_figures: bool | None = None,
    has_metadata: bool | None = None,
    venue: str | None = None,
    year: int | None = None,
    search: str | None = None,
    offset: int = 0,
    limit: int = 50,
):
    """Paginated list of cached papers with per-paper status flags.

    The union of paper_ids comes from summaries cache + figures cache +
    papers metadata cache, so admins can also see "orphan" entries that
    don't belong to any deck.
    """
    auth_service.require_admin(request)

    summary_ids = set(storage.list_cached_summary_ids())
    figure_ids = set(storage.list_cached_figure_ids())
    metadata_cache = storage.load_papers_cache_raw()
    metadata_ids = set(metadata_cache.keys())
    deck_ids: set[str] = set()
    for d in storage.load_all_decks():
        deck_ids.update(d.get("paper_ids") or [])

    all_ids = summary_ids | figure_ids | metadata_ids
    needle = (search or "").strip().lower()

    rows = []
    for pid in all_ids:
        meta = metadata_cache.get(pid) or {}
        title = meta.get("title") or ""
        v = meta.get("venue") or ""
        y = meta.get("year")

        if has_summary is True and pid not in summary_ids:
            continue
        if has_summary is False and pid in summary_ids:
            continue
        if has_figures is True and pid not in figure_ids:
            continue
        if has_figures is False and pid in figure_ids:
            continue
        if has_metadata is True and pid not in metadata_ids:
            continue
        if has_metadata is False and pid in metadata_ids:
            continue
        if venue and v != venue:
            continue
        if year is not None and y != year:
            continue
        if needle and needle not in title.lower() and needle not in pid.lower():
            continue

        # Cheap empty-summary check: load only when needed.
        summary_empty = None
        if pid in summary_ids:
            s = storage.load_summary(pid) or {}
            summary_empty = not any((v_ or "").strip() for v_ in s.values())

        rows.append({
            "paper_id": pid,
            "title": title,
            "venue": v,
            "year": y,
            "has_summary": pid in summary_ids,
            "summary_empty": summary_empty,
            "has_figures": pid in figure_ids,
            "has_metadata": pid in metadata_ids,
            "in_deck": pid in deck_ids,
        })

    rows.sort(key=lambda r: (r["venue"] or "", -(r["year"] or 0), r["title"]))
    total = len(rows)
    sliced = rows[offset : offset + limit] if limit > 0 else rows
    return {"papers": sliced, "total": total, "offset": offset, "limit": limit}


@app.get("/api/admin/cache/papers/{paper_id:path}")
async def admin_cache_paper_detail(paper_id: str, request: Request):
    """Full cache contents for a single paper."""
    auth_service.require_admin(request)
    metadata_cache = storage.load_papers_cache_raw()
    meta = metadata_cache.get(paper_id)
    summary = storage.load_summary(paper_id)
    figure_urls = storage.load_figure_urls(paper_id) or []
    pdf_info = storage.get_pdf_cache_info(paper_id)

    return {
        "paper_id": paper_id,
        "metadata": meta,
        "summary": summary,
        "summary_empty": (
            not any((v or "").strip() for v in (summary or {}).values())
            if summary is not None else None
        ),
        "figure_urls": figure_urls,
        "pdf_cache": pdf_info,
    }


@app.delete("/api/admin/cache/papers/{paper_id:path}")
async def admin_cache_delete_paper(
    paper_id: str,
    request: Request,
    drop_summary: bool = True,
    drop_figures: bool = True,
    drop_pdf: bool = True,
):
    """Drop all cache entries for a paper. Useful for forcing a regen."""
    auth_service.require_admin(request)
    actions: dict[str, bool] = {}

    if drop_summary:
        storage.delete_summary(paper_id)
        actions["summary_dropped"] = True

    if drop_figures:
        urls = storage.load_figure_urls(paper_id) or []
        for u in urls:
            await _best_effort_delete_figure_file(u)
        storage.delete_figure_urls(paper_id)
        actions["figures_dropped"] = len(urls)

    if drop_pdf:
        actions["pdf_dropped"] = storage.delete_pdf_cache(paper_id)

    return {"status": "ok", **actions}


@app.post("/api/admin/cache/cleanup-empty-summaries")
async def admin_cleanup_empty_summaries(request: Request):
    """Sweep summaries cache for entries with all-blank values and remove them."""
    auth_service.require_admin(request)
    removed = []
    for pid in storage.list_cached_summary_ids():
        s = storage.load_summary(pid) or {}
        if not any((v or "").strip() for v in s.values()):
            storage.delete_summary(pid)
            removed.append(pid)
    return {"status": "ok", "removed": removed, "count": len(removed)}


@app.post("/api/admin/cache/wipe")
async def admin_wipe_cache(
    request: Request,
    confirm: str | None = None,
    drop_summaries: bool = True,
    drop_figures: bool = True,
    drop_pdfs: bool = True,
    drop_decks: bool = False,
    drop_metadata: bool = False,
):
    """Bulk-delete cached cards. Requires ``confirm=DELETE`` query param.

    By default removes summaries + figures + PDFs (the GPT/PDF generated
    output). Decks and the papers metadata cache are preserved unless
    explicitly opted-in, since rebuilding the metadata requires re-hitting
    OpenAlex.
    """
    auth_service.require_admin(request)
    if confirm != "DELETE":
        raise HTTPException(
            400,
            "Refusing to wipe without explicit confirm=DELETE query param",
        )

    counters = {
        "summaries_deleted": 0,
        "figures_deleted": 0,
        "figure_files_deleted": 0,
        "pdfs_deleted": 0,
        "decks_deleted": 0,
        "metadata_cleared": False,
    }

    if drop_summaries:
        for pid in storage.list_cached_summary_ids():
            storage.delete_summary(pid)
            counters["summaries_deleted"] += 1

    if drop_figures:
        for pid in storage.list_cached_figure_ids():
            urls = storage.load_figure_urls(pid) or []
            for u in urls:
                await _best_effort_delete_figure_file(u)
                counters["figure_files_deleted"] += 1
            storage.delete_figure_urls(pid)
            counters["figures_deleted"] += 1

    if drop_pdfs:
        # Local-only: iterate the pdf_cache directory.
        if not storage.is_vercel():
            from pathlib import Path
            pdf_dir = Path("data/pdf_cache")
            if pdf_dir.exists():
                for p in pdf_dir.glob("*.pdf"):
                    try:
                        p.unlink()
                        counters["pdfs_deleted"] += 1
                    except Exception:
                        pass

    if drop_decks:
        for d in storage.load_all_decks():
            v = d.get("venue")
            y = d.get("year")
            if v and y:
                storage.delete_deck(v, y)
                counters["decks_deleted"] += 1

    if drop_metadata:
        # Wipe the papers_cache (metadata) — requires re-search to rehydrate.
        storage.save_papers_cache_raw({})
        _papers_cache.clear()
        counters["metadata_cleared"] = True

    return {"status": "ok", **counters}


# ---------------------------------------------------------------------------
# Admin: card editing
# ---------------------------------------------------------------------------

async def _best_effort_delete_figure_file(url: str) -> None:
    """Remove the underlying figure file from Blob or local disk. Best-effort."""
    if not url:
        return
    if url.startswith("http"):
        await storage.delete_blob_by_url(url)
    else:
        storage.delete_local_figure_by_url(url)


@app.delete("/api/admin/figures/{paper_id:path}/{index}")
async def admin_delete_figure(paper_id: str, index: int, request: Request):
    """Delete a single figure at the given index from a paper."""
    auth_service.require_admin(request)
    urls = storage.load_figure_urls(paper_id) or []
    if index < 0 or index >= len(urls):
        raise HTTPException(400, "index out of range")
    removed_url = urls.pop(index)
    if urls:
        storage.save_figure_urls(paper_id, urls)
    else:
        storage.delete_figure_urls(paper_id)
    await _best_effort_delete_figure_file(removed_url)
    return {"status": "ok", "figure_urls": urls}


@app.put("/api/admin/figures/{paper_id:path}/reorder")
async def admin_reorder_figures(paper_id: str, body: dict, request: Request):
    """Reorder figure list. Body: {"order": [2, 0, 1]} reorders by index."""
    auth_service.require_admin(request)
    order = body.get("order")
    urls = storage.load_figure_urls(paper_id) or []
    if not isinstance(order, list) or sorted(order) != list(range(len(urls))):
        raise HTTPException(400, "order must be a permutation of [0..len(figures)-1]")
    new_urls = [urls[i] for i in order]
    storage.save_figure_urls(paper_id, new_urls)
    return {"status": "ok", "figure_urls": new_urls}


@app.put("/api/admin/figures/{paper_id:path}/{index}")
async def admin_replace_figure(
    paper_id: str,
    index: int,
    request: Request,
    file: UploadFile = FastAPIFile(...),
):
    """Replace the figure at ``index`` with an uploaded image."""
    auth_service.require_admin(request)
    urls = storage.load_figure_urls(paper_id) or []
    if index < 0 or index >= len(urls):
        raise HTTPException(400, "index out of range")

    content_type = file.content_type or ""
    if not content_type.startswith("image/"):
        raise HTTPException(400, "File must be an image")

    img_bytes = await file.read()
    ext = content_type.split("/")[-1].replace("jpeg", "jpg")
    # Bump a counter suffix so Blob/file URL changes and CDN caches refresh.
    import time as _time
    filename = f"manual_{index}_{int(_time.time())}.{ext}"
    new_url = await pdf_processor._save_figure_bytes(img_bytes, paper_id, filename)

    old_url = urls[index]
    urls[index] = new_url
    storage.save_figure_urls(paper_id, urls)
    await _best_effort_delete_figure_file(old_url)
    return {"status": "ok", "url": new_url, "figure_urls": urls}


@app.put("/api/admin/summary/{paper_id:path}")
async def admin_update_summary(paper_id: str, body: dict, request: Request):
    """Overwrite the stored summary for a paper.

    Body shape: {"summary": {"claim": "...", "what": "...", ...}}. Only string
    fields are accepted. Passing an empty string clears a field.
    """
    auth_service.require_admin(request)
    incoming = body.get("summary")
    if not isinstance(incoming, dict):
        raise HTTPException(400, "summary must be an object")
    cleaned = {str(k): str(v) for k, v in incoming.items() if isinstance(v, (str, int, float))}
    storage.save_summary(paper_id, cleaned)
    return {"status": "ok", "summary": cleaned}


@app.post("/api/admin/rebuild/{paper_id:path}")
async def admin_rebuild_paper(paper_id: str, request: Request, body: dict = None):
    """Re-run summary (and optionally figures) for a single paper.

    Body: {"figures": bool, "summary": bool} — which parts to rebuild.
    Defaults to both.
    """
    auth_service.require_admin(request)
    body = body or {}
    rebuild_figs = bool(body.get("figures", True))
    rebuild_sum = bool(body.get("summary", True))

    meta = _papers_cache.get(paper_id)
    if not meta:
        raise HTTPException(404, "Paper not in cache")

    doi = meta.doi
    if not doi and meta.semantic_scholar_url and "doi.org/" in meta.semantic_scholar_url:
        doi = meta.semantic_scholar_url

    md_text = ""
    figure_urls: list[str] = []
    if rebuild_figs or rebuild_sum:
        processed = await pdf_processor.process_pdf(meta.pdf_url, paper_id, doi)
        md_text = processed.markdown_text
        figure_urls = processed.figure_paths

    if rebuild_figs:
        # Drop old figures first so the card shows only the fresh set.
        old_urls = storage.load_figure_urls(paper_id) or []
        for u in old_urls:
            await _best_effort_delete_figure_file(u)
        storage.delete_figure_urls(paper_id)

        if not figure_urls and doi:
            try:
                figure_urls = await pdf_processor.fetch_thumbnail(paper_id, doi)
            except Exception:
                figure_urls = []
        if figure_urls:
            storage.save_figure_urls(paper_id, figure_urls)

    parsed = None
    if rebuild_sum:
        source_text = md_text or (meta.abstract or "")
        if not source_text:
            raise HTTPException(400, "No source text available for summary")
        full_text = ""
        async for chunk in summarizer.stream_quick_summary(meta, source_text):
            full_text += chunk
        parsed = summarizer.parse_tier1_response(full_text)
        storage.save_summary(paper_id, parsed)

    return {
        "status": "ok",
        "figure_urls": storage.load_figure_urls(paper_id) or [],
        "summary": parsed if parsed is not None else storage.load_summary(paper_id),
    }


# ---------------------------------------------------------------------------
# Rate limit introspection
# ---------------------------------------------------------------------------

@app.get("/api/usage")
async def get_usage(request: Request):
    """Return today's summary-generation usage for the caller."""
    user = auth_service.get_current_user(request)
    scope, limit = _rate_limit_scope(request, user)
    used = rate_limit.peek(scope)
    return {
        "scope_kind": "user" if user else "anon",
        "used": used,
        "limit": limit,  # 0 means unlimited
        "remaining": None if limit == 0 else max(0, limit - used),
    }


# ---------------------------------------------------------------------------
# Auth (Google Sign-In)
# ---------------------------------------------------------------------------

@app.get("/api/auth/config")
async def auth_config():
    """Tell the frontend whether Google login is available and with which client id."""
    return {
        "enabled": auth_service.is_configured(),
        "client_id": os.environ.get("GOOGLE_CLIENT_ID", "") if auth_service.is_configured() else "",
    }


@app.post("/api/auth/google")
async def auth_google(body: dict, response: Response):
    credential = body.get("credential") or body.get("id_token")
    if not credential:
        raise HTTPException(400, "credential required")

    result = auth_service.login_with_google(credential)
    if not result:
        raise HTTPException(401, "Google authentication failed")

    user, session_id = result
    response.set_cookie(
        key=auth_service.SESSION_COOKIE,
        value=session_id,
        max_age=auth_service.SESSION_TTL_SECONDS,
        httponly=True,
        samesite="lax",
        secure=storage.is_vercel(),
    )
    user_out = dict(user)
    user_out["is_admin"] = auth_service.is_admin(user)
    return {"status": "ok", "user": user_out}


@app.get("/api/auth/me")
async def auth_me(request: Request):
    user = auth_service.get_current_user(request)
    if not user:
        return {"user": None}
    # Expose role so the frontend can show admin UI conditionally.
    user_out = dict(user)
    user_out["is_admin"] = auth_service.is_admin(user)
    return {"user": user_out}


@app.post("/api/auth/logout")
async def auth_logout(request: Request, response: Response):
    auth_service.logout(request)
    response.delete_cookie(auth_service.SESSION_COOKIE)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Venues + user preferences
# ---------------------------------------------------------------------------

@app.get("/api/venues")
async def list_available_venues():
    """Return all venues the backend can search, with grouping info."""
    return {
        "venues": venues_service.list_venues(),
        "groups": venues_service.GROUP_ORDER,
        "defaults": venues_service.default_preferences(),
    }


@app.get("/api/user/preferences")
async def get_user_preferences(request: Request):
    user = auth_service.get_current_user(request)
    if not user:
        return {
            "authenticated": False,
            "venue_preferences": venues_service.default_preferences(),
        }
    prefs = storage.load_user_preferences(user["google_id"]) or {}
    return {
        "authenticated": True,
        "venue_preferences": prefs.get("venue_preferences", venues_service.default_preferences()),
    }


@app.put("/api/user/preferences")
async def update_user_preferences(request: Request, body: dict):
    user = auth_service.get_current_user(request)
    if not user:
        raise HTTPException(401, "Login required")
    prefs_in = body.get("venue_preferences")
    if not isinstance(prefs_in, list):
        raise HTTPException(400, "venue_preferences must be a list")

    valid = set(venues_service.all_venue_names())
    cleaned = [v for v in prefs_in if isinstance(v, str) and v in valid]

    storage.save_user_preferences(user["google_id"], {"venue_preferences": cleaned})
    return {"status": "ok", "venue_preferences": cleaned}


# ---------------------------------------------------------------------------
# Static Files — only in local development (not on Vercel)
# ---------------------------------------------------------------------------

if not storage.is_vercel():
    FIGURES_DIR = Path("data/figures")
    if FIGURES_DIR.exists():
        app.mount("/figures", StaticFiles(directory=str(FIGURES_DIR)), name="figures")

    FRONTEND_DIST = Path("frontend/dist")
    FRONTEND_ASSETS = FRONTEND_DIST / "assets"

    if FRONTEND_ASSETS.exists():
        app.mount("/assets", StaticFiles(directory=str(FRONTEND_ASSETS)), name="static-assets")

    @app.get("/{full_path:path}")
    async def serve_spa(request: Request, full_path: str):
        file_path = FRONTEND_DIST / full_path
        if full_path and file_path.is_file():
            return FileResponse(file_path)
        index = FRONTEND_DIST / "index.html"
        if index.exists():
            return FileResponse(index)
        return {"error": "Frontend not built"}
