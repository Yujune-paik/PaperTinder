from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

import yaml
from fastapi import FastAPI, HTTPException, Request, UploadFile, File as FastAPIFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from src.models import PaperMeta, ProgressData, ReadingListItem, SearchRequest
from src.services import pdf_processor, semantic_scholar, summarizer
from src.services import storage
from src.services import scrapbox as scrapbox_exporter
from src.services import notebooklm as notebooklm_service

SSE_HEADERS = {
    "Cache-Control": "no-cache",
    "X-Accel-Buffering": "no",
    "Connection": "keep-alive",
}

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="PaperTinder", version="0.1.0")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
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


def _load_reading_list() -> list[ReadingListItem]:
    data = storage.load_reading_list_raw()
    return [ReadingListItem(**item) for item in data]


def _save_reading_list(items: list[ReadingListItem]):
    storage.save_reading_list_raw([item.model_dump() for item in items])


def _load_progress(venue: str, year: int) -> ProgressData:
    data = storage.load_progress_raw(venue, year)
    if data:
        return ProgressData(**data)
    return ProgressData(venue=venue, year=year)


def _save_progress(progress: ProgressData):
    storage.save_progress_raw(progress.model_dump(), progress.venue, progress.year)


def _summary_event_stream(meta: PaperMeta):
    """Shared SSE generator for summary streaming."""

    async def _gen():
        yield f"data: {json.dumps({'type': 'connected'})}\n\n"
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
            storage.save_summary(meta.paper_id, parsed)
            yield f"data: {json.dumps({'type': 'summary', 'data': parsed})}\n\n"
            yield f"data: {json.dumps({'type': 'done'})}\n\n"
            logger.info(f"[stream] Done: {meta.paper_id}")
        except Exception as e:
            logger.exception(f"Summary stream error for {meta.paper_id}")
            yield f"data: {json.dumps({'type': 'error', 'message': str(e)})}\n\n"

    return _gen()


# ---------------------------------------------------------------------------
# Paper Search (streaming)
# ---------------------------------------------------------------------------

@app.post("/api/papers/stream")
async def stream_search_papers(req: SearchRequest):
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
                _save_papers_cache()

            if event["type"] == "venue_done":
                venue = event["venue"]
                prog = _load_progress(venue, req.year)
                prog.total = max(prog.total, event["venue_count"])
                _save_progress(prog)

            yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)


# ---------------------------------------------------------------------------
# Summary SSE
# ---------------------------------------------------------------------------

@app.get("/api/stream/{paper_id:path}")
async def stream_summary(paper_id: str):
    meta = _papers_cache.get(paper_id)
    if not meta:
        raise HTTPException(404, "Paper not in cache")
    return StreamingResponse(_summary_event_stream(meta), media_type="text/event-stream", headers=SSE_HEADERS)


@app.post("/api/stream-inline")
async def stream_summary_inline(body: dict):
    try:
        meta = PaperMeta(**body)
    except Exception:
        raise HTTPException(400, "Invalid paper metadata")
    _papers_cache[meta.paper_id] = meta
    _save_papers_cache()
    return StreamingResponse(_summary_event_stream(meta), media_type="text/event-stream", headers=SSE_HEADERS)


# ---------------------------------------------------------------------------
# Deep Summary SSE
# ---------------------------------------------------------------------------

@app.get("/api/stream-deep/{paper_id:path}")
async def stream_deep_summary(paper_id: str):
    meta = _papers_cache.get(paper_id)
    if not meta:
        raise HTTPException(404, "Paper not in cache")

    reading_list = _load_reading_list()
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
async def get_reading_list():
    return {"items": [item.model_dump() for item in _load_reading_list()]}


@app.post("/api/reading-list")
async def add_to_reading_list(item: ReadingListItem):
    items = _load_reading_list()
    if any(i.paper_id == item.paper_id for i in items):
        return {"status": "already_exists"}
    item.saved_at = datetime.now(timezone.utc).isoformat()
    items.append(item)
    _save_reading_list(items)
    return {"status": "saved"}


@app.delete("/api/reading-list/{paper_id:path}")
async def remove_from_reading_list(paper_id: str):
    items = _load_reading_list()
    items = [i for i in items if i.paper_id != paper_id]
    _save_reading_list(items)
    return {"status": "removed"}


# ---------------------------------------------------------------------------
# Progress
# ---------------------------------------------------------------------------

@app.get("/api/progress")
async def get_all_progress():
    return {"progress": storage.load_all_progress_raw()}


@app.get("/api/progress/{venue}/{year}")
async def get_progress(venue: str, year: int):
    return _load_progress(venue, year).model_dump()


@app.post("/api/progress/{venue}/{year}/seen")
async def mark_seen(venue: str, year: int, body: dict):
    paper_id = body.get("paper_id")
    if not paper_id:
        raise HTTPException(400, "paper_id required")
    prog = _load_progress(venue, year)
    if paper_id not in prog.seen:
        prog.seen.append(paper_id)
    _save_progress(prog)
    return {"status": "ok", "seen_count": len(prog.seen)}


@app.post("/api/progress/{venue}/{year}/saved")
async def mark_saved(venue: str, year: int, body: dict):
    paper_id = body.get("paper_id")
    if not paper_id:
        raise HTTPException(400, "paper_id required")
    prog = _load_progress(venue, year)
    if paper_id not in prog.saved:
        prog.saved.append(paper_id)
    _save_progress(prog)
    return {"status": "ok"}


# ---------------------------------------------------------------------------
# Export helpers
# ---------------------------------------------------------------------------

def _collect_export_data() -> tuple[str, list[dict], dict[str, dict], dict[str, list[str]]]:
    """Gather papers + summaries + figures for export."""
    items = _load_reading_list()
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
async def export_scrapbox():
    """Generate Scrapbox import JSON (clipboard copy fallback)."""
    items = _load_reading_list()
    if not items:
        return {"text": "保存した論文がありません。", "pages": []}

    date_str, papers, summaries_map, figures_map = _collect_export_data()
    page = scrapbox_exporter.build_daily_page(date_str, papers, summaries_map, figures_map)

    text = "\n".join(page["lines"])
    return {"text": text, "pages": [page]}


@app.post("/api/export/scrapbox/push")
async def push_scrapbox():
    """Push the daily summary page directly to Scrapbox via import API."""
    items = _load_reading_list()
    if not items:
        return {"status": "error", "message": "保存した論文がありません。"}

    if not scrapbox_exporter.is_configured():
        return {"status": "error", "message": "Scrapbox未設定: SCRAPBOX_SID と SCRAPBOX_PROJECT を設定してください。"}

    try:
        date_str, papers, summaries_map, figures_map = _collect_export_data()
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
async def export_notebooklm_doc():
    """Generate a Markdown document optimised for NotebookLM ingestion."""
    items = _load_reading_list()
    if not items:
        return {"text": "保存した論文がありません。", "title": ""}

    date_str, papers, summaries_map, _figures_map = _collect_export_data()
    title = f"論文セッション {date_str}"
    text = notebooklm_service.build_session_document(date_str, papers, summaries_map)
    return {"text": text, "title": title}


# ---------------------------------------------------------------------------
# Admin: pre-build cards
# ---------------------------------------------------------------------------

@app.post("/api/admin/prebuild")
async def admin_prebuild(req: SearchRequest):
    """Search papers then pre-generate summaries + figures for every card.

    Streams SSE progress so the admin page can show a live dashboard.
    """
    async def event_stream():
        # Phase 1: search papers
        yield f"data: {json.dumps({'type': 'phase', 'phase': 'search'}, ensure_ascii=False)}\n\n"

        all_papers: list[PaperMeta] = []
        async for event in semantic_scholar.stream_search_venues(
            venues=req.venues, year=req.year,
            keyword=req.keyword, limit_per_venue=req.limit,
        ):
            if event["type"] == "papers":
                for p_data in event["papers"]:
                    meta = PaperMeta(**p_data)
                    _papers_cache[meta.paper_id] = meta
                    all_papers.append(meta)
                _save_papers_cache()
            if event["type"] == "venue_done":
                yield f"data: {json.dumps({'type': 'venue_done', 'venue': event['venue'], 'count': event.get('venue_count', 0)}, ensure_ascii=False)}\n\n"

        total = len(all_papers)
        yield f"data: {json.dumps({'type': 'phase', 'phase': 'build', 'total': total}, ensure_ascii=False)}\n\n"

        # Phase 2: process each paper
        missing_figures: list[dict] = []
        errors: list[dict] = []

        for idx, meta in enumerate(all_papers):
            pid = meta.paper_id
            paper_title = meta.title or "Untitled"

            # skip if both summary and figures are already cached
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

                # Process PDF → figures + text
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

                # Generate summary
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

        yield f"data: {json.dumps({'type': 'done', 'total': total, 'missing_figures': missing_figures, 'errors': errors}, ensure_ascii=False)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream", headers=SSE_HEADERS)


@app.get("/api/admin/card-status")
async def admin_card_status(venues: str = "", year: int = 2024):
    """Return cache status for all papers matching the given venues/year."""
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
async def admin_upload_figure(paper_id: str, file: UploadFile = FastAPIFile(...)):
    """Manually upload a figure for a paper that is missing one."""
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
