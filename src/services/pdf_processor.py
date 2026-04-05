from __future__ import annotations

import asyncio
import logging
import re
from pathlib import Path

import httpx

from src.models import ProcessedPDF
from src.services import storage

logger = logging.getLogger(__name__)

try:
    import fitz
    import pymupdf4llm
    HAS_PYMUPDF = True
except ImportError:
    HAS_PYMUPDF = False
    logger.info("PyMuPDF not available — PDF text extraction and figure rendering disabled")

MIN_FIGURE_SIZE = 200
MAX_TEXT_CHARS = 12000
PDF_PROCESS_TIMEOUT = 30  # seconds


def _safe_id(paper_id: str) -> str:
    """Create a filesystem-safe identifier from a paper ID."""
    return re.sub(r'[\\/:*?"<>|]', "_", paper_id)


async def _download_from_url(client: httpx.AsyncClient, url: str, pdf_path: Path) -> bool:
    """Try downloading a PDF from a single URL. Returns True on success."""
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
    """Ask Semantic Scholar for an open access PDF URL."""
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
    if not HAS_PYMUPDF:
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


def _extract_markdown(pdf_path: Path, max_chars: int = MAX_TEXT_CHARS) -> str:
    if not HAS_PYMUPDF:
        return ""
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


async def _save_figure_bytes(img_bytes: bytes, paper_id: str, filename: str) -> str:
    """Save figure bytes and return the URL (Blob URL on Vercel, local path otherwise)."""
    sid = _safe_id(paper_id)
    if storage.is_vercel():
        url = await storage.upload_to_blob(img_bytes, f"figures/{sid}/{filename}")
        if url:
            return url
    fig_dir = storage.get_figures_dir(sid)
    img_path = fig_dir / filename
    img_path.write_bytes(img_bytes)
    return f"/figures/{sid}/{filename}"


def _render_first_page_sync(pdf_path: Path, paper_id: str) -> tuple[bytes, str] | None:
    """Render the first page of a PDF as PNG bytes."""
    if not HAS_PYMUPDF:
        return None
    try:
        doc = fitz.open(str(pdf_path))
        if len(doc) == 0:
            doc.close()
            return None
        page = doc[0]
        zoom = 1.5
        mat = fitz.Matrix(zoom, zoom)
        pix = page.get_pixmap(matrix=mat)
        img_bytes = pix.tobytes("png")
        doc.close()
        return (img_bytes, "page_0.png")
    except Exception:
        logger.warning(f"First-page render failed for {paper_id}")
        return None


async def _render_first_page(pdf_path: Path, paper_id: str) -> str | None:
    """Render the first page and save it, returning the URL."""
    loop = asyncio.get_running_loop()
    result = await loop.run_in_executor(None, _render_first_page_sync, pdf_path, paper_id)
    if result is None:
        return None
    img_bytes, filename = result
    return await _save_figure_bytes(img_bytes, paper_id, filename)


def _extract_figures_sync(pdf_path: Path, paper_id: str) -> list[tuple[bytes, str]]:
    """Extract figures from PDF, returning list of (bytes, filename)."""
    if not HAS_PYMUPDF:
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
    """Extract figures and save them, returning list of URLs."""
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


_BROWSER_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/125.0.0.0 Safari/537.36"
)
UNPAYWALL_EMAIL = "papertinder@example.com"


async def fetch_thumbnail(paper_id: str, doi: str | None) -> list[str]:
    """Fetch a thumbnail for a paper via og:image or Unpaywall open access PDF."""
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
    """Extract og:image from the DOI landing page."""
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
    """Use Unpaywall to find an open access PDF, then render the first page."""
    if not HAS_PYMUPDF:
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


async def _process_pdf_inner(pdf_url: str | None, paper_id: str, doi: str | None = None) -> ProcessedPDF:
    pdf_path = await download_pdf(pdf_url, paper_id, doi)
    if not pdf_path:
        return ProcessedPDF(paper_id=paper_id, markdown_text="", figure_paths=[])

    loop = asyncio.get_running_loop()

    md_text = await loop.run_in_executor(None, _extract_markdown, pdf_path)
    figures = await _extract_figures(pdf_path, paper_id)

    return ProcessedPDF(
        paper_id=paper_id,
        markdown_text=md_text,
        figure_paths=figures,
    )
