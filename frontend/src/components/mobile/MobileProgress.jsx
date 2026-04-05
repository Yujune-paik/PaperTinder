import { motion } from "framer-motion";

const VENUE_COLORS = {
  CHI: "#e74c3c", UIST: "#3498db", CSCW: "#2ecc71", Ubicomp: "#e67e22",
  ISWC: "#9b59b6", HRI: "#1abc9c", ISS: "#f39c12", DIS: "#e84393",
  TEI: "#00cec9", MobileHCI: "#6c5ce7", NeurIPS: "#fd79a8", CVPR: "#0984e3",
  ICCV: "#00b894", ICML: "#d63031", ECCV: "#fdcb6e", AAAI: "#a29bfe",
  SIGGRAPH: "#fab1a0", "SIGGRAPH Asia": "#ff7675",
  Nature: "#2d3436", Science: "#636e72", "Science Robotics": "#b2bec3",
};

export default function MobileProgress({ progress, onResume }) {
  const active = (progress || []).filter((p) => p.seen && p.seen.length > 0);
  const completed = active.filter(
    (p) => p.total > 0 && (p.seen?.length || 0) >= p.total
  );

  if (active.length === 0) {
    return (
      <div className="m-progress">
        <div className="m-progress-empty">
          <div className="m-empty-icon">&#128202;</div>
          <p>まだ進捗データがありません</p>
          <p className="m-saved-hint">検索して論文をスワイプすると進捗が記録されます</p>
        </div>
      </div>
    );
  }

  return (
    <div className="m-progress">
      {completed.length > 0 && (
        <div className="m-progress-section">
          <h3 className="m-progress-heading">&#127942; コンプリート</h3>
          <div className="m-badges-grid">
            {completed.map((p) => {
              const color = VENUE_COLORS[p.venue] || "#6c5ce7";
              return (
                <motion.div
                  key={`${p.venue}_${p.year}`}
                  className="m-badge"
                  initial={{ scale: 0 }}
                  animate={{ scale: 1 }}
                  transition={{ type: "spring", stiffness: 200, damping: 15 }}
                >
                  <div
                    className="m-badge-icon"
                    style={{ borderColor: color, color: "#fff", background: color }}
                  >
                    {p.venue.slice(0, 3).toUpperCase()}
                  </div>
                  <span className="m-badge-check">&#10003;</span>
                  <span className="m-badge-year">{p.year}</span>
                </motion.div>
              );
            })}
          </div>
        </div>
      )}

      <div className="m-progress-section">
        <h3 className="m-progress-heading">&#128202; 進捗</h3>
        <div className="m-progress-list">
          {active.map((p) => {
            const seenCount = p.seen?.length || 0;
            const total = Math.max(p.total || 0, seenCount);
            const savedCount = p.saved?.length || 0;
            const pct = total > 0 ? Math.round((seenCount / total) * 100) : 0;
            const remaining = Math.max(0, total - seenCount);
            const isComplete = remaining === 0 && total > 0;
            const color = VENUE_COLORS[p.venue] || "#6c5ce7";

            return (
              <div
                key={`${p.venue}_${p.year}`}
                className={`m-progress-card ${isComplete ? "m-progress-card-done" : ""}`}
              >
                <div className="m-progress-card-top">
                  <span className="m-progress-venue">
                    <span className="m-progress-dot" style={{ background: color }} />
                    {p.venue} {p.year}
                    {isComplete && <span className="m-progress-complete">完了</span>}
                  </span>
                  <span className="m-progress-count">
                    {seenCount}/{total} ({savedCount}保存)
                  </span>
                </div>
                <div className="m-progress-bar-track">
                  <div
                    className={`m-progress-bar-fill ${isComplete ? "m-bar-complete" : ""}`}
                    style={{ width: `${pct}%` }}
                  />
                </div>
                {!isComplete && remaining > 0 && (
                  <button
                    className="m-progress-resume"
                    onClick={() => onResume(p.venue, p.year)}
                  >
                    続きから (あと{remaining}件)
                  </button>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
