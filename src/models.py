from __future__ import annotations

from pydantic import BaseModel, Field


class PaperMeta(BaseModel):
    paper_id: str
    title: str
    authors: list[str] = Field(default_factory=list)
    year: int | None = None
    venue: str | None = None
    abstract: str | None = None
    doi: str | None = None
    pdf_url: str | None = None
    semantic_scholar_url: str | None = None
    citation_count: int | None = None
    open_access: bool = False


class ProcessedPDF(BaseModel):
    paper_id: str
    markdown_text: str
    figure_paths: list[str] = Field(default_factory=list)


class ReadingListItem(BaseModel):
    paper_id: str
    title: str
    venue: str | None = None
    year: int | None = None
    saved_at: str | None = None


class ProgressData(BaseModel):
    venue: str
    year: int
    total: int = 0
    seen: list[str] = Field(default_factory=list)
    saved: list[str] = Field(default_factory=list)


class SearchRequest(BaseModel):
    venues: list[str]
    year: int = 2024
    keyword: str | None = None
    limit: int = 50
