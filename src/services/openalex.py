"""OpenAlex API client for searching academic papers by venue and year.

Uses DOI prefix lookup for ACM conferences (most precise) and falls back
to keyword search + year filter for other venues.
"""
from __future__ import annotations

import logging
from collections.abc import AsyncGenerator

import httpx

from src.models import PaperMeta

logger = logging.getLogger(__name__)

BASE_URL = "https://api.openalex.org"
PAGE_SIZE = 50
POLITE_MAIL = "papertinder@example.com"

# ACM proceedings DOI prefixes per conference per year.
# Looked up from https://dl.acm.org/doi/proceedings/10.1145/XXXXXXX
_ACM_PROCEEDINGS_DOI: dict[str, dict[int, str]] = {
    "CHI": {
        2020: "10.1145/3313831",
        2021: "10.1145/3411764",
        2022: "10.1145/3491102",
        2023: "10.1145/3544548",
        2024: "10.1145/3613904",
        2025: "10.1145/3706598",
    },
    "UIST": {
        2020: "10.1145/3379337",
        2021: "10.1145/3472749",
        2022: "10.1145/3526113",
        2023: "10.1145/3586183",
        2024: "10.1145/3654777",
    },
    "CSCW": {
        2020: "10.1145/3392863",
        2021: "10.1145/3449106",
        2022: "10.1145/3555623",
        2023: "10.1145/3579605",
        2024: "10.1145/3637297",
    },
}

# Journal ISSN / OpenAlex source IDs (for journals with stable identifiers)
_SOURCE_IDS: dict[str, str] = {
    "Nature": "S137773608",
    "Science": "S3880285",
    "Science Robotics": "S4210204280",
}


def _decode_inverted_index(inv_idx: dict | None) -> str:
    """Convert OpenAlex abstract_inverted_index back to plain text."""
    if not inv_idx:
        return ""
    positions: list[tuple[int, str]] = []
    for word, indices in inv_idx.items():
        for pos in indices:
            positions.append((pos, word))
    positions.sort(key=lambda x: x[0])
    return " ".join(w for _, w in positions)


_PREFERRED_HOSTS = ["arxiv.org", "europepmc.org", "biorxiv.org", "medrxiv.org"]
_PAYWALLED_HOSTS = ["dl.acm.org", "ieeexplore.ieee.org", "onlinelibrary.wiley.com", "www.sciencedirect.com"]


def _best_pdf_url(work: dict, primary_loc: dict) -> str | None:
    """Pick the most accessible PDF URL from all known locations."""
    candidates: list[tuple[int, str]] = []

    for loc_entry in work.get("locations") or []:
        url = loc_entry.get("pdf_url")
        if not url:
            continue
        is_oa = loc_entry.get("is_oa", False)
        host = url.split("/")[2] if url.startswith("http") else ""

        if any(h in host for h in _PREFERRED_HOSTS):
            candidates.append((0, url))
        elif is_oa and not any(h in host for h in _PAYWALLED_HOSTS):
            candidates.append((1, url))
        elif is_oa:
            candidates.append((2, url))
        else:
            candidates.append((3, url))

    primary_pdf = primary_loc.get("pdf_url")
    if primary_pdf and not any(url == primary_pdf for _, url in candidates):
        candidates.append((3, primary_pdf))

    oa_info = work.get("open_access") or {}
    oa_url = oa_info.get("oa_url")
    if oa_url and not any(url == oa_url for _, url in candidates):
        candidates.append((2, oa_url))

    if not candidates:
        return None

    candidates.sort(key=lambda x: x[0])
    return candidates[0][1]


def _parse_work(work: dict) -> PaperMeta | None:
    """Convert an OpenAlex work object into PaperMeta."""
    try:
        openalex_id = work.get("id", "")
        title = work.get("title") or ""
        if not title:
            return None

        paper_id = openalex_id.replace("https://openalex.org/", "")
        doi = work.get("doi") or ""

        authorships = work.get("authorships") or []
        authors = []
        for a in authorships:
            author_obj = a.get("author") or {}
            name = author_obj.get("display_name", "")
            if name:
                authors.append(name)

        loc = work.get("primary_location") or {}
        source = loc.get("source") or {}
        venue = work.get("_venue_label") or source.get("display_name") or loc.get("raw_source_name") or ""

        pdf_url = _best_pdf_url(work, loc)

        abstract = _decode_inverted_index(work.get("abstract_inverted_index"))

        oa_info = work.get("open_access") or {}

        sem_scholar_url = ""
        if doi:
            sem_scholar_url = f"https://www.semanticscholar.org/paper/{doi.replace('https://doi.org/', '')}"
        else:
            sem_scholar_url = f"https://openalex.org/{paper_id}"

        return PaperMeta(
            paper_id=paper_id,
            title=title,
            authors=authors,
            year=work.get("publication_year"),
            venue=venue,
            abstract=abstract,
            doi=doi or None,
            pdf_url=pdf_url,
            semantic_scholar_url=sem_scholar_url,
            citation_count=work.get("cited_by_count") or 0,
            open_access=bool(oa_info.get("is_oa")),
        )
    except Exception:
        logger.exception("Failed to parse OpenAlex work")
        return None


async def _fetch_by_doi_prefix(
    client: httpx.AsyncClient,
    doi_prefix: str,
    year: int,
    keyword: str | None,
    limit: int,
    venue_label: str,
) -> AsyncGenerator[list[PaperMeta], None]:
    """Fetch papers by DOI prefix, yielding pages."""
    cursor = "*"
    fetched = 0
    while fetched < limit:
        per_page = min(PAGE_SIZE, limit - fetched)
        params: dict = {
            "filter": f"doi_starts_with:{doi_prefix},publication_year:{year}",
            "per_page": per_page,
            "cursor": cursor,
            "sort": "cited_by_count:desc",
            "select": "id,title,doi,authorships,publication_year,primary_location,locations,cited_by_count,open_access,abstract_inverted_index",
            "mailto": POLITE_MAIL,
        }
        if keyword:
            params["search"] = keyword

        resp = await client.get(f"{BASE_URL}/works", params=params)
        if resp.status_code != 200:
            logger.warning(f"OpenAlex error {resp.status_code}: {resp.text[:200]}")
            break

        body = resp.json()
        results = body.get("results", [])
        if not results:
            break

        papers: list[PaperMeta] = []
        for w in results:
            w["_venue_label"] = venue_label
            meta = _parse_work(w)
            if meta:
                papers.append(meta)

        if papers:
            yield papers
        fetched += len(results)

        next_cursor = body.get("meta", {}).get("next_cursor")
        if not next_cursor:
            break
        cursor = next_cursor


async def _fetch_by_search(
    client: httpx.AsyncClient,
    venue: str,
    year: int,
    keyword: str | None,
    limit: int,
) -> AsyncGenerator[list[PaperMeta], None]:
    """Fallback: search by keyword + venue name + year filter."""
    search_query = venue
    if keyword:
        search_query = f"{keyword} {venue}"

    cursor = "*"
    fetched = 0
    while fetched < limit:
        per_page = min(PAGE_SIZE, limit - fetched)
        params: dict = {
            "search": search_query,
            "filter": f"publication_year:{year}",
            "per_page": per_page,
            "cursor": cursor,
            "select": "id,title,doi,authorships,publication_year,primary_location,locations,cited_by_count,open_access,abstract_inverted_index",
            "mailto": POLITE_MAIL,
        }

        resp = await client.get(f"{BASE_URL}/works", params=params)
        if resp.status_code != 200:
            logger.warning(f"OpenAlex search error {resp.status_code}: {resp.text[:200]}")
            break

        body = resp.json()
        results = body.get("results", [])
        if not results:
            break

        papers: list[PaperMeta] = []
        for w in results:
            w["_venue_label"] = venue
            meta = _parse_work(w)
            if meta:
                papers.append(meta)

        if papers:
            yield papers
        fetched += len(results)

        next_cursor = body.get("meta", {}).get("next_cursor")
        if not next_cursor:
            break
        cursor = next_cursor


async def _fetch_by_source(
    client: httpx.AsyncClient,
    source_id: str,
    year: int,
    keyword: str | None,
    limit: int,
    venue_label: str,
) -> AsyncGenerator[list[PaperMeta], None]:
    """Fetch papers from a known OpenAlex source (journals)."""
    cursor = "*"
    fetched = 0
    while fetched < limit:
        per_page = min(PAGE_SIZE, limit - fetched)
        params: dict = {
            "filter": f"primary_location.source.id:{source_id},publication_year:{year}",
            "per_page": per_page,
            "cursor": cursor,
            "sort": "cited_by_count:desc",
            "select": "id,title,doi,authorships,publication_year,primary_location,locations,cited_by_count,open_access,abstract_inverted_index",
            "mailto": POLITE_MAIL,
        }
        if keyword:
            params["search"] = keyword

        resp = await client.get(f"{BASE_URL}/works", params=params)
        if resp.status_code != 200:
            logger.warning(f"OpenAlex source error {resp.status_code}: {resp.text[:200]}")
            break

        body = resp.json()
        results = body.get("results", [])
        if not results:
            break

        papers: list[PaperMeta] = []
        for w in results:
            w["_venue_label"] = venue_label
            meta = _parse_work(w)
            if meta:
                papers.append(meta)

        if papers:
            yield papers
        fetched += len(results)

        next_cursor = body.get("meta", {}).get("next_cursor")
        if not next_cursor:
            break
        cursor = next_cursor


def _get_venue_strategy(venue: str, year: int):
    """Determine the best search strategy for a venue+year combination."""
    upper = venue.upper()
    for conf_name, years in _ACM_PROCEEDINGS_DOI.items():
        if upper == conf_name.upper() and year in years:
            return "doi_prefix", years[year]

    for source_name, source_id in _SOURCE_IDS.items():
        if upper == source_name.upper():
            return "source_id", source_id

    return "search", None


async def stream_search_venue(
    venue: str,
    year: int,
    keyword: str | None = None,
    limit: int = 50,
) -> AsyncGenerator[list[PaperMeta], None]:
    """Stream papers for a single venue, yielding batches."""
    strategy, param = _get_venue_strategy(venue, year)
    logger.info(f"OpenAlex: venue={venue} year={year} strategy={strategy} param={param}")

    async with httpx.AsyncClient(timeout=30.0) as client:
        if strategy == "doi_prefix":
            async for batch in _fetch_by_doi_prefix(client, param, year, keyword, limit, venue):
                yield batch
        elif strategy == "source_id":
            async for batch in _fetch_by_source(client, param, year, keyword, limit, venue):
                yield batch
        else:
            async for batch in _fetch_by_search(client, venue, year, keyword, limit):
                yield batch
