import { useState, useEffect, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

const SECTION_LABELS = {
  claim: "Claim",
  one_line: "1行まとめ",
  what: "どんなもの？",
  novel: "先行研究と比べてどこがすごい？",
  method: "技術や手法のキモ",
  eval: "どうやって有効だと検証した？",
  discussion: "議論・Limitation",
  next_papers: "次に読むべき論文",
};

function parseLiveStream(text) {
  const result = {};
  const labels = ["CLAIM:", "ONE_LINE:", "WHAT:", "NOVEL:", "METHOD:", "EVAL:", "DISCUSSION:", "NEXT:"];
  const keyMap = {
    "CLAIM:": "claim", "ONE_LINE:": "one_line", "WHAT:": "what",
    "NOVEL:": "novel", "METHOD:": "method", "EVAL:": "eval",
    "DISCUSSION:": "discussion", "NEXT:": "next_papers",
  };

  let currentKey = null;
  let currentLines = [];

  for (const line of text.split("\n")) {
    const stripped = line.trim();
    let matched = false;
    for (const label of labels) {
      if (stripped.startsWith(label)) {
        if (currentKey) result[currentKey] = currentLines.join("\n").trim();
        currentKey = keyMap[label];
        currentLines = [stripped.slice(label.length).trim()];
        matched = true;
        break;
      }
    }
    if (!matched && currentKey) currentLines.push(line);
  }
  if (currentKey) result[currentKey] = currentLines.join("\n").trim();
  return result;
}

export default function PaperCard({ paper, isTop }) {
  const [summary, setSummary] = useState(paper._preloaded_summary || null);
  const [streamText, setStreamText] = useState("");
  const [figures, setFigures] = useState(paper._preloaded_figures || []);
  const [loading, setLoading] = useState(false);
  const [streamError, setStreamError] = useState(false);
  const [retryCount, setRetryCount] = useState(0);
  const [expandedSections, setExpandedSections] = useState(
    new Set(Object.keys(SECTION_LABELS))
  );

  useEffect(() => {
    if (!isTop) return;
    if (summary) return;

    setLoading(true);
    setStreamError(false);
    setStreamText("");

    const handleSSEStream = (reader) => {
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";
      let gotContent = false;

      const pump = () => {
        reader.read().then(({ done, value }) => {
          if (done) {
            setLoading(false);
            if (!gotContent) setStreamError(true);
            return;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.startsWith("data: ")) continue;
            try {
              const data = JSON.parse(line.slice(6));
              if (data.type === "figures") {
                setFigures(data.urls || []);
              } else if (data.type === "chunk") {
                fullText += data.text;
                gotContent = true;
                setStreamText(fullText);
              } else if (data.type === "summary") {
                setSummary(data.data);
                gotContent = true;
                setLoading(false);
              } else if (data.type === "done") {
                setLoading(false);
              } else if (data.type === "error") {
                console.error("Stream error:", data.message);
                setLoading(false);
                setStreamError(true);
              }
            } catch { /* ignore */ }
          }
          pump();
        }).catch(() => {
          setLoading(false);
          if (!gotContent) setStreamError(true);
        });
      };
      pump();
    };

    const startStream = async () => {
      try {
        const esRes = await fetch(`/api/stream/${encodeURIComponent(paper.paper_id)}`);
        if (esRes.ok) {
          handleSSEStream(esRes.body.getReader());
          return;
        }
      } catch { /* fall through */ }

      try {
        const res = await fetch("/api/stream-inline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(paper),
        });
        if (res.ok) {
          handleSSEStream(res.body.getReader());
          return;
        }
      } catch { /* ignore */ }

      setLoading(false);
      setStreamError(true);
    };

    startStream();

    return () => {};
  }, [isTop, paper.paper_id, retryCount]);

  const liveSummary = useMemo(() => {
    if (summary || !streamText) return null;
    return parseLiveStream(streamText);
  }, [streamText, summary]);

  const displaySummary = summary || liveSummary;
  const hasContent = displaySummary && Object.values(displaySummary).some((v) => v);

  const toggleSection = (key) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  return (
    <div className="paper-card">
      <div className="paper-card-header">
        <div className="paper-venue-badge">
          {paper.venue || "Unknown"} {paper.year || ""}
        </div>
        {paper.citation_count > 0 && (
          <div className="paper-citations">
            &#128200; {paper.citation_count} citations
          </div>
        )}
        {paper.open_access && <div className="paper-oa-badge">OA</div>}
      </div>

      <h2 className="paper-title">{paper.title}</h2>

      <div className="paper-authors">
        {(paper.authors || []).slice(0, 5).join(", ")}
        {(paper.authors || []).length > 5 && " et al."}
      </div>

      {figures.length > 0 && (
        <div className="figure-gallery-top">
          <div className="figure-scroll">
            {figures.map((url, i) => (
              <img
                key={i}
                src={url}
                alt={`Figure ${i + 1}`}
                className="figure-img"
                loading="lazy"
              />
            ))}
          </div>
        </div>
      )}

      <div className="paper-card-body">
        {hasContent ? (
          <div className="summary-sections">
            {loading && (
              <div className="summary-streaming-indicator">
                <span className="loading-pulse" />
                <span>要約を生成中...</span>
              </div>
            )}
            <AnimatePresence>
              {Object.entries(SECTION_LABELS).map(([key, label]) => {
                const content = displaySummary[key];
                if (!content) return null;
                const isExpanded = expandedSections.has(key);
                const isClaim = key === "claim";

                return (
                  <motion.div
                    key={key}
                    className={`summary-section ${isClaim ? "claim-section" : ""}`}
                    initial={{ opacity: 0, y: 8 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ duration: 0.2 }}
                  >
                    <button
                      className="section-toggle"
                      onClick={() => toggleSection(key)}
                    >
                      <span className="section-arrow">
                        {isExpanded ? "\u25BC" : "\u25B6"}
                      </span>
                      <span className="section-label">{label}</span>
                    </button>
                    {isExpanded && (
                      <motion.div
                        className="section-content"
                        initial={{ height: 0, opacity: 0 }}
                        animate={{ height: "auto", opacity: 1 }}
                        transition={{ duration: 0.2 }}
                      >
                        {content.split("\n").map((line, i) => (
                          <p key={i}>{line}</p>
                        ))}
                      </motion.div>
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        ) : loading ? (
          <div className="skeleton-container">
            <div className="skeleton skeleton-title" />
            <div className="skeleton skeleton-text" />
            <div className="skeleton skeleton-text short" />
            <div className="skeleton skeleton-text" />
            <div className="skeleton skeleton-text medium" />
            <div className="progress-bar-container">
              <motion.div
                className="progress-bar"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: 15, ease: "linear" }}
              />
            </div>
            <p className="skeleton-hint">要約を生成中...</p>
          </div>
        ) : streamError ? (
          <div className="summary-error-state">
            <div className="summary-error-icon">&#9888;</div>
            <p className="summary-error-text">
              日本語要約の生成に失敗しました
            </p>
            <button
              className="btn btn-retry"
              onClick={() => {
                setSummary(null);
                setStreamError(false);
                setRetryCount((c) => c + 1);
              }}
            >
              &#128260; もう一度試す
            </button>
            <details className="abstract-fallback">
              <summary>原文アブストラクト（英語）</summary>
              <p>{paper.abstract || "アブストラクトなし"}</p>
            </details>
          </div>
        ) : (
          <div className="summary-error-state">
            <p className="summary-error-text">要約を準備しています...</p>
          </div>
        )}

      </div>

    </div>
  );
}
