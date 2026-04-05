from __future__ import annotations

import json
import logging
import os
from datetime import datetime, timezone
from pathlib import Path

from dotenv import load_dotenv

load_dotenv()

import yaml
from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from src.models import PaperMeta, ProgressData, ReadingListItem, SearchRequest
from src.services import pdf_processor, semantic_scholar, summarizer
from src.services import storage

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
        try:
            doi = meta.doi
            if not doi and meta.semantic_scholar_url and "semanticscholar.org/paper/" in meta.semantic_scholar_url:
                doi_suffix = meta.semantic_scholar_url.split("semanticscholar.org/paper/")[-1]
                if doi_suffix and "/" in doi_suffix:
                    doi = f"https://doi.org/{doi_suffix}"

            logger.info(f"[stream] Start: {meta.paper_id} pdf_url={bool(meta.pdf_url)} doi={bool(doi)}")

            processed = await pdf_processor.process_pdf(meta.pdf_url, meta.paper_id, doi)
            figure_urls = processed.figure_paths
            md_text = processed.markdown_text
            logger.info(f"[stream] PDF done: figures={len(figure_urls)} md_len={len(md_text)}")

            if not figure_urls and doi:
                logger.info(f"[stream] Trying DOI thumbnail for {meta.paper_id}")
                figure_urls = await pdf_processor.fetch_thumbnail(meta.paper_id, doi)

            if figure_urls:
                yield f"data: {json.dumps({'type': 'figures', 'urls': figure_urls})}\n\n"

            logger.info(f"[stream] Starting OpenAI summary for {meta.paper_id}")
            full_text = ""
            async for chunk in summarizer.stream_quick_summary(meta, md_text):
                full_text += chunk
                yield f"data: {json.dumps({'type': 'chunk', 'text': chunk})}\n\n"

            parsed = summarizer.parse_tier1_response(full_text)
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

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ---------------------------------------------------------------------------
# Summary SSE
# ---------------------------------------------------------------------------

@app.get("/api/stream/{paper_id:path}")
async def stream_summary(paper_id: str):
    meta = _papers_cache.get(paper_id)
    if not meta:
        raise HTTPException(404, "Paper not in cache")
    return StreamingResponse(_summary_event_stream(meta), media_type="text/event-stream")


@app.post("/api/stream-inline")
async def stream_summary_inline(body: dict):
    try:
        meta = PaperMeta(**body)
    except Exception:
        raise HTTPException(400, "Invalid paper metadata")
    _papers_cache[meta.paper_id] = meta
    _save_papers_cache()
    return StreamingResponse(_summary_event_stream(meta), media_type="text/event-stream")


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

    return StreamingResponse(event_stream(), media_type="text/event-stream")


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
# Scrapbox Export
# ---------------------------------------------------------------------------

@app.get("/api/export/scrapbox")
async def export_scrapbox():
    items = _load_reading_list()
    if not items:
        return {"text": "保存した論文がありません。"}

    now = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    venues = list(set(item.venue or "Unknown" for item in items))
    venue_tags = "".join(f"[{v}]" for v in venues)

    session_page = f"[論文セッション {now} {venue_tags}]\n"
    session_page += "#paper-tinder #session\n\n"
    session_page += f"今日スワイプ: {len(items)}本保存\n\n"
    for item in items:
        session_page += f" [{item.title}]\n"

    paper_pages = []
    for item in items:
        meta = _papers_cache.get(item.paper_id)
        venue_tag = (item.venue or "Unknown").replace(" ", "")
        year_str = str(item.year) if item.year else ""
        page = f"[{item.title}]\n"
        page += f"#paper #{venue_tag}{year_str} #paper-tinder\n\n"

        if meta:
            page += f"[* 論文情報]\n"
            page += f"著者: {', '.join(meta.authors[:5])}\n"
            page += f"リンク: [{meta.paper_id} {meta.semantic_scholar_url}]\n"
            page += f"公開年: {meta.year or 'N/A'}\n"
        else:
            page += f"Paper ID: {item.paper_id}\n"

        paper_pages.append(page)

    full_export = session_page + "\n\n---\n\n" + "\n\n---\n\n".join(paper_pages)
    return {"text": full_export}


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
