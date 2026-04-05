import { motion, AnimatePresence } from "framer-motion";

const VENUE_COLORS = {
  CHI: "#e74c3c",
  UIST: "#3498db",
  CSCW: "#2ecc71",
  Ubicomp: "#e67e22",
  ISWC: "#9b59b6",
  HRI: "#1abc9c",
  ISS: "#f39c12",
  DIS: "#e84393",
  TEI: "#00cec9",
  MobileHCI: "#6c5ce7",
  NeurIPS: "#fd79a8",
  CVPR: "#0984e3",
  ICCV: "#00b894",
  ICML: "#d63031",
  ECCV: "#fdcb6e",
  AAAI: "#a29bfe",
  SIGGRAPH: "#fab1a0",
  "SIGGRAPH Asia": "#ff7675",
  Nature: "#2d3436",
  Science: "#636e72",
  "Science Robotics": "#b2bec3",
};

function VenueBadge({ venue, year, isComplete }) {
  const color = VENUE_COLORS[venue] || "#6c5ce7";
  const abbr = venue.slice(0, 3).toUpperCase();

  return (
    <motion.div
      className={`venue-badge ${isComplete ? "venue-badge-complete" : ""}`}
      initial={isComplete ? { scale: 0, rotate: -180 } : false}
      animate={isComplete ? { scale: 1, rotate: 0 } : false}
      transition={{ type: "spring", stiffness: 200, damping: 15 }}
      title={`${venue} ${year}${isComplete ? " - Complete!" : ""}`}
    >
      <div
        className="venue-badge-icon"
        style={{ borderColor: color, color: isComplete ? "#fff" : color, background: isComplete ? color : "transparent" }}
      >
        {abbr}
      </div>
      {isComplete && <span className="venue-badge-check">&#10003;</span>}
    </motion.div>
  );
}

export default function ProgressBar({ progress, onResume }) {
  if (!progress || progress.length === 0) return null;

  const active = progress.filter((p) => p.seen && p.seen.length > 0);
  if (active.length === 0) return null;

  const completed = active.filter(
    (p) => p.total > 0 && (p.seen?.length || 0) >= p.total
  );

  return (
    <div className="progress-panel">
      {completed.length > 0 && (
        <div className="badges-section">
          <h4 className="progress-title">&#127942; コンプリート</h4>
          <div className="badges-grid">
            {completed.map((p) => (
              <VenueBadge
                key={`${p.venue}_${p.year}`}
                venue={p.venue}
                year={p.year}
                isComplete
              />
            ))}
          </div>
        </div>
      )}

      <h4 className="progress-title">&#128202; 進捗</h4>
      {active.map((p) => {
        const seenCount = p.seen?.length || 0;
        const total = Math.max(p.total || 0, seenCount);
        const savedCount = p.saved?.length || 0;
        const pct = total > 0 ? Math.round((seenCount / total) * 100) : 0;
        const remaining = Math.max(0, total - seenCount);
        const isComplete = remaining === 0 && total > 0;

        return (
          <div key={`${p.venue}_${p.year}`} className={`progress-item ${isComplete ? "progress-item-complete" : ""}`}>
            <div className="progress-item-header">
              <span className="progress-venue">
                <span
                  className="progress-venue-dot"
                  style={{ background: VENUE_COLORS[p.venue] || "#6c5ce7" }}
                />
                {p.venue} {p.year}
                {isComplete && <span className="progress-complete-label">完了</span>}
              </span>
              <span className="progress-count">
                {seenCount}/{total} ({savedCount}保存)
              </span>
            </div>
            <div className="progress-bar-track">
              <div
                className={`progress-bar-fill ${isComplete ? "complete" : ""}`}
                style={{ width: `${pct}%` }}
              />
            </div>
            {!isComplete && remaining > 0 && (
              <button
                className="btn btn-sm btn-ghost"
                onClick={() => onResume(p.venue, p.year)}
              >
                続きから (あと{remaining}件)
              </button>
            )}
          </div>
        );
      })}
    </div>
  );
}
