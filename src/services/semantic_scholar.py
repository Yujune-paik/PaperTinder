"""Paper search orchestrator: OpenAlex (primary) → Semantic Scholar (fallback).

OpenAlex provides precise venue-based filtering via DOI prefixes for ACM
conferences and source IDs for journals, with no restrictive rate limits.
Semantic Scholar is kept as a fallback for venues not well-covered.
"""
from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncGenerator

import httpx

from src.models import PaperMeta
from src.services import openalex

logger = logging.getLogger(__name__)

# ---------- Semantic Scholar fallback ----------

S2_BASE = "https://api.semanticscholar.org/graph/v1/paper/search"
S2_FIELDS = "paperId,title,authors,year,venue,abstract,citationCount,isOpenAccess,openAccessPdf,externalIds"
S2_PAGE = 20
S2_RETRIES = 2
S2_BACKOFF = 3.0


def _s2_to_meta(data: dict, venue_label: str) -> PaperMeta | None:
    try:
        paper_id = data.get("paperId") or ""
        title = data.get("title") or ""
        if not paper_id or not title:
            return None

        authors_raw = data.get("authors") or []
        authors = [
            a.get("name", "") if isinstance(a, dict) else str(a)
            for a in authors_raw
        ]

        pdf_url = None
        oa_pdf = data.get("openAccessPdf")
        if isinstance(oa_pdf, dict) and oa_pdf.get("url"):
            pdf_url = oa_pdf["url"]

        return PaperMeta(
            paper_id=paper_id,
            title=title,
            authors=authors,
            year=data.get("year"),
            venue=venue_label or data.get("venue") or "",
            abstract=data.get("abstract") or "",
            pdf_url=pdf_url,
            semantic_scholar_url=f"https://www.semanticscholar.org/paper/{paper_id}",
            citation_count=data.get("citationCount") or 0,
            open_access=bool(data.get("isOpenAccess")),
        )
    except Exception:
        logger.exception("S2: Failed to parse paper")
        return None


async def _s2_search_venue(
    venue: str, year: int, keyword: str | None, limit: int
) -> AsyncGenerator[list[PaperMeta], None]:
    """Search Semantic Scholar with conservative rate limiting."""
    query = f"{venue} {year}"
    if keyword:
        query = f"{keyword} {query}"

    async with httpx.AsyncClient(timeout=30.0) as client:
        offset = 0
        while offset < limit:
            page_limit = min(S2_PAGE, limit - offset)
            params = {
                "query": query,
                "year": str(year),
                "fields": S2_FIELDS,
                "offset": offset,
                "limit": page_limit,
            }
            data = []
            for attempt in range(S2_RETRIES):
                try:
                    resp = await client.get(S2_BASE, params=params)
                    if resp.status_code == 429:
                        delay = S2_BACKOFF * (2 ** attempt)
                        logger.warning(f"S2 rate limited, waiting {delay:.0f}s")
                        await asyncio.sleep(delay)
                        continue
                    resp.raise_for_status()
                    body = resp.json()
                    data = body.get("data", [])
                    break
                except Exception:
                    logger.warning(f"S2 request failed (attempt {attempt+1})")
                    await asyncio.sleep(S2_BACKOFF)

            if not data:
                break

            papers = []
            for item in data:
                meta = _s2_to_meta(item, venue)
                if meta:
                    papers.append(meta)
            if papers:
                yield papers

            offset += len(data)
            await asyncio.sleep(1.5)


# ---------- Public API ----------


async def stream_search_venues(
    venues: list[str],
    year: int,
    keyword: str | None = None,
    limit_per_venue: int = 50,
) -> AsyncGenerator[dict, None]:
    """Yield SSE events as papers are found, venue by venue.

    Tries OpenAlex first; falls back to Semantic Scholar if OpenAlex
    returns zero results for a venue.
    """
    seen_ids: set[str] = set()
    total_found = 0

    for i, venue in enumerate(venues):
        yield {
            "type": "venue_start",
            "venue": venue,
            "venue_index": i,
            "venue_total": len(venues),
        }

        venue_papers: list[PaperMeta] = []
        source_used = "openalex"

        async for batch in openalex.stream_search_venue(venue, year, keyword, limit_per_venue):
            new_papers = [p for p in batch if p.paper_id not in seen_ids]
            for p in new_papers:
                seen_ids.add(p.paper_id)
                venue_papers.append(p)

            total_found += len(new_papers)
            if new_papers:
                yield {
                    "type": "papers",
                    "papers": [p.model_dump() for p in new_papers],
                    "venue": venue,
                    "total_found": total_found,
                }

        if not venue_papers:
            logger.info(f"OpenAlex returned 0 for {venue} {year}, trying Semantic Scholar")
            source_used = "semantic_scholar"
            async for batch in _s2_search_venue(venue, year, keyword, min(limit_per_venue, 30)):
                new_papers = [p for p in batch if p.paper_id not in seen_ids]
                for p in new_papers:
                    seen_ids.add(p.paper_id)
                    venue_papers.append(p)

                total_found += len(new_papers)
                if new_papers:
                    yield {
                        "type": "papers",
                        "papers": [p.model_dump() for p in new_papers],
                        "venue": venue,
                        "total_found": total_found,
                    }

        logger.info(f"{venue} {year}: {len(venue_papers)} papers via {source_used}")

        yield {
            "type": "venue_done",
            "venue": venue,
            "venue_count": len(venue_papers),
            "total_found": total_found,
        }

    yield {"type": "done", "total_found": total_found}


