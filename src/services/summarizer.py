from __future__ import annotations

import logging
import os
from collections.abc import AsyncIterator

import yaml
from dotenv import load_dotenv
from openai import AsyncOpenAI

from src.models import PaperMeta

load_dotenv()

logger = logging.getLogger(__name__)

_config = None


def _load_config():
    global _config
    if _config is None:
        try:
            with open("config.yaml") as f:
                _config = yaml.safe_load(f)
        except Exception:
            _config = {}
    return _config


def _get_model() -> str:
    cfg = _load_config()
    return cfg.get("summary", {}).get("model", "gpt-4o")


def _get_client() -> AsyncOpenAI:
    api_key = os.environ.get("OPENAI_API_KEY")
    if api_key:
        return AsyncOpenAI(api_key=api_key)
    return AsyncOpenAI()


TIER1_PROMPT = """あなたは学術論文の専門的なレビュアーです。
以下の論文について、**必ず日本語で**、スワイプで読む/読まないを素早く判断するための構造化サマリーを作成してください。

## 出力フォーマット（必ずこの順序・ラベルで出力すること）

CLAIM: この論文の核心的主張を1〜2文で抽出してください。出力は以下の「暦本純一のClaimルール」を必ず厳守すること。
- 課題と解決策のペアになっていること。
- 正誤や、「出来た・出来ない」が客観的に判定できる具体的な言明にすること。
- 「〜の研究をした」「新しい手法を提案した」「システムを作った」といった単なる報告や領域の提示は避けること。
- 「効率的に」「直感的に」「自然に」といった、達成の客観的判定が困難な思考停止用語は使わないこと。
- 「〇〇という課題に対し、△△の手法を用いることで、××ができることを示した」のような反証可能な形式にすること。
WHAT: どんなもの？ 簡潔に3〜4文で。研究の目的・対象・成果物を説明。
NOVEL: 先行研究と比べてどこがすごいか？ 箇条書き2〜4項目。
METHOD: 技術や手法のキモはどこ？ 3〜4文で核となるアプローチを説明。
EVAL: どうやって有効だと検証した？ 実験設計・主要結果を2〜3文。
DISCUSSION: 議論・Limitation を2〜3文。
NEXT: 次に読むべき関連論文を2〜3件（タイトルと理由）。

## 重要なルール
- **全セクションを日本語で書くこと（英語禁止）**
- ラベル（CLAIM:, ONE_LINE: 等）は半角英字のまま使い、コロンの後に内容を書く
- 論文のタイトル・著者名・固有名詞はそのまま英語で書いてよい
- 各セクション間に空行を入れないこと

---
タイトル: {title}
著者: {authors}
会議/ジャーナル: {venue} {year}
アブストラクト: {abstract}

---
本文（Markdown）:
{markdown_text}
"""

TIER2_PROMPT = """以下の論文について、研究・技術を深く理解するための詳細解説を日本語で作成してください。

以下の形式で出力してください:

BACKGROUND: （この研究の前提となる技術的背景・概念 詳しく）
DETAIL: （手法・アルゴリズム・アーキテクチャの詳細 数式や具体例を含む）
KEYWORDS: （重要キーワードを3〜5個 それぞれ説明）
IMPL_HINT: （実装の際のヒント・擬似コード）
WHY_MATTERS: （なぜ重要か、分野への影響、応用可能性）
SESSION_RELATION: （同セッションの論文との関連: {session_titles}）

---
タイトル: {title}
著者: {authors}
会議/ジャーナル: {venue} {year}
アブストラクト: {abstract}

---
本文（Markdown）:
{markdown_text}
"""


def _build_tier1_prompt(paper: PaperMeta, md_text: str) -> str:
    return TIER1_PROMPT.format(
        title=paper.title,
        authors=", ".join(paper.authors[:10]),
        venue=paper.venue or "N/A",
        year=paper.year or "N/A",
        abstract=paper.abstract or "N/A",
        markdown_text=md_text or "(PDF本文なし — アブストラクトのみで要約してください)",
    )


def _build_tier2_prompt(
    paper: PaperMeta, md_text: str, session_titles: list[str]
) -> str:
    return TIER2_PROMPT.format(
        title=paper.title,
        authors=", ".join(paper.authors[:10]),
        venue=paper.venue or "N/A",
        year=paper.year or "N/A",
        abstract=paper.abstract or "N/A",
        markdown_text=md_text or "(PDF本文なし)",
        session_titles=", ".join(session_titles) if session_titles else "なし",
    )


async def stream_quick_summary(
    paper: PaperMeta, md_text: str
) -> AsyncIterator[str]:
    """Tier 1: スワイプカード用ストリーミング要約"""
    client = _get_client()
    prompt = _build_tier1_prompt(paper, md_text)

    try:
        stream = await client.chat.completions.create(
            model=_get_model(),
            max_tokens=2000,
            messages=[{"role": "user", "content": prompt}],
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield delta.content
    except Exception:
        logger.exception(f"Tier1 summary failed for {paper.paper_id}")
        yield "[要約生成エラー]"


async def stream_deep_summary(
    paper: PaperMeta, md_text: str, session_titles: list[str] | None = None
) -> AsyncIterator[str]:
    """Tier 2: Scrapbox深掘り用ストリーミング要約"""
    client = _get_client()
    prompt = _build_tier2_prompt(paper, md_text, session_titles or [])

    try:
        stream = await client.chat.completions.create(
            model=_get_model(),
            max_tokens=4000,
            messages=[{"role": "user", "content": prompt}],
            stream=True,
        )
        async for chunk in stream:
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield delta.content
    except Exception:
        logger.exception(f"Tier2 summary failed for {paper.paper_id}")
        yield "[深掘り要約生成エラー]"


def parse_tier1_response(text: str) -> dict[str, str]:
    sections = {
        "claim": "",
        "one_line": "",
        "what": "",
        "novel": "",
        "method": "",
        "eval": "",
        "discussion": "",
        "next_papers": "",
    }

    label_map = {
        "CLAIM:": "claim",
        "ONE_LINE:": "one_line",
        "WHAT:": "what",
        "NOVEL:": "novel",
        "METHOD:": "method",
        "EVAL:": "eval",
        "DISCUSSION:": "discussion",
        "NEXT:": "next_papers",
    }

    current_key = None
    current_lines: list[str] = []

    for line in text.split("\n"):
        stripped = line.strip()
        matched = False
        for label, key in label_map.items():
            if stripped.startswith(label):
                if current_key:
                    sections[current_key] = "\n".join(current_lines).strip()
                current_key = key
                current_lines = [stripped[len(label):].strip()]
                matched = True
                break
        if not matched and current_key:
            current_lines.append(line)

    if current_key:
        sections[current_key] = "\n".join(current_lines).strip()

    return sections
