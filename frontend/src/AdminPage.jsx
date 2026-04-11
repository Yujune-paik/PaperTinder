import { useState, useRef, useCallback } from "react";

const VENUES = [
  "CHI", "UIST", "CSCW", "Ubicomp", "ISWC", "HRI", "ISS",
  "CVPR", "NeurIPS", "ICCV", "ICML", "ECCV",
  "Nature", "Science", "Science Robotics",
];

const THIS_YEAR = new Date().getFullYear();

export default function AdminPage() {
  const [selectedVenues, setSelectedVenues] = useState([]);
  const [year, setYear] = useState(2024);
  const [phase, setPhase] = useState("idle"); // idle | search | build | done
  const [log, setLog] = useState([]);
  const [progress, setProgress] = useState({ current: 0, total: 0 });
  const [missingFigures, setMissingFigures] = useState([]);
  const [errors, setErrors] = useState([]);
  const [uploading, setUploading] = useState({});
  const abortRef = useRef(null);

  const toggleVenue = (v) => {
    setSelectedVenues((prev) =>
      prev.includes(v) ? prev.filter((x) => x !== v) : [...prev, v]
    );
  };

  const addLog = useCallback((msg) => {
    setLog((prev) => [...prev.slice(-200), msg]);
  }, []);

  const startPrebuild = async () => {
    if (selectedVenues.length === 0) return;
    setPhase("search");
    setLog([]);
    setMissingFigures([]);
    setErrors([]);
    setProgress({ current: 0, total: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/admin/prebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venues: selectedVenues, year }),
        signal: controller.signal,
      });

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const lines = buffer.split("\n");
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));

            if (data.type === "phase") {
              setPhase(data.phase);
              if (data.total) setProgress((p) => ({ ...p, total: data.total }));
              addLog(`--- Phase: ${data.phase} ${data.total ? `(${data.total} papers)` : ""} ---`);
            } else if (data.type === "venue_done") {
              addLog(`  ${data.venue}: ${data.count} papers found`);
            } else if (data.type === "progress") {
              setProgress({ current: data.current, total: data.total });
              const fig = data.has_figures ? `figs:${data.figures_count}` : "NO FIGS";
              const sum = data.has_summary ? "sum:OK" : "NO SUM";
              addLog(`[${data.current}/${data.total}] ${data.status} | ${fig} | ${sum} | ${data.title}`);
            } else if (data.type === "done") {
              setPhase("done");
              setMissingFigures(data.missing_figures || []);
              setErrors(data.errors || []);
              addLog(`--- Done! Missing figures: ${(data.missing_figures || []).length}, Errors: ${(data.errors || []).length} ---`);
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        addLog(`ERROR: ${e.message}`);
        setPhase("done");
      }
    }
  };

  const stopPrebuild = () => {
    abortRef.current?.abort();
    setPhase("done");
    addLog("--- Cancelled by user ---");
  };

  const handleUploadFigure = async (paperId, file) => {
    setUploading((prev) => ({ ...prev, [paperId]: true }));
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/admin/figures/${encodeURIComponent(paperId)}`, {
        method: "POST",
        body: formData,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      addLog(`Uploaded figure for ${paperId}: ${data.url}`);
      setMissingFigures((prev) => prev.filter((p) => p.paper_id !== paperId));
    } catch (e) {
      addLog(`Upload failed for ${paperId}: ${e.message}`);
    } finally {
      setUploading((prev) => ({ ...prev, [paperId]: false }));
    }
  };

  const pct = progress.total > 0 ? Math.round((progress.current / progress.total) * 100) : 0;

  return (
    <div style={styles.container}>
      <h1 style={styles.h1}>PaperTinder Admin</h1>

      {/* Venue selector */}
      <section style={styles.section}>
        <h2 style={styles.h2}>1. Select Venues & Year</h2>
        <div style={styles.venueGrid}>
          {VENUES.map((v) => (
            <button
              key={v}
              onClick={() => toggleVenue(v)}
              style={{
                ...styles.venueBtn,
                ...(selectedVenues.includes(v) ? styles.venueBtnActive : {}),
              }}
            >
              {v}
            </button>
          ))}
        </div>
        <div style={styles.yearRow}>
          <label>Year: </label>
          <select value={year} onChange={(e) => setYear(Number(e.target.value))} style={styles.select}>
            {Array.from({ length: THIS_YEAR - 2018 + 1 }, (_, i) => THIS_YEAR - i).map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>
      </section>

      {/* Controls */}
      <section style={styles.section}>
        <h2 style={styles.h2}>2. Pre-build Cards</h2>
        <div style={styles.controls}>
          {phase === "idle" || phase === "done" ? (
            <button
              onClick={startPrebuild}
              disabled={selectedVenues.length === 0}
              style={{
                ...styles.primaryBtn,
                ...(selectedVenues.length === 0 ? styles.disabledBtn : {}),
              }}
            >
              Start Pre-build ({selectedVenues.length} venues, {year})
            </button>
          ) : (
            <button onClick={stopPrebuild} style={styles.stopBtn}>
              Stop
            </button>
          )}
        </div>

        {/* Progress bar */}
        {(phase === "build" || phase === "done") && progress.total > 0 && (
          <div style={styles.progressOuter}>
            <div style={{ ...styles.progressInner, width: `${pct}%` }} />
            <span style={styles.progressText}>
              {progress.current}/{progress.total} ({pct}%)
            </span>
          </div>
        )}
        {phase === "search" && (
          <div style={styles.statusText}>Searching papers...</div>
        )}
      </section>

      {/* Log */}
      <section style={styles.section}>
        <h2 style={styles.h2}>Log</h2>
        <pre style={styles.log}>
          {log.length === 0 ? "(no activity yet)" : log.join("\n")}
        </pre>
      </section>

      {/* Missing figures */}
      {missingFigures.length > 0 && (
        <section style={styles.section}>
          <h2 style={styles.h2}>
            3. Missing Figures ({missingFigures.length})
          </h2>
          <p style={styles.hint}>
            These papers have no figure. Upload an image for each, or leave as-is.
          </p>
          <div style={styles.missingList}>
            {missingFigures.map((p) => (
              <div key={p.paper_id} style={styles.missingItem}>
                <div style={styles.missingTitle}>{p.title}</div>
                <div style={styles.missingId}>{p.paper_id}</div>
                <label style={styles.uploadLabel}>
                  {uploading[p.paper_id] ? (
                    "Uploading..."
                  ) : (
                    <>
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) handleUploadFigure(p.paper_id, f);
                        }}
                      />
                      <span style={styles.uploadBtn}>Upload Image</span>
                    </>
                  )}
                </label>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <section style={styles.section}>
          <h2 style={{ ...styles.h2, color: "#f87171" }}>
            Errors ({errors.length})
          </h2>
          <ul style={styles.errorList}>
            {errors.map((e, i) => (
              <li key={i}>
                <strong>{e.title}</strong>: {e.error}
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

const styles = {
  container: {
    maxWidth: 900,
    margin: "0 auto",
    padding: "24px 16px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    color: "#e2e8f0",
    background: "#0f172a",
    minHeight: "100vh",
  },
  h1: { fontSize: "1.5rem", fontWeight: 700, marginBottom: 24 },
  h2: { fontSize: "1.1rem", fontWeight: 600, marginBottom: 12, color: "#94a3b8" },
  section: {
    marginBottom: 28,
    padding: 16,
    background: "#1e293b",
    borderRadius: 12,
    border: "1px solid rgba(255,255,255,0.06)",
  },
  venueGrid: { display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 12 },
  venueBtn: {
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  venueBtnActive: {
    background: "#3b82f6",
    color: "#fff",
    borderColor: "#3b82f6",
  },
  yearRow: { display: "flex", alignItems: "center", gap: 8, marginTop: 8 },
  select: {
    padding: "4px 8px",
    borderRadius: 6,
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#e2e8f0",
  },
  controls: { display: "flex", gap: 8 },
  primaryBtn: {
    padding: "10px 20px",
    borderRadius: 8,
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.95rem",
  },
  disabledBtn: { opacity: 0.4, cursor: "not-allowed" },
  stopBtn: {
    padding: "10px 20px",
    borderRadius: 8,
    border: "none",
    background: "#ef4444",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
  },
  progressOuter: {
    marginTop: 12,
    height: 28,
    background: "#0f172a",
    borderRadius: 8,
    overflow: "hidden",
    position: "relative",
  },
  progressInner: {
    height: "100%",
    background: "linear-gradient(90deg, #3b82f6, #6366f1)",
    borderRadius: 8,
    transition: "width 0.3s ease",
  },
  progressText: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.8rem",
    fontWeight: 600,
    color: "#fff",
  },
  statusText: { marginTop: 8, color: "#94a3b8", fontSize: "0.9rem" },
  log: {
    background: "#0f172a",
    padding: 12,
    borderRadius: 8,
    fontSize: "0.75rem",
    lineHeight: 1.6,
    maxHeight: 320,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    color: "#94a3b8",
    border: "1px solid #1e293b",
  },
  hint: { fontSize: "0.85rem", color: "#94a3b8", marginBottom: 12 },
  missingList: { display: "flex", flexDirection: "column", gap: 8 },
  missingItem: {
    padding: "10px 12px",
    background: "#0f172a",
    borderRadius: 8,
    border: "1px solid #334155",
  },
  missingTitle: { fontWeight: 600, fontSize: "0.9rem", marginBottom: 4 },
  missingId: { fontSize: "0.75rem", color: "#64748b", marginBottom: 6 },
  uploadLabel: { cursor: "pointer" },
  uploadBtn: {
    display: "inline-block",
    padding: "4px 12px",
    borderRadius: 6,
    background: "#334155",
    color: "#e2e8f0",
    fontSize: "0.8rem",
    cursor: "pointer",
  },
  errorList: {
    fontSize: "0.85rem",
    color: "#f87171",
    paddingLeft: 20,
    lineHeight: 1.6,
  },
};
