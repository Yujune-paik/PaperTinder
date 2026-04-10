"""NotebookLM exporter using notebooklm-py (unofficial SDK).

Auth is browser-cookie-based. Set up locally with:
    pip install "notebooklm-py[browser]"
    playwright install chromium
    notebooklm login

For Vercel / CI, set NOTEBOOKLM_AUTH_JSON env var with the contents
of ~/.notebooklm/profiles/default/storage_state.json
"""
from __future__ import annotations

import logging
import os

logger = logging.getLogger(__name__)

_HAS_NOTEBOOKLM = False
try:
    from notebooklm import NotebookLMClient  # type: ignore[import-untyped]
    _HAS_NOTEBOOKLM = True
except ImportError:
    logger.info("notebooklm-py not installed — NotebookLM export disabled")


def is_configured() -> bool:
    if not _HAS_NOTEBOOKLM:
        return False
    has_auth_json = bool(os.environ.get("NOTEBOOKLM_AUTH_JSON"))
    has_local_profile = os.path.exists(
        os.path.expanduser("~/.notebooklm/profiles/default/storage_state.json")
    ) or os.path.exists(
        os.path.expanduser("~/.notebooklm/storage_state.json")
    )
    return has_auth_json or has_local_profile


def _build_paper_text(paper: dict, summary: dict) -> str:
    """Build a plain-text document from paper metadata + summary sections."""
    parts = []
    title = paper.get("title", "Untitled")
    parts.append(f"# {title}\n")

    authors = paper.get("authors", [])
    if authors:
        parts.append(f"著者: {', '.join(authors[:10])}")
    venue = paper.get("venue", "")
    year = paper.get("year", "")
    if venue or year:
        parts.append(f"会議: {venue} {year}")
    url = paper.get("semantic_scholar_url", "")
    if url:
        parts.append(f"URL: {url}")
    parts.append("")

    section_labels = {
        "claim": "CLAIM (核心的主張)",
        "what": "概要",
        "novel": "新規性",
        "method": "手法",
        "eval": "評価",
        "discussion": "議論・Limitation",
        "next_papers": "次に読むべき論文",
    }
    section_order = ["claim", "what", "novel", "method", "eval", "discussion", "next_papers"]

    for key in section_order:
        text = summary.get(key, "")
        if not text:
            continue
        label = section_labels.get(key, key)
        parts.append(f"## {label}")
        parts.append(text)
        parts.append("")

    if not summary:
        abstract = paper.get("abstract", "")
        if abstract:
            parts.append("## アブストラクト")
            parts.append(abstract)

    return "\n".join(parts)


def build_session_document(
    date_str: str,
    papers: list[dict],
    summaries: dict[str, dict],
) -> str:
    """Build a single Markdown document optimised for NotebookLM ingestion.

    The document is structured so that NotebookLM can generate high-quality
    audio overviews and QA from the session's papers.
    """
    parts: list[str] = []
    parts.append(f"# 論文リーディングセッション — {date_str}\n")
    parts.append(f"このドキュメントは PaperTinder で保存した {len(papers)} 本の論文の要約集です。")
    parts.append("各論文について、核心的主張・手法・新規性・評価・議論をまとめています。\n")

    venues = sorted({p.get("venue") or "Unknown" for p in papers})
    parts.append(f"**対象会議**: {', '.join(venues)}\n")
    parts.append("---\n")

    parts.append("## 目次\n")
    for i, paper in enumerate(papers, 1):
        parts.append(f"{i}. {paper.get('title', 'Untitled')}")
    parts.append("\n---\n")

    for i, paper in enumerate(papers, 1):
        pid = paper.get("paper_id", "")
        summary = summaries.get(pid, {})
        parts.append(f"## {i}. {paper.get('title', 'Untitled')}\n")
        parts.append(_build_paper_text(paper, summary))
        parts.append("\n---\n")

    return "\n".join(parts)


async def export_daily_session(
    date_str: str,
    papers: list[dict],
    summaries: dict[str, dict],
) -> dict:
    """Create a NotebookLM notebook for the day and add papers as sources."""
    if not _HAS_NOTEBOOKLM:
        return {"status": "error", "message": "notebooklm-py がインストールされていません"}

    title = f"論文セッション {date_str}"

    try:
        async with await NotebookLMClient.from_storage() as client:
            nb = await client.notebooks.create(title)
            notebook_id = nb.id
            logger.info(f"NotebookLM notebook created: {notebook_id}")

            added_count = 0
            errors = []

            for paper in papers:
                pid = paper.get("paper_id", "")
                paper_title = paper.get("title", "Untitled")
                summary = summaries.get(pid, {})

                doi = paper.get("doi", "")
                doi_url = ""
                if doi:
                    doi_url = doi if doi.startswith("http") else f"https://doi.org/{doi}"

                if doi_url:
                    try:
                        await client.sources.add_url(
                            notebook_id, doi_url, wait=True
                        )
                        added_count += 1
                        logger.info(f"Added URL source: {paper_title}")
                        continue
                    except Exception as e:
                        logger.warning(f"URL source failed for {paper_title}: {e}")

                text = _build_paper_text(paper, summary)
                try:
                    await client.sources.add_text(
                        notebook_id, text, title=paper_title, wait=True
                    )
                    added_count += 1
                    logger.info(f"Added text source: {paper_title}")
                except Exception as e:
                    msg = f"{paper_title}: {e}"
                    logger.error(f"Failed to add source: {msg}")
                    errors.append(msg)

            notebook_url = f"https://notebooklm.google.com/notebook/{notebook_id}"

            if errors:
                return {
                    "status": "partial",
                    "notebook_id": notebook_id,
                    "notebook_url": notebook_url,
                    "papers_added": added_count,
                    "errors": errors,
                }

            return {
                "status": "ok",
                "notebook_id": notebook_id,
                "notebook_url": notebook_url,
                "papers_added": added_count,
            }

    except Exception as e:
        logger.exception("NotebookLM export failed")
        return {"status": "error", "message": str(e)}
