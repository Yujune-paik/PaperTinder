import { useState, useEffect, useRef, useCallback } from "react";

const TARGETS = [
  { venue: "CHI",         years: [2022, 2023, 2024, 2025, 2026] },
  { venue: "UIST",        years: [2022, 2023, 2024, 2025, 2026] },
  { venue: "NeurIPS",     years: [2022, 2023, 2024, 2025, 2026] },
  { venue: "Ubicomp",     years: [2022, 2023, 2024, 2025, 2026] },
  { venue: "CVPR",        years: [2022, 2023, 2024, 2025, 2026] },
  { venue: "CSCW",        years: [2022, 2023, 2024, 2025, 2026] },
  { venue: "SIGGRAPH",    years: [2022, 2023, 2024, 2025, 2026] },
  { venue: "ICCV",        years: [2023, 2025] },
  { venue: "ECCV",        years: [2022, 2024] },
  { venue: "DIS",         years: [2022, 2023, 2024, 2025] },
  { venue: "TEI",         years: [2022, 2023, 2024, 2025] },
  { venue: "MobileHCI",   years: [2022, 2023, 2024, 2025] },
  { venue: "AAAI",        years: [2022, 2023, 2024, 2025, 2026] },
  { venue: "ISEA",        years: [2022, 2023, 2024, 2025] },
  { venue: "NIME",        years: [2022, 2023, 2024, 2025] },
  { venue: "IPSJ",        years: [2022, 2023, 2024, 2025] },
  { venue: "WISS",        years: [2022, 2023, 2024, 2025] },
  { venue: "Interaction", years: [2022, 2023, 2024, 2025] },
];

const FILTER_OPTIONS = [
  { key: "all",        label: "すべて" },
  { key: "no_figures", label: "画像なし" },
  { key: "no_summary", label: "要約なし" },
];

export default function AdminPage() {
  const [view, setView] = useState("decks");
  const [decks, setDecks] = useState([]);
  const [loadingDecks, setLoadingDecks] = useState(true);

  const [activeDeck, setActiveDeck] = useState(null);
  const [cards, setCards] = useState([]);
  const [loadingCards, setLoadingCards] = useState(false);
  const [filter, setFilter] = useState("all");

  const [buildVenue, setBuildVenue] = useState(null);
  const [buildYear, setBuildYear] = useState(null);
  const [buildPhase, setBuildPhase] = useState(null);
  const [buildLog, setBuildLog] = useState([]);
  const [buildProgress, setBuildProgress] = useState({ current: 0, total: 0 });
  const abortRef = useRef(null);

  const [uploading, setUploading] = useState({});
  const [editCard, setEditCard] = useState(null);

  const fetchDecks = useCallback(async () => {
    setLoadingDecks(true);
    try {
      const res = await fetch("/api/decks");
      const data = await res.json();
      setDecks(data.decks || []);
    } catch { /* ignore */ }
    setLoadingDecks(false);
  }, []);

  useEffect(() => { fetchDecks(); }, [fetchDecks]);

  const deckMap = {};
  decks.forEach((d) => { deckMap[`${d.venue}_${d.year}`] = d; });

  const openDeck = async (venue, year) => {
    setView("cards");
    setActiveDeck({ venue, year });
    setLoadingCards(true);
    setFilter("all");
    try {
      const res = await fetch(`/api/decks/${encodeURIComponent(venue)}/${year}`);
      if (!res.ok) { setCards([]); return; }
      const data = await res.json();
      setCards(data.cards || []);
    } catch { setCards([]); }
    setLoadingCards(false);
  };

  const goBack = () => {
    setView("decks");
    setActiveDeck(null);
    setCards([]);
    setEditCard(null);
    fetchDecks();
  };

  const filteredCards = cards.filter((c) => {
    if (filter === "no_figures") return !c.has_figures;
    if (filter === "no_summary") return !c.has_summary;
    return true;
  });

  // --- Build ---
  const startBuild = async (venue, year) => {
    setBuildVenue(venue);
    setBuildYear(year);
    setBuildPhase("search");
    setBuildLog([]);
    setBuildProgress({ current: 0, total: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      const res = await fetch("/api/admin/prebuild", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venues: [venue], year, limit: 9999 }),
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
              setBuildPhase(data.phase);
              if (data.total) setBuildProgress((p) => ({ ...p, total: data.total }));
            } else if (data.type === "progress") {
              setBuildProgress({ current: data.current, total: data.total });
              const status = data.has_figures ? "OK" : "NO IMG";
              setBuildLog((prev) => [...prev.slice(-150),
                `[${data.current}/${data.total}] ${status} | ${data.title}`]);
            } else if (data.type === "done") {
              setBuildPhase("done");
              setBuildLog((prev) => [...prev,
                `--- 完了: 画像なし ${(data.missing_figures || []).length}件, エラー ${(data.errors || []).length}件 ---`]);
              fetchDecks();
            }
          } catch { /* ignore */ }
        }
      }
    } catch (e) {
      if (e.name !== "AbortError") {
        setBuildLog((prev) => [...prev, `ERROR: ${e.message}`]);
      }
      setBuildPhase("done");
    }
  };

  const stopBuild = () => {
    abortRef.current?.abort();
    setBuildPhase("done");
  };

  const closeBuild = () => {
    setBuildVenue(null);
    setBuildYear(null);
    setBuildPhase(null);
    setBuildLog([]);
  };

  // --- Upload ---
  const handleUpload = async (paperId, file) => {
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
      setCards((prev) => prev.map((c) =>
        c.paper_id === paperId
          ? { ...c, figure_urls: [...(c.figure_urls || []), data.url], has_figures: true }
          : c
      ));
    } catch { /* ignore */ }
    setUploading((prev) => ({ ...prev, [paperId]: false }));
  };

  const buildPct = buildProgress.total > 0
    ? Math.round((buildProgress.current / buildProgress.total) * 100) : 0;

  // ======================
  // RENDER
  // ======================

  if (buildPhase && buildPhase !== "done") {
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <h1 style={S.logo}>PaperTinder Admin</h1>
        </div>
        <section style={S.card}>
          <h2 style={S.cardTitle}>
            ビルド中: {buildVenue} {buildYear}
          </h2>
          <div style={S.progressOuter}>
            <div style={{ ...S.progressInner, width: `${buildPct}%` }} />
            <span style={S.progressText}>
              {buildProgress.current}/{buildProgress.total} ({buildPct}%)
            </span>
          </div>
          <pre style={S.log}>{buildLog.join("\n") || "開始中..."}</pre>
          <button onClick={stopBuild} style={S.dangerBtn}>停止</button>
        </section>
      </div>
    );
  }

  if (buildPhase === "done") {
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <h1 style={S.logo}>PaperTinder Admin</h1>
        </div>
        <section style={S.card}>
          <h2 style={S.cardTitle}>
            ビルド完了: {buildVenue} {buildYear}
          </h2>
          <pre style={S.log}>{buildLog.join("\n")}</pre>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button onClick={() => { closeBuild(); openDeck(buildVenue, buildYear); }} style={S.primaryBtn}>
              カードを確認
            </button>
            <button onClick={closeBuild} style={S.ghostBtn}>戻る</button>
          </div>
        </section>
      </div>
    );
  }

  // --- Card detail modal ---
  if (editCard) {
    const c = editCard;
    const summaryEntries = c.summary ? Object.entries(c.summary).filter(([, v]) => v) : [];
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <button onClick={() => setEditCard(null)} style={S.backBtn}>&larr; 戻る</button>
          <h1 style={S.logo}>カード詳細</h1>
        </div>
        <section style={S.card}>
          <div style={S.detailHeader}>
            <span style={S.badge}>{c.venue} {c.year}</span>
            {!c.has_figures && <span style={S.badgeDanger}>画像なし</span>}
            {!c.has_summary && <span style={S.badgeWarn}>要約なし</span>}
          </div>
          <h2 style={{ ...S.cardTitle, fontSize: "1.1rem" }}>{c.title}</h2>
          <div style={S.detailAuthors}>
            {(c.authors || []).slice(0, 5).join(", ")}
            {(c.authors || []).length > 5 && " et al."}
          </div>

          {/* Figures */}
          <div style={S.detailSection}>
            <h3 style={S.detailLabel}>画像</h3>
            {(c.figure_urls || []).length > 0 ? (
              <div style={S.figGrid}>
                {c.figure_urls.map((url, i) => (
                  <img key={i} src={url} alt={`fig${i}`} style={S.figImg} />
                ))}
              </div>
            ) : (
              <p style={S.dimText}>画像がありません</p>
            )}
            <label style={S.uploadLabel}>
              <input
                type="file"
                accept="image/*"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) handleUpload(c.paper_id, f).then(() => {
                    openDeck(activeDeck.venue, activeDeck.year).then(() => {
                      const updated = cards.find((x) => x.paper_id === c.paper_id);
                      if (updated) setEditCard(updated);
                    });
                  });
                }}
              />
              <span style={S.uploadBtn}>
                {uploading[c.paper_id] ? "アップロード中..." : "画像を追加"}
              </span>
            </label>
          </div>

          {/* Summary */}
          <div style={S.detailSection}>
            <h3 style={S.detailLabel}>要約</h3>
            {summaryEntries.length > 0 ? (
              summaryEntries.map(([key, val]) => (
                <div key={key} style={S.summaryBlock}>
                  <div style={S.summaryKey}>{key}</div>
                  <div style={S.summaryVal}>{val}</div>
                </div>
              ))
            ) : (
              <p style={S.dimText}>要約がありません</p>
            )}
          </div>

          {c.abstract && (
            <div style={S.detailSection}>
              <h3 style={S.detailLabel}>Abstract</h3>
              <p style={S.abstractText}>{c.abstract}</p>
            </div>
          )}
        </section>
      </div>
    );
  }

  // --- Cards view ---
  if (view === "cards" && activeDeck) {
    const noFigCount = cards.filter((c) => !c.has_figures).length;
    const noSumCount = cards.filter((c) => !c.has_summary).length;
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <button onClick={goBack} style={S.backBtn}>&larr; デッキ一覧</button>
          <h1 style={S.logo}>{activeDeck.venue} {activeDeck.year}</h1>
          <span style={S.countBadge}>{cards.length} cards</span>
        </div>

        {/* Stats */}
        <div style={S.statsRow}>
          <div style={S.statBox}>
            <div style={S.statNum}>{cards.length}</div>
            <div style={S.statLabel}>合計</div>
          </div>
          <div style={{ ...S.statBox, ...(noFigCount > 0 ? S.statBoxDanger : {}) }}>
            <div style={S.statNum}>{noFigCount}</div>
            <div style={S.statLabel}>画像なし</div>
          </div>
          <div style={{ ...S.statBox, ...(noSumCount > 0 ? S.statBoxWarn : {}) }}>
            <div style={S.statNum}>{noSumCount}</div>
            <div style={S.statLabel}>要約なし</div>
          </div>
        </div>

        {/* Filter tabs */}
        <div style={S.filterRow}>
          {FILTER_OPTIONS.map((f) => (
            <button
              key={f.key}
              onClick={() => setFilter(f.key)}
              style={{
                ...S.filterBtn,
                ...(filter === f.key ? S.filterBtnActive : {}),
              }}
            >
              {f.label}
              {f.key === "no_figures" && noFigCount > 0 && (
                <span style={S.filterCount}>{noFigCount}</span>
              )}
              {f.key === "no_summary" && noSumCount > 0 && (
                <span style={S.filterCount}>{noSumCount}</span>
              )}
            </button>
          ))}
        </div>

        {/* Card list */}
        {loadingCards ? (
          <div style={S.emptyState}>読み込み中...</div>
        ) : filteredCards.length === 0 ? (
          <div style={S.emptyState}>
            {filter === "all" ? "カードがありません" : "該当なし"}
          </div>
        ) : (
          <div style={S.cardList}>
            {filteredCards.map((c) => (
              <div
                key={c.paper_id}
                style={S.cardItem}
                onClick={() => setEditCard(c)}
              >
                <div style={S.cardThumb}>
                  {(c.figure_urls || []).length > 0 ? (
                    <img src={c.figure_urls[0]} alt="" style={S.thumbImg} />
                  ) : (
                    <div style={S.thumbEmpty}>No Image</div>
                  )}
                </div>
                <div style={S.cardInfo}>
                  <div style={S.cardItemTitle}>{c.title}</div>
                  <div style={S.cardItemMeta}>
                    {(c.authors || []).slice(0, 2).join(", ")}
                    {(c.authors || []).length > 2 && " et al."}
                  </div>
                  <div style={S.cardBadges}>
                    {!c.has_figures && <span style={S.badgeDanger}>画像なし</span>}
                    {!c.has_summary && <span style={S.badgeWarn}>要約なし</span>}
                    {c.has_figures && c.has_summary && <span style={S.badgeOk}>OK</span>}
                  </div>
                </div>
                <label
                  style={S.cardUploadArea}
                  onClick={(e) => e.stopPropagation()}
                >
                  <input
                    type="file"
                    accept="image/*"
                    style={{ display: "none" }}
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) handleUpload(c.paper_id, f);
                    }}
                  />
                  <span style={S.cardUploadBtn}>
                    {uploading[c.paper_id] ? "..." : "+"}
                  </span>
                </label>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  }

  // --- Decks overview ---
  return (
    <div style={S.container}>
      <div style={S.topBar}>
        <h1 style={S.logo}>PaperTinder Admin</h1>
        <span style={S.dimText}>カード管理ダッシュボード</span>
      </div>

      {loadingDecks ? (
        <div style={S.emptyState}>読み込み中...</div>
      ) : (
        <div style={S.deckGrid}>
          {TARGETS.map((t) =>
            t.years.map((year) => {
              const key = `${t.venue}_${year}`;
              const deck = deckMap[key];
              const built = !!deck;
              return (
                <div
                  key={key}
                  style={{
                    ...S.deckCard,
                    ...(built ? {} : S.deckCardUnbuilt),
                  }}
                >
                  <div style={S.deckHeader}>
                    <span style={S.deckVenue}>{t.venue}</span>
                    <span style={S.deckYear}>{year}</span>
                  </div>
                  {built ? (
                    <>
                      <div style={S.deckStats}>
                        <span>{deck.count} cards</span>
                        {deck.missing_figures > 0 && (
                          <span style={S.deckWarn}>{deck.missing_figures} no img</span>
                        )}
                        {deck.missing_summary > 0 && (
                          <span style={S.deckWarnSoft}>{deck.missing_summary} no sum</span>
                        )}
                      </div>
                      <div style={S.deckActions}>
                        <button
                          onClick={() => openDeck(t.venue, year)}
                          style={S.smallBtn}
                        >
                          カード管理
                        </button>
                        <button
                          onClick={() => startBuild(t.venue, year)}
                          style={S.smallBtnGhost}
                        >
                          再ビルド
                        </button>
                      </div>
                    </>
                  ) : (
                    <div style={S.deckActions}>
                      <button
                        onClick={() => startBuild(t.venue, year)}
                        style={S.smallBtnPrimary}
                      >
                        ビルド
                      </button>
                    </div>
                  )}
                </div>
              );
            })
          )}
        </div>
      )}
    </div>
  );
}

// ============================================================
// Styles
// ============================================================
const S = {
  container: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "20px 16px 40px",
    fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
    color: "#e2e8f0",
    background: "#0f172a",
    minHeight: "100vh",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    marginBottom: 24,
    flexWrap: "wrap",
  },
  logo: { fontSize: "1.3rem", fontWeight: 700, margin: 0 },
  backBtn: {
    background: "none",
    border: "1px solid #334155",
    color: "#94a3b8",
    padding: "6px 12px",
    borderRadius: 8,
    cursor: "pointer",
    fontSize: "0.85rem",
  },
  countBadge: {
    background: "#1e293b",
    padding: "4px 10px",
    borderRadius: 12,
    fontSize: "0.8rem",
    color: "#94a3b8",
  },
  dimText: { color: "#64748b", fontSize: "0.85rem" },

  // Deck grid
  deckGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  },
  deckCard: {
    background: "#1e293b",
    borderRadius: 12,
    padding: 14,
    border: "1px solid rgba(255,255,255,0.06)",
    display: "flex",
    flexDirection: "column",
    gap: 8,
  },
  deckCardUnbuilt: {
    opacity: 0.6,
    borderStyle: "dashed",
  },
  deckHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  deckVenue: { fontWeight: 700, fontSize: "0.95rem" },
  deckYear: { color: "#94a3b8", fontSize: "0.85rem" },
  deckStats: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    fontSize: "0.75rem",
    color: "#94a3b8",
  },
  deckWarn: { color: "#f87171", fontWeight: 600 },
  deckWarnSoft: { color: "#fbbf24" },
  deckActions: { display: "flex", gap: 6, marginTop: 4 },

  // Buttons
  smallBtn: {
    padding: "5px 10px",
    borderRadius: 6,
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#e2e8f0",
    cursor: "pointer",
    fontSize: "0.78rem",
    fontWeight: 500,
  },
  smallBtnGhost: {
    padding: "5px 10px",
    borderRadius: 6,
    border: "1px solid #334155",
    background: "transparent",
    color: "#64748b",
    cursor: "pointer",
    fontSize: "0.78rem",
  },
  smallBtnPrimary: {
    padding: "5px 14px",
    borderRadius: 6,
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    cursor: "pointer",
    fontSize: "0.78rem",
    fontWeight: 600,
  },
  primaryBtn: {
    padding: "8px 18px",
    borderRadius: 8,
    border: "none",
    background: "#3b82f6",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
    fontSize: "0.9rem",
  },
  ghostBtn: {
    padding: "8px 18px",
    borderRadius: 8,
    border: "1px solid #334155",
    background: "transparent",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.9rem",
  },
  dangerBtn: {
    padding: "8px 18px",
    borderRadius: 8,
    border: "none",
    background: "#ef4444",
    color: "#fff",
    fontWeight: 600,
    cursor: "pointer",
    marginTop: 12,
  },

  // Stats row
  statsRow: { display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" },
  statBox: {
    flex: 1,
    minWidth: 90,
    background: "#1e293b",
    borderRadius: 10,
    padding: "12px 14px",
    textAlign: "center",
    border: "1px solid rgba(255,255,255,0.06)",
  },
  statBoxDanger: { borderColor: "#f87171" },
  statBoxWarn: { borderColor: "#fbbf24" },
  statNum: { fontSize: "1.4rem", fontWeight: 700 },
  statLabel: { fontSize: "0.75rem", color: "#94a3b8", marginTop: 2 },

  // Filter
  filterRow: { display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" },
  filterBtn: {
    padding: "6px 12px",
    borderRadius: 8,
    border: "1px solid #334155",
    background: "#0f172a",
    color: "#94a3b8",
    cursor: "pointer",
    fontSize: "0.82rem",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  filterBtnActive: {
    background: "#3b82f6",
    color: "#fff",
    borderColor: "#3b82f6",
  },
  filterCount: {
    background: "rgba(255,255,255,0.2)",
    borderRadius: 10,
    padding: "1px 6px",
    fontSize: "0.72rem",
    fontWeight: 600,
  },

  // Card list
  cardList: { display: "flex", flexDirection: "column", gap: 6 },
  cardItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    background: "#1e293b",
    borderRadius: 10,
    border: "1px solid rgba(255,255,255,0.06)",
    cursor: "pointer",
    transition: "background 0.15s",
  },
  cardThumb: {
    width: 64,
    height: 64,
    borderRadius: 8,
    overflow: "hidden",
    flexShrink: 0,
    background: "#0f172a",
  },
  thumbImg: {
    width: "100%",
    height: "100%",
    objectFit: "cover",
  },
  thumbEmpty: {
    width: "100%",
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.65rem",
    color: "#475569",
  },
  cardInfo: { flex: 1, minWidth: 0 },
  cardItemTitle: {
    fontSize: "0.85rem",
    fontWeight: 600,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  cardItemMeta: {
    fontSize: "0.72rem",
    color: "#64748b",
    marginTop: 2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
  },
  cardBadges: { display: "flex", gap: 4, marginTop: 4 },
  cardUploadArea: { flexShrink: 0, cursor: "pointer" },
  cardUploadBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 36,
    height: 36,
    borderRadius: 8,
    background: "#334155",
    color: "#e2e8f0",
    fontSize: "1.1rem",
    fontWeight: 700,
  },

  // Badges
  badge: {
    display: "inline-block",
    padding: "3px 8px",
    borderRadius: 6,
    background: "#334155",
    color: "#e2e8f0",
    fontSize: "0.75rem",
    fontWeight: 600,
  },
  badgeDanger: {
    display: "inline-block",
    padding: "2px 7px",
    borderRadius: 6,
    background: "rgba(248,113,113,0.15)",
    color: "#f87171",
    fontSize: "0.7rem",
    fontWeight: 600,
  },
  badgeWarn: {
    display: "inline-block",
    padding: "2px 7px",
    borderRadius: 6,
    background: "rgba(251,191,36,0.15)",
    color: "#fbbf24",
    fontSize: "0.7rem",
    fontWeight: 600,
  },
  badgeOk: {
    display: "inline-block",
    padding: "2px 7px",
    borderRadius: 6,
    background: "rgba(52,211,153,0.15)",
    color: "#34d399",
    fontSize: "0.7rem",
    fontWeight: 600,
  },

  // Cards section / detail
  card: {
    background: "#1e293b",
    borderRadius: 12,
    padding: 18,
    border: "1px solid rgba(255,255,255,0.06)",
  },
  cardTitle: { fontSize: "1rem", fontWeight: 600, margin: "0 0 8px" },

  // Build
  progressOuter: {
    height: 26,
    background: "#0f172a",
    borderRadius: 8,
    overflow: "hidden",
    position: "relative",
    marginBottom: 12,
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
    fontSize: "0.78rem",
    fontWeight: 600,
    color: "#fff",
  },
  log: {
    background: "#0f172a",
    padding: 12,
    borderRadius: 8,
    fontSize: "0.72rem",
    lineHeight: 1.6,
    maxHeight: 300,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    color: "#94a3b8",
    border: "1px solid rgba(255,255,255,0.04)",
  },

  emptyState: {
    textAlign: "center",
    color: "#64748b",
    padding: 40,
    fontSize: "0.9rem",
  },

  // Detail view
  detailHeader: { display: "flex", gap: 8, marginBottom: 8 },
  detailAuthors: { fontSize: "0.8rem", color: "#64748b", marginBottom: 16 },
  detailSection: { marginTop: 20 },
  detailLabel: { fontSize: "0.85rem", fontWeight: 600, color: "#94a3b8", marginBottom: 8 },
  figGrid: {
    display: "flex",
    gap: 8,
    flexWrap: "wrap",
    marginBottom: 10,
  },
  figImg: {
    maxWidth: 280,
    maxHeight: 200,
    borderRadius: 8,
    objectFit: "contain",
    background: "#0f172a",
    border: "1px solid #334155",
  },
  uploadLabel: { cursor: "pointer", display: "inline-block" },
  uploadBtn: {
    display: "inline-block",
    padding: "6px 14px",
    borderRadius: 8,
    background: "#334155",
    color: "#e2e8f0",
    fontSize: "0.82rem",
    cursor: "pointer",
    fontWeight: 500,
  },
  summaryBlock: { marginBottom: 10 },
  summaryKey: { fontSize: "0.75rem", fontWeight: 600, color: "#6366f1", marginBottom: 2 },
  summaryVal: { fontSize: "0.82rem", color: "#cbd5e1", lineHeight: 1.5 },
  abstractText: { fontSize: "0.82rem", color: "#94a3b8", lineHeight: 1.6 },
};
