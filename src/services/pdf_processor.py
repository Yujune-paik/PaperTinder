from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

import httpx

from src.models import ProcessedPDF
from src.services import storage

logger = logging.getLogger(__name__)

# ── pdfminer.six (pure-Python, works on Vercel) ───────────────────────
_HAS_PDFMINER = False
try:
    from pdfminer.high_level import extract_text as _pdfminer_extract  # type: ignore[import-untyped]
    _HAS_PDFMINER = True
except ImportError:
    logger.info("pdfminer.six not available")

# ── MarkItDown (optional, heavier — local-only) ───────────────────────
_HAS_MARKITDOWN = False
try:
    from markitdown import MarkItDown  # type: ignore[import-untyped]
    _HAS_MARKITDOWN = True
except ImportError:
    logger.info("markitdown not available — will try pdfminer/PyMuPDF fallback")

# ── pypdfium2 (pre-built wheel, works on Vercel — page rendering) ─────
_HAS_PDFIUM = False
try:
    import pypdfium2 as pdfium  # type: ignore[import-untyped]
    _HAS_PDFIUM = True
except ImportError:
    logger.info("pypdfium2 not available — PDF page rendering disabled")

# ── PyMuPDF (C binary, local-only — used for figure extraction) ────────
_HAS_PYMUPDF = False
try:
    import fitz  # type: ignore[import-untyped]
    import pymupdf4llm  # type: ignore[import-untyped]
    _HAS_PYMUPDF = True
except ImportError:
    logger.info("PyMuPDF not available — figure extraction disabled")

MIN_FIGURE_SIZE = 200
MAX_TEXT_CHARS = 60000
PDF_PROCESS_TIMEOUT = 50


def _safe_id(paper_id: str) -> str:
    return re.sub(r'[\\/:*?"<>|]', "_", paper_id)


_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)
UNPAYWALL_EMAIL = "papertinder@example.com"


# ── PDF Download ───────────────────────────────────────────────────────

async def _download_from_url(client: httpx.AsyncClient, url: str, pdf_path: Path) -> bool:
    try:
        resp = await client.get(url)
        resp.raise_for_status()

        content_type = resp.headers.get("content-type", "")
        if "html" in content_type or "text" in content_type:
            logger.warning(f"PDF URL returned HTML ({content_type}): {url}")
            return False

        data = resp.content
        if len(data) < 1000 or not data[:5].startswith(b"%PDF"):
            logger.warning(f"Not a valid PDF ({len(data)} bytes): {url}")
            return False

        pdf_path.write_bytes(data)
        return True
    except Exception:
        logger.warning(f"PDF download failed: {url}")
        return False


async def _get_s2_oa_url(client: httpx.AsyncClient, doi: str | None) -> str | None:
    if not doi:
        return None
    doi_bare = doi.replace("https://doi.org/", "").replace("http://doi.org/", "")
    try:
        resp = await client.get(
            f"https://api.semanticscholar.org/graph/v1/paper/DOI:{doi_bare}",
            params={"fields": "openAccessPdf"},
        )
        if resp.status_code != 200:
            return None
        data = resp.json()
        oa = data.get("openAccessPdf") or {}
        return oa.get("url")
    except Exception:
        return None


async def download_pdf(url: str | None, paper_id: str, doi: str | None = None) -> Path | None:
    """Download a PDF. Works with pdfminer, MarkItDown, pypdfium2, or PyMuPDF."""
    if not (_HAS_PDFMINER or _HAS_MARKITDOWN or _HAS_PDFIUM or _HAS_PYMUPDF):
        return None

    cache_dir = storage.get_pdf_cache_dir()
    sid = _safe_id(paper_id)
    pdf_path = cache_dir / f"{sid}.pdf"

    if pdf_path.exists():
        if pdf_path.stat().st_size > 1000:
            return pdf_path
        pdf_path.unlink(missing_ok=True)

    async with httpx.AsyncClient(follow_redirects=True, timeout=30.0, headers={"User-Agent": _BROWSER_UA}) as client:
        if url and await _download_from_url(client, url, pdf_path):
            return pdf_path

        s2_url = await _get_s2_oa_url(client, doi)
        if s2_url and s2_url != url:
            logger.info(f"Trying S2 open access URL: {s2_url}")
            if await _download_from_url(client, s2_url, pdf_path):
                return pdf_path

    return None


# ── Text Extraction ────────────────────────────────────────────────────

def _extract_markdown_markitdown(pdf_path: Path, max_chars: int = MAX_TEXT_CHARS) -> str:
    """Extract markdown using MarkItDown (pure Python, works on Vercel)."""
    try:
        converter = MarkItDown(enable_plugins=False)
        result = converter.convert(str(pdf_path))
        md = result.text_content or ""
        if len(md) > max_chars:
            md = md[:max_chars] + "\n\n[... truncated ...]"
        return md
    except Exception:
        logger.exception("MarkItDown conversion failed")
        return ""


def _extract_markdown_pymupdf(pdf_path: Path, max_chars: int = MAX_TEXT_CHARS) -> str:
    """Extract markdown using PyMuPDF (fallback, needs C binary)."""
    try:
        md = pymupdf4llm.to_markdown(str(pdf_path))
        if len(md) > max_chars:
            md = md[:max_chars] + "\n\n[... truncated ...]"
        return md
    except Exception:
        logger.exception("pymupdf4llm conversion failed, falling back to fitz")
        try:
            doc = fitz.open(str(pdf_path))
            text = ""
            for page in doc:
                text += page.get_text()
                if len(text) > max_chars:
                    break
            doc.close()
            return text[:max_chars]
        except Exception:
            logger.exception("fitz fallback also failed")
            return ""


def _extract_text_pdfminer(pdf_path: Path, max_chars: int = MAX_TEXT_CHARS) -> str:
    """Extract text using pdfminer.six (pure Python, works on Vercel)."""
    try:
        text = _pdfminer_extract(str(pdf_path))
        if len(text) > max_chars:
            text = text[:max_chars] + "\n\n[... truncated ...]"
        return text
    except Exception:
        logger.warning(f"pdfminer extraction failed: {pdf_path.name}")
        return ""


def _extract_text_pdfium(pdf_path: Path, max_chars: int = MAX_TEXT_CHARS) -> str:
    """Extract text using pypdfium2 (pre-built wheel, works on Vercel)."""
    try:
        doc = pdfium.PdfDocument(str(pdf_path))
        parts: list[str] = []
        total = 0
        for page in doc:
            textpage = page.get_textpage()
            page_text = textpage.get_text_bounded()
            parts.append(page_text)
            total += len(page_text)
            textpage.close()
            page.close()
            if total > max_chars:
                break
        doc.close()
        text = "\n\n".join(parts)
        if len(text) > max_chars:
            text = text[:max_chars] + "\n\n[... truncated ...]"
        return text
    except Exception:
        logger.warning(f"pypdfium2 text extraction failed: {pdf_path.name}")
        return ""


def _extract_markdown(pdf_path: Path, max_chars: int = MAX_TEXT_CHARS) -> str:
    """Extract text: try MarkItDown → pdfminer → pypdfium2 → PyMuPDF."""
    if _HAS_MARKITDOWN:
        text = _extract_markdown_markitdown(pdf_path, max_chars)
        if text:
            return text

    if _HAS_PDFMINER:
        text = _extract_text_pdfminer(pdf_path, max_chars)
        if text:
            return text

    if _HAS_PDFIUM:
        text = _extract_text_pdfium(pdf_path, max_chars)
        if text:
            return text

    if _HAS_PYMUPDF:
        return _extract_markdown_pymupdf(pdf_path, max_chars)

    return ""


# ── Page Rendering & Figure Extraction ─────────────────────────────────

async def _save_figure_bytes(img_bytes: bytes, paper_id: str, filename: str) -> str:
    sid = _safe_id(paper_id)
    if storage.is_vercel():
        url = await storage.upload_to_blob(img_bytes, f"figures/{sid}/{filename}")
        if url:
            return url
    fig_dir = storage.get_figures_dir(sid)
    img_path = fig_dir / filename
    img_path.write_bytes(img_bytes)
    return f"/figures/{sid}/{filename}"


def _render_first_page_pdfium(pdf_path: Path) -> bytes | None:
    """Render the first page using pypdfium2 (works on Vercel)."""
    try:
        doc = pdfium.PdfDocument(str(pdf_path))
        if len(doc) == 0:
            return None
        page = doc[0]
        scale = 2
        bitmap = page.render(scale=scale)
        pil_image = bitmap.to_pil()
        import io
        buf = io.BytesIO()
        pil_image.save(buf, format="PNG")
        return buf.getvalue()
    except Exception:
        logger.warning(f"pypdfium2 first-page render failed: {pdf_path.name}")
        return None


def _render_first_page_pymupdf(pdf_path: Path) -> bytes | None:
    """Render the first page using PyMuPDF (fallback)."""
    try:
        doc = fitz.open(str(pdf_path))
        if len(doc) == 0:
            doc.close()
            return None
        page = doc[0]
        mat = fitz.Matrix(1.5, 1.5)
        pix = page.get_pixmap(matrix=mat)
        img_bytes = pix.tobytes("png")
        doc.close()
        return img_bytes
    except Exception:
        logger.warning(f"PyMuPDF first-page render failed: {pdf_path.name}")
        return None


def _render_first_page_sync(pdf_path: Path) -> bytes | None:
    """Try pypdfium2 first, then PyMuPDF."""
    if _HAS_PDFIUM:
        result = _render_first_page_pdfium(pdf_path)
        if result:
            return result

    if _HAS_PYMUPDF:
        return _render_first_page_pymupdf(pdf_path)

    return None


async def _render_first_page(pdf_path: Path, paper_id: str) -> str | None:
    loop = asyncio.get_running_loop()
    img_bytes = await loop.run_in_executor(None, _render_first_page_sync, pdf_path)
    if not img_bytes:
        return None
    return await _save_figure_bytes(img_bytes, paper_id, "page_0.png")


def _extract_figures_sync(pdf_path: Path, paper_id: str) -> list[tuple[bytes, str]]:
    if not _HAS_PYMUPDF:
        return []
    figures: list[tuple[bytes, str]] = []
    try:
        doc = fitz.open(str(pdf_path))
        img_idx = 0
        for page_num in range(min(len(doc), 6)):
            page = doc[page_num]
            images = page.get_images(full=True)
            for img_info in images:
                xref = img_info[0]
                try:
                    base_image = doc.extract_image(xref)
                    if not base_image:
                        continue
                    width = base_image.get("width", 0)
                    height = base_image.get("height", 0)
                    if width < MIN_FIGURE_SIZE or height < MIN_FIGURE_SIZE:
                        continue
                    ext = base_image.get("ext", "png")
                    img_bytes = base_image["image"]
                    fname = f"fig_{img_idx}.{ext}"
                    figures.append((img_bytes, fname))
                    img_idx += 1
                except Exception:
                    continue
        doc.close()
    except Exception:
        logger.exception(f"Figure extraction failed for {paper_id}")
    return figures


async def _extract_figures(pdf_path: Path, paper_id: str) -> list[str]:
    loop = asyncio.get_running_loop()
    raw_figures = await loop.run_in_executor(None, _extract_figures_sync, pdf_path, paper_id)

    figure_urls: list[str] = []
    for img_bytes, fname in raw_figures:
        url = await _save_figure_bytes(img_bytes, paper_id, fname)
        figure_urls.append(url)

    if not figure_urls:
        thumb_url = await _render_first_page(pdf_path, paper_id)
        if thumb_url:
            figure_urls.append(thumb_url)

    return figure_urls


# ── Thumbnail via DOI (og:image / Unpaywall) ──────────────────────────

async def fetch_thumbnail(paper_id: str, doi: str | None) -> list[str]:
    if not doi:
        return []

    sid = _safe_id(paper_id)

    if not storage.is_vercel():
        fig_dir = storage.get_figures_dir(sid)
        for ext in ("jpg", "png", "webp"):
            thumb_path = fig_dir / f"thumb.{ext}"
            if thumb_path.exists() and thumb_path.stat().st_size > 500:
                return [f"/figures/{sid}/thumb.{ext}"]

    doi_bare = doi.replace("https://doi.org/", "").replace("http://doi.org/", "")
    landing_url = f"https://doi.org/{doi_bare}"

    async with httpx.AsyncClient(
        follow_redirects=True, timeout=15.0,
        headers={"User-Agent": _BROWSER_UA},
    ) as client:
        urls = await _try_og_image(client, landing_url, sid, paper_id)
        if urls:
            return urls

        urls = await _try_unpaywall_pdf(client, doi_bare, sid, paper_id)
        if urls:
            return urls

    return []


async def _try_og_image(
    client: httpx.AsyncClient, landing_url: str,
    sid: str, paper_id: str,
) -> list[str]:
    try:
        resp = await client.get(landing_url)
        if resp.status_code != 200:
            return []

        html = resp.text
        og_match = re.search(
            r'<meta\s+[^>]*?(?:property|name)=["\']og:image["\']\s+[^>]*?content=["\']([^"\']+)["\']',
            html, re.IGNORECASE,
        )
        if not og_match:
            og_match = re.search(
                r'<meta\s+[^>]*?content=["\']([^"\']+)["\']\s+[^>]*?(?:property|name)=["\']og:image["\']',
                html, re.IGNORECASE,
            )
        if not og_match:
            return []

        img_url = og_match.group(1)
        if img_url.startswith("//"):
            img_url = "https:" + img_url
        elif img_url.startswith("/"):
            from urllib.parse import urlparse
            parsed = urlparse(str(resp.url))
            img_url = f"{parsed.scheme}://{parsed.netloc}{img_url}"

        img_resp = await client.get(img_url)
        if img_resp.status_code != 200 or len(img_resp.content) < 500:
            return []

        ext = "jpg"
        ct = img_resp.headers.get("content-type", "")
        if "png" in ct:
            ext = "png"
        elif "webp" in ct:
            ext = "webp"

        fname = f"thumb.{ext}"
        url = await _save_figure_bytes(img_resp.content, paper_id, fname)
        logger.info(f"og:image thumbnail saved for {paper_id}")
        return [url]
    except Exception:
        logger.debug(f"og:image fetch failed for {paper_id}")
        return []


async def _try_unpaywall_pdf(
    client: httpx.AsyncClient, doi_bare: str,
    sid: str, paper_id: str,
) -> list[str]:
    if not (_HAS_PDFIUM or _HAS_PYMUPDF):
        return []
    try:
        resp = await client.get(
            f"https://api.unpaywall.org/v2/{doi_bare}",
            params={"email": UNPAYWALL_EMAIL},
        )
        if resp.status_code != 200:
            return []

        data = resp.json()
        oa_loc = data.get("best_oa_location") or {}
        pdf_url = oa_loc.get("url_for_pdf") or oa_loc.get("url")
        if not pdf_url:
            return []

        pdf_resp = await client.get(pdf_url)
        if pdf_resp.status_code != 200:
            return []

        content = pdf_resp.content
        if len(content) < 1000 or not content[:5].startswith(b"%PDF"):
            return []

        cache_dir = storage.get_pdf_cache_dir()
        pdf_path = cache_dir / f"{sid}.pdf"
        pdf_path.write_bytes(content)

        thumb_url = await _render_first_page(pdf_path, paper_id)
        if thumb_url:
            logger.info(f"Unpaywall PDF thumbnail saved for {paper_id}")
            return [thumb_url]
        return []
    except Exception:
        logger.debug(f"Unpaywall fetch failed for {paper_id}")
        return []


# ── Main Entry Point ──────────────────────────────────────────────────

async def process_pdf(pdf_url: str | None, paper_id: str, doi: str | None = None) -> ProcessedPDF:
    try:
        return await asyncio.wait_for(
            _process_pdf_inner(pdf_url, paper_id, doi),
            timeout=PDF_PROCESS_TIMEOUT,
        )
    except asyncio.TimeoutError:
        logger.warning(f"PDF processing timed out ({PDF_PROCESS_TIMEOUT}s): {paper_id}")
        return ProcessedPDF(paper_id=paper_id, markdown_text="", figure_paths=[])
    except Exception:
        logger.exception(f"PDF processing failed: {paper_id}")
        return ProcessedPDF(paper_id=paper_id, markdown_text="", figure_paths=[])


async def _get_all_figures(pdf_path: Path, paper_id: str) -> list[str]:
    """Extract figures (PyMuPDF) or render first page as fallback. Runs as independent task."""
    figures: list[str] = []
    if _HAS_PYMUPDF:
        figures = await _extract_figures(pdf_path, paper_id)

    if not figures and (_HAS_PDFIUM or _HAS_PYMUPDF):
        first_page_url = await _render_first_page(pdf_path, paper_id)
        if first_page_url:
            figures = [first_page_url]

    return figures


async def _process_pdf_inner(pdf_url: str | None, paper_id: str, doi: str | None = None) -> ProcessedPDF:
    pdf_path = await download_pdf(pdf_url, paper_id, doi)
    if not pdf_path:
        return ProcessedPDF(paper_id=paper_id, markdown_text="", figure_paths=[])

    loop = asyncio.get_running_loop()

    md_task = loop.run_in_executor(None, _extract_markdown, pdf_path)
    fig_task = _get_all_figures(pdf_path, paper_id)

    md_text, figures = await asyncio.gather(md_task, fig_task)

    return ProcessedPDF(
        paper_id=paper_id,
        markdown_text=md_text,
        figure_paths=figures,
    )
