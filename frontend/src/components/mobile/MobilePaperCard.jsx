import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { motion } from "framer-motion";

const SECTION_LABELS = {
  claim: "Claim（暦本）",
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

const TAP_THRESHOLD = 12;
const TAP_TIME = 300;
const DIR_LOCK_PX = 10;
const SWIPE_PX = 70;

export default function MobilePaperCard({
  paper, isTop, prefetcher,
  onDetailOpen, onDetailClose, onSwipeRequest,
}) {
  const [summary, setSummary] = useState(null);
  const [streamText, setStreamText] = useState("");
  const [figures, setFigures] = useState([]);
  const [loading, setLoading] = useState(true);
  const [streamError, setStreamError] = useState(false);
  const [flipped, setFlipped] = useState(false);
  const [swipeHint, setSwipeHint] = useState(null);

  const backRef = useRef(null);
  const frontRef = useRef(null);

  /* ── Subscribe to centralized prefetcher ── */
  useEffect(() => {
    if (!prefetcher) return;

    const cb = (entry) => {
      if (entry.summary) setSummary(entry.summary);
      if (entry.streamText) setStreamText(entry.streamText);
      if (entry.figures?.length > 0) setFigures(entry.figures);
      setLoading(entry.loading);
      if (entry.error) {
        setStreamError(true);
        setLoading(false);
      }
    };

    const initial = prefetcher.subscribe(paper.paper_id, cb);
    if (initial) cb(initial);
    prefetcher.enqueue(paper);

    return () => prefetcher.unsubscribe(paper.paper_id, cb);
  }, [paper.paper_id, prefetcher]);

  /* ── computed ── */
  const liveSummary = useMemo(() => {
    if (summary || !streamText) return null;
    return parseLiveStream(streamText);
  }, [streamText, summary]);

  const displaySummary = summary || liveSummary;
  const claimText = displaySummary?.claim || "";
  const oneLineText = displaySummary?.one_line || "";
  const hasAnySummary = displaySummary && Object.values(displaySummary).some((v) => v);

  /* ── flip ── */
  const flipToBack = useCallback(() => {
    setFlipped(true);
    onDetailOpen?.();
  }, [onDetailOpen]);

  const flipToFront = useCallback(() => {
    setFlipped(false);
    setSwipeHint(null);
    onDetailClose?.();
  }, [onDetailClose]);

  /* ── Front face: native tap detection ── */
  useEffect(() => {
    const el = frontRef.current;
    if (!el) return;
    let start = null;

    const onTS = (e) => {
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
    };
    const onTE = (e) => {
      if (!start) return;
      const t = e.changedTouches[0];
      const dx = Math.abs(t.clientX - start.x);
      const dy = Math.abs(t.clientY - start.y);
      const dt = Date.now() - start.t;
      start = null;
      if (dx < TAP_THRESHOLD && dy < TAP_THRESHOLD && dt < TAP_TIME) {
        if (e.target.closest("button")) return;
        if (hasAnySummary && !loading) flipToBack();
      }
    };

    el.addEventListener("touchstart", onTS, { passive: true });
    el.addEventListener("touchend", onTE, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchend", onTE);
    };
  }, [flipToBack, hasAnySummary, loading]);

  /* ── Back face: block ALL propagation to TinderCard,
       detect horizontal swipes ourselves,
       call programmatic swipe via onSwipeRequest ── */
  useEffect(() => {
    const el = backRef.current;
    if (!el) return;

    let start = null;
    let dir = null;

    const onTS = (e) => {
      e.stopPropagation();
      start = { x: e.touches[0].clientX, y: e.touches[0].clientY, t: Date.now() };
      dir = null;
    };

    const onTM = (e) => {
      e.stopPropagation();
      if (!start) return;
      const t = e.touches[0];
      const rawDx = t.clientX - start.x;
      const dx = Math.abs(rawDx);
      const dy = Math.abs(t.clientY - start.y);

      if (!dir && (dx > DIR_LOCK_PX || dy > DIR_LOCK_PX)) {
        dir = dx > dy ? "h" : "v";
      }

      if (dir === "h") {
        if (dx > SWIPE_PX * 0.5) {
          setSwipeHint(rawDx > 0 ? "right" : "left");
        } else {
          setSwipeHint(null);
        }
      }
    };

    const onTE = (e) => {
      e.stopPropagation();
      if (!start) { dir = null; return; }
      const t = e.changedTouches[0];
      const rawDx = t.clientX - start.x;
      const adx = Math.abs(rawDx);
      const ady = Math.abs(t.clientY - start.y);
      const dt = Date.now() - start.t;

      setSwipeHint(null);

      if (adx < TAP_THRESHOLD && ady < TAP_THRESHOLD && dt < TAP_TIME) {
        if (!e.target.closest("button")) flipToFront();
      } else if (dir === "h" && adx > SWIPE_PX) {
        onSwipeRequest?.(rawDx > 0 ? "right" : "left");
      }

      start = null;
      dir = null;
    };

    el.addEventListener("touchstart", onTS, { passive: true });
    el.addEventListener("touchmove", onTM, { passive: true });
    el.addEventListener("touchend", onTE, { passive: true });
    return () => {
      el.removeEventListener("touchstart", onTS);
      el.removeEventListener("touchmove", onTM);
      el.removeEventListener("touchend", onTE);
    };
  }, [flipToFront, onSwipeRequest]);

  /* ── render ── */
  return (
    <div className={`m-card-flipper ${flipped ? "m-card-flipped" : ""}`}>
      {/* ===== FRONT ===== */}
      <div
        ref={frontRef}
        className="m-front"
        onClick={hasAnySummary && !loading ? flipToBack : undefined}
      >
        <div className="m-front-top">
          <div className="m-front-header">
            <span className="m-front-venue">
              {paper.venue || "Unknown"} {paper.year || ""}
            </span>
            {paper.citation_count > 0 && (
              <span className="m-front-citations">
                &#128200; {paper.citation_count}
              </span>
            )}
            {paper.open_access && <span className="m-front-oa">OA</span>}
          </div>
          <h2 className="m-front-title">{paper.title}</h2>
          <div className="m-front-authors">
            {(paper.authors || []).slice(0, 3).join(", ")}
            {(paper.authors || []).length > 3 && " et al."}
          </div>
        </div>

        {figures.length > 0 && (
          <div className="m-front-figure">
            <img src={figures[0]} alt="Figure" loading="lazy" />
          </div>
        )}

        <div className="m-front-summary">
          {hasAnySummary ? (
            <>
              {claimText && (
                <div className="m-front-claim">
                  <span className="m-front-claim-label">Claim</span>
                  <p>{claimText}</p>
                </div>
              )}
              {oneLineText && (
                <p className="m-front-oneline">{oneLineText}</p>
              )}
            </>
          ) : loading ? (
            <div className="m-front-loading">
              <span className="m-pulse-dot" />
              <span>要約を生成中...</span>
              <div className="m-front-loading-bar">
                <motion.div
                  className="m-front-loading-fill"
                  initial={{ width: "0%" }}
                  animate={{ width: "100%" }}
                  transition={{ duration: 15, ease: "linear" }}
                />
              </div>
            </div>
          ) : streamError ? (
            <div className="m-front-error">
              <p>&#9888; 要約に失敗</p>
              <button
                className="m-front-retry"
                onClick={(e) => {
                  e.stopPropagation();
                  setSummary(null);
                  setStreamText("");
                  setStreamError(false);
                  setLoading(true);
                  prefetcher?.retry(paper);
                }}
              >
                再試行
              </button>
            </div>
          ) : (
            <div className="m-front-loading">
              <span className="m-pulse-dot" />
              <span>準備中...</span>
            </div>
          )}
        </div>
      </div>

      {/* ===== BACK ===== */}
      <div ref={backRef} className="m-back" onClick={flipToFront}>
        {swipeHint && (
          <div className={`m-back-swipe-hint m-back-swipe-hint-${swipeHint}`}>
            {swipeHint === "left" ? "✕ Skip" : "✓ Save"}
          </div>
        )}

        <div className="m-back-header">
          <span className="m-front-venue">
            {paper.venue || "Unknown"} {paper.year || ""}
          </span>
          {paper.citation_count > 0 && (
            <span className="m-front-citations">
              &#128200; {paper.citation_count}
            </span>
          )}
        </div>

        <div className="m-back-scroll">
          <h3 className="m-back-title">{paper.title}</h3>
          <div className="m-back-authors">
            {(paper.authors || []).slice(0, 5).join(", ")}
            {(paper.authors || []).length > 5 && " et al."}
          </div>

          {figures.length > 0 && (
            <div className="m-back-figures">
              <div className="m-back-figures-scroll">
                {figures.map((url, i) => (
                  <img
                    key={i}
                    src={url}
                    alt={`Figure ${i + 1}`}
                    className="m-back-fig-img"
                    loading="lazy"
                  />
                ))}
              </div>
            </div>
          )}

          {displaySummary && (
            <div className="m-back-sections">
              {Object.entries(SECTION_LABELS).map(([key, label]) => {
                const content = displaySummary[key];
                if (!content) return null;
                const isClaim = key === "claim";
                return (
                  <div
                    key={key}
                    className={`m-back-section ${isClaim ? "m-back-section-claim" : ""}`}
                  >
                    <div className="m-back-section-label">{label}</div>
                    <div className="m-back-section-content">
                      {content.split("\n").map((line, i) => (
                        <p key={i}>{line}</p>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
