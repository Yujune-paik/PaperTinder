"""Scrapbox exporter: format daily summary pages and push via import API.

Auth requires `SCRAPBOX_SID` (connect.sid cookie value) and
`SCRAPBOX_PROJECT` (project name) environment variables.
"""
from __future__ import annotations

import json
import logging
import os

import httpx

logger = logging.getLogger(__name__)

API_BASE = "https://scrapbox.io"
API_ME = f"{API_BASE}/api/users/me"
API_IMPORT = API_BASE + "/api/page-data/import/{project}.json"


def _get_config() -> tuple[str, str]:
    sid = os.environ.get("SCRAPBOX_SID", "").strip()
    project = os.environ.get("SCRAPBOX_PROJECT", "").strip()
    return sid, project


def is_configured() -> bool:
    sid, project = _get_config()
    return bool(sid and project)


def _section_label(key: str) -> str:
    labels = {
        "claim": "CLAIM",
        "what": "概要",
        "novel": "新規性",
        "method": "手法",
        "eval": "評価",
        "discussion": "議論・Limitation",
        "next_papers": "次に読むべき論文",
    }
    return labels.get(key, key)


def _to_scrapbox_lines(text: str, indent: int = 1) -> list[str]:
    """Convert multiline text to indented Scrapbox lines."""
    prefix = " " * indent
    lines = []
    for line in text.strip().split("\n"):
        stripped = line.strip()
        if stripped:
            lines.append(f"{prefix}{stripped}")
    return lines


def build_daily_page(
    date_str: str,
    papers: list[dict],
    summaries: dict[str, dict],
) -> dict:
    """Build a single Scrapbox page for the day's reading session.

    Args:
        date_str: Date string like "2024-01-15"
        papers: List of dicts with keys from PaperMeta + ReadingListItem
        summaries: {paper_id: {section_key: text}}

    Returns:
        Scrapbox page dict with "title" and "lines".
    """
    venues = list({p.get("venue") or "Unknown" for p in papers})
    venue_tags = " ".join(f"[{v}]" for v in sorted(venues))

    title = f"論文セッション {date_str}"
    lines = [title]

    tag_line = f"#paper-tinder #session {venue_tags}"
    lines.append(tag_line)
    lines.append("")
    lines.append(f"保存数: {len(papers)}本")
    lines.append("")

    toc_lines = [f" [{p.get('title', 'Untitled')}]" for p in papers]
    lines.append("[* 目次]")
    lines.extend(toc_lines)
    lines.append("")
    lines.append("---")
    lines.append("")

    for paper in papers:
        pid = paper.get("paper_id", "")
        title_text = paper.get("title", "Untitled")
        authors = paper.get("authors", [])
        venue = paper.get("venue", "")
        year = paper.get("year", "")
        url = paper.get("semantic_scholar_url", "")

        lines.append(f"[*** {title_text}]")
        if authors:
            lines.append(f" 著者: {', '.join(authors[:5])}")
        if venue or year:
            lines.append(f" 会議: {venue} {year}")
        if url:
            lines.append(f" リンク: [{url}]")
        lines.append("")

        summary = summaries.get(pid, {})
        if summary:
            section_order = [
                "claim", "what", "novel", "method",
                "eval", "discussion", "next_papers",
            ]
            for key in section_order:
                text = summary.get(key, "")
                if not text:
                    continue
                label = _section_label(key)
                lines.append(f" [** {label}]")
                lines.extend(_to_scrapbox_lines(text, indent=2))
                lines.append("")
        else:
            abstract = paper.get("abstract", "")
            if abstract:
                lines.append(" [** アブストラクト]")
                lines.extend(_to_scrapbox_lines(abstract, indent=2))
                lines.append("")

        lines.append("---")
        lines.append("")

    return {"title": title, "lines": lines}


def format_import_json(pages: list[dict]) -> str:
    return json.dumps({"pages": pages}, ensure_ascii=False)


async def push_to_scrapbox(pages: list[dict]) -> dict:
    """Push pages to Scrapbox via the import API.

    Returns:
        {"status": "ok"} on success, {"status": "error", "message": ...} on failure.
    """
    sid, project = _get_config()
    if not sid or not project:
        return {"status": "error", "message": "SCRAPBOX_SID or SCRAPBOX_PROJECT not configured"}

    cookie = f"connect.sid={sid}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        me_resp = await client.get(API_ME, headers={"Cookie": cookie})
        if me_resp.status_code != 200:
            return {"status": "error", "message": f"Failed to get CSRF token (HTTP {me_resp.status_code})"}

        csrf_token = me_resp.json().get("csrfToken", "")
        if not csrf_token:
            return {"status": "error", "message": "CSRF token not found in /api/users/me response"}

        url = API_IMPORT.format(project=project)
        import_data = json.dumps({"pages": pages}, ensure_ascii=False)

        resp = await client.post(
            url,
            files={"import-file": ("import.json", import_data, "application/json")},
            headers={
                "Cookie": cookie,
                "Accept": "application/json, text/plain, */*",
                "X-CSRF-TOKEN": csrf_token,
            },
        )

        if resp.status_code in (200, 201):
            logger.info(f"Scrapbox import succeeded: {len(pages)} pages")
            return {"status": "ok", "pages_imported": len(pages), "project": project}
        else:
            body = resp.text[:500]
            logger.error(f"Scrapbox import failed ({resp.status_code}): {body}")
            return {"status": "error", "message": f"Import failed (HTTP {resp.status_code}): {body}"}
