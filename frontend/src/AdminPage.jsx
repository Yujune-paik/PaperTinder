import { useState, useEffect, useRef, useCallback } from "react";
import { useAuth } from "./AuthContext";
import LoginButton from "./components/LoginButton";

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
  const { user, isAdmin, ready: authReady, enabled: authEnabled } = useAuth();

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

  useEffect(() => {
    if (!authReady) return;
    if (!isAdmin) { setLoadingDecks(false); return; }
    fetchDecks();
  }, [authReady, isAdmin, fetchDecks]);

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

  // --- Build (resumable / chunked, fits Vercel's 60s function limit) ---
  const CHUNK_SIZE = 4;

  const startBuild = async (venue, year) => {
    setBuildVenue(venue);
    setBuildYear(year);
    setBuildPhase("search");
    setBuildLog([]);
    setBuildProgress({ current: 0, total: 0 });

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Phase 1: search OpenAlex + save deck. One call.
      setBuildLog((prev) => [...prev, `→ ${venue} ${year} を OpenAlex で検索中…`]);
      const initRes = await fetch("/api/admin/prebuild/init", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ venues: [venue], year, limit: 9999 }),
        signal: controller.signal,
      });
      if (!initRes.ok) {
        const text = await initRes.text();
        throw new Error(`init failed: HTTP ${initRes.status} ${text}`);
      }
      const initData = await initRes.json();
      const total = initData.total || 0;
      setBuildProgress({ current: 0, total });
      setBuildPhase("build");
      setBuildLog((prev) => [...prev,
        `→ デッキ保存完了: ${total} 本`,
        `→ チャンク (${CHUNK_SIZE} 本/回) でビルド開始…`,
      ]);

      // Phase 2: process chunks until done.
      let offset = 0;
      let totalCached = 0;
      let totalBuilt = 0;
      let totalErrors = 0;
      let totalNoImg = 0;

      while (offset < total) {
        if (controller.signal.aborted) break;
        const q = new URLSearchParams({
          venue,
          year: String(year),
          offset: String(offset),
          limit: String(CHUNK_SIZE),
        });
        const res = await fetch(`/api/admin/prebuild/process?${q}`, {
          method: "POST",
          credentials: "include",
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new Error(`process chunk @${offset}: HTTP ${res.status} ${text}`);
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let nextOffset = offset + CHUNK_SIZE;

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
              if (data.type === "progress") {
                setBuildProgress({ current: data.current, total: data.total });
                if (data.status === "cached") totalCached++;
                else if (data.status === "built") totalBuilt++;
                else if (data.status === "error") totalErrors++;
                if (!data.has_figures && data.status !== "skipped") totalNoImg++;
                const tag =
                  data.status === "cached" ? "CACHE" :
                  data.status === "error"  ? "ERR  " :
                  data.has_figures         ? "OK   " : "NOIMG";
                setBuildLog((prev) => [...prev.slice(-200),
                  `[${data.current}/${data.total}] ${tag} | ${data.title}`]);
              } else if (data.type === "chunk_done") {
                nextOffset = data.next_offset;
              }
            } catch { /* ignore */ }
          }
        }
        offset = nextOffset;
      }

      setBuildPhase("done");
      setBuildLog((prev) => [...prev,
        `--- 完了: キャッシュ ${totalCached}, 新規ビルド ${totalBuilt}, 画像なし ${totalNoImg}, エラー ${totalErrors} ---`,
      ]);
      fetchDecks();
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

  // --- Figure ops ---
  const applyCardFigs = (paperId, urls) => {
    setCards((prev) => prev.map((c) =>
      c.paper_id === paperId
        ? { ...c, figure_urls: urls, has_figures: urls.length > 0 }
        : c
    ));
    setEditCard((ec) => (ec && ec.paper_id === paperId
      ? { ...ec, figure_urls: urls, has_figures: urls.length > 0 }
      : ec));
  };

  const handleUpload = async (paperId, file) => {
    setUploading((prev) => ({ ...prev, [paperId]: true }));
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(`/api/admin/figures/${encodeURIComponent(paperId)}`, {
        method: "POST",
        credentials: "include",
        body: formData,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      const currentUrls = cards.find((c) => c.paper_id === paperId)?.figure_urls || [];
      applyCardFigs(paperId, [...currentUrls, data.url]);
    } catch { /* ignore */ }
    setUploading((prev) => ({ ...prev, [paperId]: false }));
  };

  const handleDeleteFigure = async (paperId, index) => {
    if (!window.confirm(`この画像を削除しますか？ (${index + 1}枚目)`)) return;
    try {
      const res = await fetch(
        `/api/admin/figures/${encodeURIComponent(paperId)}/${index}`,
        { method: "DELETE", credentials: "include" },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyCardFigs(paperId, data.figure_urls || []);
    } catch { /* ignore */ }
  };

  const handleReorderFigure = async (paperId, from, to) => {
    const urls = cards.find((c) => c.paper_id === paperId)?.figure_urls || [];
    if (to < 0 || to >= urls.length) return;
    const order = urls.map((_, i) => i);
    [order[from], order[to]] = [order[to], order[from]];
    try {
      const res = await fetch(
        `/api/admin/figures/${encodeURIComponent(paperId)}/reorder`,
        {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ order }),
        },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyCardFigs(paperId, data.figure_urls || []);
    } catch { /* ignore */ }
  };

  const handleReplaceFigure = async (paperId, index, file) => {
    setUploading((prev) => ({ ...prev, [paperId]: true }));
    try {
      const formData = new FormData();
      formData.append("file", file);
      const res = await fetch(
        `/api/admin/figures/${encodeURIComponent(paperId)}/${index}`,
        { method: "PUT", credentials: "include", body: formData },
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      applyCardFigs(paperId, data.figure_urls || []);
    } catch { /* ignore */ }
    setUploading((prev) => ({ ...prev, [paperId]: false }));
  };

  // --- Summary ops ---
  const handleSaveSummary = async (paperId, summary) => {
    try {
      const res = await fetch(`/api/admin/summary/${encodeURIComponent(paperId)}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ summary }),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCards((prev) => prev.map((c) =>
        c.paper_id === paperId
          ? { ...c, summary: data.summary, has_summary: true }
          : c
      ));
      setEditCard((ec) => (ec && ec.paper_id === paperId
        ? { ...ec, summary: data.summary, has_summary: true }
        : ec));
    } catch { /* ignore */ }
  };

  const handleRebuildCard = async (paperId, opts) => {
    const label = [
      opts.summary && "要約",
      opts.figures && "画像",
    ].filter(Boolean).join(" + ");
    if (!window.confirm(`${label} を再生成しますか？ (GPT-4o を消費します)`)) return;
    setUploading((prev) => ({ ...prev, [paperId]: true }));
    try {
      const res = await fetch(`/api/admin/rebuild/${encodeURIComponent(paperId)}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify(opts),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setCards((prev) => prev.map((c) =>
        c.paper_id === paperId
          ? {
              ...c,
              figure_urls: data.figure_urls || c.figure_urls || [],
              has_figures: (data.figure_urls || []).length > 0,
              summary: data.summary || c.summary,
              has_summary: !!data.summary,
            }
          : c
      ));
      setEditCard((ec) => (ec && ec.paper_id === paperId
        ? {
            ...ec,
            figure_urls: data.figure_urls || ec.figure_urls || [],
            has_figures: (data.figure_urls || []).length > 0,
            summary: data.summary || ec.summary,
            has_summary: !!data.summary,
          }
        : ec));
    } catch { /* ignore */ }
    setUploading((prev) => ({ ...prev, [paperId]: false }));
  };

  const buildPct = buildProgress.total > 0
    ? Math.round((buildProgress.current / buildProgress.total) * 100) : 0;

  // ======================
  // RENDER
  // ======================

  // Admin gate ----------------------------------------------------------
  if (!authReady) {
    return (
      <div style={S.container}>
        <div style={S.emptyState}>読み込み中...</div>
      </div>
    );
  }

  if (!authEnabled) {
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <h1 style={S.logo}>Mekuru Admin</h1>
        </div>
        <section style={S.card}>
          <p style={S.dimText}>
            Google Sign-In が無効です。サーバに <code>GOOGLE_CLIENT_ID</code> と{" "}
            <code>ADMIN_EMAILS</code> を設定してください。
          </p>
        </section>
      </div>
    );
  }

  if (!user) {
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <h1 style={S.logo}>Mekuru Admin</h1>
        </div>
        <section style={S.card}>
          <p style={{ marginBottom: 12 }}>管理者ログインが必要です。</p>
          <LoginButton />
        </section>
      </div>
    );
  }

  if (!isAdmin) {
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <h1 style={S.logo}>Mekuru Admin</h1>
        </div>
        <section style={S.card}>
          <p>このアカウント（{user.email}）には管理権限がありません。</p>
          <p style={S.dimText}>
            管理者に連絡して <code>ADMIN_EMAILS</code> に追加してもらってください。
          </p>
        </section>
      </div>
    );
  }

  if (buildPhase && buildPhase !== "done") {
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <h1 style={S.logo}>Mekuru Admin</h1>
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
          <h1 style={S.logo}>Mekuru Admin</h1>
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
    return (
      <CardDetailEditor
        card={editCard}
        uploading={!!uploading[editCard.paper_id]}
        onBack={() => setEditCard(null)}
        onUpload={(file) => handleUpload(editCard.paper_id, file)}
        onDeleteFigure={(i) => handleDeleteFigure(editCard.paper_id, i)}
        onReorderFigure={(from, to) => handleReorderFigure(editCard.paper_id, from, to)}
        onReplaceFigure={(i, file) => handleReplaceFigure(editCard.paper_id, i, file)}
        onSaveSummary={(summary) => handleSaveSummary(editCard.paper_id, summary)}
        onRebuild={(opts) => handleRebuildCard(editCard.paper_id, opts)}
        styles={S}
      />
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

  // --- Cache inspector tab ---
  if (view === "cache") {
    return (
      <div style={S.container}>
        <div style={S.topBar}>
          <h1 style={S.logo}>Mekuru Admin</h1>
          <AdminTabs current={view} onChange={setView} styles={S} />
        </div>
        <CacheInspector styles={S} />
      </div>
    );
  }

  // --- Decks overview ---
  return (
    <div style={S.container}>
      <div style={S.topBar}>
        <h1 style={S.logo}>Mekuru Admin</h1>
        <AdminTabs current={view} onChange={setView} styles={S} />
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
// Tab nav for switching between admin views
// ============================================================
function AdminTabs({ current, onChange, styles: S }) {
  const tabs = [
    { key: "decks", label: "デッキ" },
    { key: "cache", label: "キャッシュ" },
  ];
  return (
    <div style={{ display: "flex", gap: 6 }}>
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          onClick={() => onChange(t.key)}
          style={{
            ...S.smallBtn,
            ...(current === t.key
              ? { background: "#3b82f6", color: "#fff", borderColor: "#3b82f6" }
              : {}),
          }}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}


// ============================================================
// Cache inspector — admin-only view of raw cache state
// ============================================================
function fmtBytes(n) {
  if (!n) return "0 B";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function CacheInspector({ styles: S }) {
  const [stats, setStats] = useState(null);
  const [papers, setPapers] = useState([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(false);
  const [filter, setFilter] = useState("with_summary");
  const [search, setSearch] = useState("");
  const [offset, setOffset] = useState(0);
  const [detail, setDetail] = useState(null); // {paper_id, ...}
  const [busy, setBusy] = useState(false);

  const PAGE = 50;

  const buildQuery = useCallback(() => {
    const q = new URLSearchParams();
    if (filter === "with_summary") q.set("has_summary", "true");
    if (filter === "no_summary") q.set("has_summary", "false");
    if (filter === "empty_summary") q.set("has_summary", "true");
    if (filter === "with_figures") q.set("has_figures", "true");
    if (filter === "no_figures") q.set("has_figures", "false");
    if (filter === "metadata_only") q.set("has_metadata", "true");
    if (search.trim()) q.set("search", search.trim());
    q.set("offset", String(offset));
    q.set("limit", String(PAGE));
    return q.toString();
  }, [filter, search, offset]);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const [statsRes, papersRes] = await Promise.all([
        fetch("/api/admin/cache/stats", { credentials: "include" }),
        fetch(`/api/admin/cache/papers?${buildQuery()}`, { credentials: "include" }),
      ]);
      if (statsRes.ok) setStats(await statsRes.json());
      if (papersRes.ok) {
        const data = await papersRes.json();
        let list = data.papers || [];
        if (filter === "empty_summary") list = list.filter((p) => p.summary_empty);
        setPapers(list);
        setTotal(data.total || 0);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, [buildQuery, filter]);

  useEffect(() => { reload(); }, [reload]);

  const openDetail = async (paperId) => {
    try {
      const r = await fetch(
        `/api/admin/cache/papers/${encodeURIComponent(paperId)}`,
        { credentials: "include" },
      );
      if (r.ok) setDetail(await r.json());
    } catch { /* ignore */ }
  };

  const dropPaper = async (paperId, opts) => {
    const label = [
      opts.drop_summary && "要約",
      opts.drop_figures && "画像",
      opts.drop_pdf && "PDF",
    ].filter(Boolean).join(" + ");
    if (!window.confirm(`${paperId} の${label}キャッシュを削除しますか？`)) return;
    setBusy(true);
    try {
      const q = new URLSearchParams(
        Object.fromEntries(Object.entries(opts).map(([k, v]) => [k, String(v)])),
      );
      await fetch(
        `/api/admin/cache/papers/${encodeURIComponent(paperId)}?${q}`,
        { method: "DELETE", credentials: "include" },
      );
      setDetail(null);
      await reload();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const cleanupEmpty = async () => {
    if (!window.confirm("空の要約キャッシュをすべて削除しますか？")) return;
    setBusy(true);
    try {
      const r = await fetch(
        "/api/admin/cache/cleanup-empty-summaries",
        { method: "POST", credentials: "include" },
      );
      if (r.ok) {
        const data = await r.json();
        alert(`${data.count} 件削除しました`);
      }
      await reload();
    } catch { /* ignore */ }
    setBusy(false);
  };

  const wipeAll = async (opts) => {
    const lines = [
      "全カードキャッシュを削除します。本当に実行しますか？",
      "",
      `要約 (${stats?.summaries.count || 0}件): ${opts.drop_summaries ? "削除" : "残す"}`,
      `画像 (${stats?.figures.count || 0}件): ${opts.drop_figures ? "削除" : "残す"}`,
      `PDF (${stats?.pdf_files.count || 0}件): ${opts.drop_pdfs ? "削除" : "残す"}`,
      `デッキ (${stats?.decks.count || 0}件): ${opts.drop_decks ? "削除" : "残す"}`,
      `論文メタデータ (${stats?.papers_metadata.count || 0}件): ${opts.drop_metadata ? "削除" : "残す"}`,
      "",
      "この操作は元に戻せません。",
    ].join("\n");
    if (!window.confirm(lines)) return;
    // Second confirm: ask the admin to type DELETE.
    const phrase = window.prompt('もう一度確認します。実行するには "DELETE" と入力してください：');
    if (phrase !== "DELETE") return;
    setBusy(true);
    try {
      const q = new URLSearchParams({
        confirm: "DELETE",
        drop_summaries: String(!!opts.drop_summaries),
        drop_figures: String(!!opts.drop_figures),
        drop_pdfs: String(!!opts.drop_pdfs),
        drop_decks: String(!!opts.drop_decks),
        drop_metadata: String(!!opts.drop_metadata),
      });
      const r = await fetch(
        `/api/admin/cache/wipe?${q}`,
        { method: "POST", credentials: "include" },
      );
      if (r.ok) {
        const data = await r.json();
        alert(
          `削除完了:\n` +
          `要約 ${data.summaries_deleted}, 画像 ${data.figures_deleted} (ファイル ${data.figure_files_deleted}),\n` +
          `PDF ${data.pdfs_deleted}, デッキ ${data.decks_deleted}, ` +
          `メタデータ ${data.metadata_cleared ? "クリア" : "保持"}`
        );
      } else {
        const err = await r.text();
        alert(`失敗: HTTP ${r.status}\n${err}`);
      }
      setDetail(null);
      await reload();
    } catch (e) {
      alert(`エラー: ${e.message || e}`);
    }
    setBusy(false);
  };

  // Detail modal
  if (detail) {
    const summary = detail.summary || {};
    return (
      <div>
        <div style={{ display: "flex", gap: 8, marginBottom: 12 }}>
          <button onClick={() => setDetail(null)} style={S.backBtn}>&larr; 戻る</button>
          <span style={{ ...S.dimText, alignSelf: "center" }}>{detail.paper_id}</span>
        </div>
        <section style={S.card}>
          {detail.metadata ? (
            <>
              <h2 style={{ ...S.cardTitle, fontSize: "1.05rem" }}>{detail.metadata.title}</h2>
              <div style={S.detailAuthors}>
                {(detail.metadata.authors || []).slice(0, 5).join(", ")}
                {(detail.metadata.authors || []).length > 5 && " et al."}
                {" — "}
                <span>{detail.metadata.venue} {detail.metadata.year}</span>
              </div>
            </>
          ) : (
            <p style={S.dimText}>論文メタデータはキャッシュにありません</p>
          )}

          <div style={S.detailSection}>
            <h3 style={S.detailLabel}>キャッシュ状況</h3>
            <ul style={{ fontSize: "0.85rem", color: "#cbd5e1", lineHeight: 1.6 }}>
              <li>要約: {detail.summary
                ? (detail.summary_empty ? "あり (空)" : "あり")
                : "なし"}</li>
              <li>画像 URL: {detail.figure_urls.length} 件</li>
              <li>ローカル PDF: {detail.pdf_cache.cached
                ? `あり (${fmtBytes(detail.pdf_cache.bytes)})` : "なし"}</li>
            </ul>
          </div>

          {detail.figure_urls.length > 0 && (
            <div style={S.detailSection}>
              <h3 style={S.detailLabel}>画像</h3>
              <div style={S.figGrid}>
                {detail.figure_urls.map((url, i) => (
                  <img key={i} src={url} alt={`fig${i}`} style={S.figImg} />
                ))}
              </div>
            </div>
          )}

          {detail.summary && (
            <div style={S.detailSection}>
              <h3 style={S.detailLabel}>要約</h3>
              {Object.entries(summary).filter(([, v]) => v).length > 0 ? (
                Object.entries(summary).filter(([, v]) => v).map(([k, v]) => (
                  <div key={k} style={S.summaryBlock}>
                    <div style={S.summaryKey}>{k}</div>
                    <div style={S.summaryVal}>{v}</div>
                  </div>
                ))
              ) : (
                <p style={S.dimText}>要約は空です</p>
              )}
            </div>
          )}

          <div style={{ ...S.detailSection, display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              style={S.smallBtnGhost}
              disabled={busy}
              onClick={() => dropPaper(detail.paper_id, {
                drop_summary: true, drop_figures: false, drop_pdf: false,
              })}
            >要約だけ削除</button>
            <button
              type="button"
              style={S.smallBtnGhost}
              disabled={busy}
              onClick={() => dropPaper(detail.paper_id, {
                drop_summary: false, drop_figures: true, drop_pdf: false,
              })}
            >画像だけ削除</button>
            <button
              type="button"
              style={{ ...S.smallBtnGhost, color: "#f87171", borderColor: "#f87171" }}
              disabled={busy}
              onClick={() => dropPaper(detail.paper_id, {
                drop_summary: true, drop_figures: true, drop_pdf: true,
              })}
            >すべて削除</button>
          </div>
        </section>
      </div>
    );
  }

  return (
    <div>
      {/* Stats */}
      {stats && (
        <div style={S.statsRow}>
          <div style={S.statBox}>
            <div style={S.statNum}>{stats.summaries.count}</div>
            <div style={S.statLabel}>要約 (空: {stats.summaries.empty})</div>
          </div>
          <div style={S.statBox}>
            <div style={S.statNum}>{stats.figures.count}</div>
            <div style={S.statLabel}>画像 ({fmtBytes(stats.figures.total_bytes)})</div>
          </div>
          <div style={S.statBox}>
            <div style={S.statNum}>{stats.papers_metadata.count}</div>
            <div style={S.statLabel}>論文メタ</div>
          </div>
          <div style={S.statBox}>
            <div style={S.statNum}>{stats.decks.count}</div>
            <div style={S.statLabel}>デッキ ({stats.decks.total_paper_ids} ids)</div>
          </div>
          <div style={S.statBox}>
            <div style={S.statNum}>{stats.pdf_files.count}</div>
            <div style={S.statLabel}>PDF ({fmtBytes(stats.pdf_files.total_bytes)})</div>
          </div>
          <div style={S.statBox}>
            <div style={{ ...S.statNum, fontSize: "0.95rem" }}>{stats.backend}</div>
            <div style={S.statLabel}>バックエンド</div>
          </div>
        </div>
      )}

      {/* Filters */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 12 }}>
        {[
          { k: "with_summary",  label: "要約あり" },
          { k: "empty_summary", label: "空の要約" },
          { k: "no_summary",    label: "要約なし" },
          { k: "with_figures",  label: "画像あり" },
          { k: "no_figures",    label: "画像なし" },
          { k: "metadata_only", label: "メタのみ" },
        ].map((f) => (
          <button
            key={f.k}
            type="button"
            onClick={() => { setOffset(0); setFilter(f.k); }}
            style={{
              ...S.filterBtn,
              ...(filter === f.k ? S.filterBtnActive : {}),
            }}
          >{f.label}</button>
        ))}
        <input
          type="text"
          placeholder="タイトル / paper_id 検索"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setOffset(0); }}
          style={{
            flex: 1,
            minWidth: 180,
            padding: "6px 10px",
            borderRadius: 8,
            border: "1px solid #334155",
            background: "#0f172a",
            color: "#e2e8f0",
            fontSize: "0.85rem",
          }}
        />
        <button
          type="button"
          style={{ ...S.smallBtnGhost, color: "#fbbf24", borderColor: "#fbbf24" }}
          onClick={cleanupEmpty}
          disabled={busy}
        >空要約を一掃</button>
        <button
          type="button"
          style={{ ...S.smallBtnGhost, color: "#f87171", borderColor: "#f87171" }}
          onClick={() => wipeAll({
            drop_summaries: true, drop_figures: true, drop_pdfs: true,
            drop_decks: false, drop_metadata: false,
          })}
          disabled={busy}
          title="要約・画像・PDFのみ削除（メタとデッキは残す）"
        >全カードを削除</button>
        <button
          type="button"
          style={{ ...S.smallBtnGhost, color: "#f87171", borderColor: "#f87171" }}
          onClick={() => wipeAll({
            drop_summaries: true, drop_figures: true, drop_pdfs: true,
            drop_decks: true, drop_metadata: true,
          })}
          disabled={busy}
          title="メタ含む全キャッシュを完全初期化（OpenAlex から再取得が必要になる）"
        >完全初期化</button>
      </div>

      {/* List */}
      {loading ? (
        <div style={S.emptyState}>読み込み中...</div>
      ) : papers.length === 0 ? (
        <div style={S.emptyState}>該当なし</div>
      ) : (
        <>
          <div style={{ ...S.dimText, marginBottom: 8 }}>
            {total} 件中 {offset + 1}–{Math.min(offset + PAGE, total)} を表示
          </div>
          <div style={S.cardList}>
            {papers.map((p) => (
              <div
                key={p.paper_id}
                style={S.cardItem}
                onClick={() => openDetail(p.paper_id)}
              >
                <div style={S.cardInfo}>
                  <div style={S.cardItemTitle}>
                    {p.title || p.paper_id}
                  </div>
                  <div style={S.cardItemMeta}>
                    {p.venue || "?"} {p.year || ""} — {p.paper_id}
                  </div>
                  <div style={S.cardBadges}>
                    {p.has_summary && !p.summary_empty && <span style={S.badgeOk}>要約</span>}
                    {p.summary_empty && <span style={S.badgeWarn}>空の要約</span>}
                    {p.has_figures && <span style={S.badgeOk}>画像</span>}
                    {!p.in_deck && <span style={S.badgeWarn}>orphan</span>}
                  </div>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          <div style={{ display: "flex", gap: 8, marginTop: 12, justifyContent: "center" }}>
            <button
              type="button"
              style={S.smallBtnGhost}
              disabled={offset === 0}
              onClick={() => setOffset(Math.max(0, offset - PAGE))}
            >&larr; 前</button>
            <button
              type="button"
              style={S.smallBtnGhost}
              disabled={offset + PAGE >= total}
              onClick={() => setOffset(offset + PAGE)}
            >次 &rarr;</button>
          </div>
        </>
      )}
    </div>
  );
}


// ============================================================
// Card detail editor (separate component so we can use hooks cleanly)
// ============================================================
function CardDetailEditor({
  card,
  uploading,
  onBack,
  onUpload,
  onDeleteFigure,
  onReorderFigure,
  onReplaceFigure,
  onSaveSummary,
  onRebuild,
  styles: S,
}) {
  const [editingSummary, setEditingSummary] = useState(false);
  const initialSummary = card.summary || {};
  const [summaryDraft, setSummaryDraft] = useState(initialSummary);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSummaryDraft(card.summary || {});
    setEditingSummary(false);
  }, [card.paper_id, card.summary]);

  const summaryKeys = Object.keys(summaryDraft).length
    ? Object.keys(summaryDraft)
    : ["claim", "what", "novel", "method", "eval", "discussion"];
  const figures = card.figure_urls || [];

  const save = async () => {
    setSaving(true);
    await onSaveSummary(summaryDraft);
    setSaving(false);
    setEditingSummary(false);
  };

  return (
    <div style={S.container}>
      <div style={S.topBar}>
        <button onClick={onBack} style={S.backBtn}>&larr; 戻る</button>
        <h1 style={S.logo}>カード詳細</h1>
      </div>
      <section style={S.card}>
        <div style={S.detailHeader}>
          <span style={S.badge}>{card.venue} {card.year}</span>
          {!card.has_figures && <span style={S.badgeDanger}>画像なし</span>}
          {!card.has_summary && <span style={S.badgeWarn}>要約なし</span>}
        </div>
        <h2 style={{ ...S.cardTitle, fontSize: "1.1rem" }}>{card.title}</h2>
        <div style={S.detailAuthors}>
          {(card.authors || []).slice(0, 5).join(", ")}
          {(card.authors || []).length > 5 && " et al."}
        </div>

        {/* Figures --------------------------------------------------- */}
        <div style={S.detailSection}>
          <h3 style={S.detailLabel}>画像 ({figures.length})</h3>
          {figures.length > 0 ? (
            <div style={S.figGrid}>
              {figures.map((url, i) => (
                <div key={`${url}-${i}`} style={{ position: "relative" }}>
                  <img src={url} alt={`fig${i}`} style={S.figImg} />
                  <div
                    style={{
                      display: "flex",
                      gap: 4,
                      justifyContent: "center",
                      marginTop: 4,
                      flexWrap: "wrap",
                    }}
                  >
                    <button
                      type="button"
                      style={S.smallBtnGhost}
                      disabled={i === 0}
                      onClick={() => onReorderFigure(i, i - 1)}
                      title="左へ"
                    >&larr;</button>
                    <button
                      type="button"
                      style={S.smallBtnGhost}
                      disabled={i === figures.length - 1}
                      onClick={() => onReorderFigure(i, i + 1)}
                      title="右へ"
                    >&rarr;</button>
                    <label style={{ ...S.smallBtn, cursor: "pointer" }}>
                      差替
                      <input
                        type="file"
                        accept="image/*"
                        style={{ display: "none" }}
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          if (f) onReplaceFigure(i, f);
                        }}
                      />
                    </label>
                    <button
                      type="button"
                      style={{ ...S.smallBtnGhost, color: "#f87171", borderColor: "#f87171" }}
                      onClick={() => onDeleteFigure(i)}
                    >削除</button>
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <p style={S.dimText}>画像がありません</p>
          )}
          <label style={{ ...S.uploadLabel, marginTop: 10, display: "inline-block" }}>
            <input
              type="file"
              accept="image/*"
              style={{ display: "none" }}
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) onUpload(f);
              }}
            />
            <span style={S.uploadBtn}>
              {uploading ? "処理中..." : "画像を追加"}
            </span>
          </label>
        </div>

        {/* Summary --------------------------------------------------- */}
        <div style={S.detailSection}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: 8,
            }}
          >
            <h3 style={{ ...S.detailLabel, margin: 0 }}>要約</h3>
            {!editingSummary ? (
              <button
                type="button"
                style={S.smallBtn}
                onClick={() => setEditingSummary(true)}
              >編集</button>
            ) : (
              <>
                <button
                  type="button"
                  style={S.smallBtnPrimary}
                  onClick={save}
                  disabled={saving}
                >{saving ? "保存中..." : "保存"}</button>
                <button
                  type="button"
                  style={S.smallBtnGhost}
                  onClick={() => {
                    setSummaryDraft(card.summary || {});
                    setEditingSummary(false);
                  }}
                >取消</button>
              </>
            )}
          </div>

          {editingSummary ? (
            summaryKeys.map((key) => (
              <div key={key} style={S.summaryBlock}>
                <div style={S.summaryKey}>{key}</div>
                <textarea
                  value={summaryDraft[key] || ""}
                  onChange={(e) =>
                    setSummaryDraft((d) => ({ ...d, [key]: e.target.value }))
                  }
                  rows={3}
                  style={{
                    width: "100%",
                    background: "#0f172a",
                    color: "#e2e8f0",
                    border: "1px solid #334155",
                    borderRadius: 6,
                    padding: 8,
                    fontSize: "0.82rem",
                    fontFamily: "inherit",
                    resize: "vertical",
                  }}
                />
              </div>
            ))
          ) : Object.entries(card.summary || {}).filter(([, v]) => v).length > 0 ? (
            Object.entries(card.summary || {})
              .filter(([, v]) => v)
              .map(([key, val]) => (
                <div key={key} style={S.summaryBlock}>
                  <div style={S.summaryKey}>{key}</div>
                  <div style={S.summaryVal}>{val}</div>
                </div>
              ))
          ) : (
            <p style={S.dimText}>要約がありません</p>
          )}
        </div>

        {/* Rebuild --------------------------------------------------- */}
        <div style={{ ...S.detailSection, display: "flex", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            style={S.smallBtn}
            onClick={() => onRebuild({ summary: true, figures: false })}
          >要約だけ再生成</button>
          <button
            type="button"
            style={S.smallBtn}
            onClick={() => onRebuild({ summary: false, figures: true })}
          >画像だけ再抽出</button>
          <button
            type="button"
            style={S.smallBtnPrimary}
            onClick={() => onRebuild({ summary: true, figures: true })}
          >カード全体を再生成</button>
        </div>

        {card.abstract && (
          <div style={S.detailSection}>
            <h3 style={S.detailLabel}>Abstract</h3>
            <p style={S.abstractText}>{card.abstract}</p>
          </div>
        )}
      </section>
    </div>
  );
}


// ============================================================
// Styles — Linear-inspired admin theme
// Near-black canvas (#08090a) with #0f1011 panels and #191a1b cards.
// Inter Variable with cv01/ss03, weight 510 as signature, brand indigo
// (#5e6ad2 / #7170ff) reserved for primary CTAs only.
// ============================================================
const FONT_STACK =
  "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif";
const FONT_FEAT = '"cv01", "ss03"';

const S = {
  container: {
    maxWidth: 1100,
    margin: "0 auto",
    padding: "32px 24px 48px",
    fontFamily: FONT_STACK,
    fontFeatureSettings: FONT_FEAT,
    color: "#f7f8f8",
    background: "#08090a",
    minHeight: "100vh",
  },
  topBar: {
    display: "flex",
    alignItems: "center",
    gap: 14,
    marginBottom: 28,
    flexWrap: "wrap",
  },
  logo: {
    fontSize: "1.5rem",
    fontWeight: 510,
    margin: 0,
    letterSpacing: "-0.288px",
    color: "#f7f8f8",
  },
  backBtn: {
    background: "rgba(255,255,255,0.02)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "#d0d6e0",
    padding: "6px 12px",
    borderRadius: 6,
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 510,
    fontFamily: FONT_STACK,
    fontFeatureSettings: FONT_FEAT,
  },
  countBadge: {
    background: "rgba(255,255,255,0.05)",
    padding: "3px 10px",
    borderRadius: 9999,
    fontSize: "0.75rem",
    color: "#d0d6e0",
    fontWeight: 510,
    border: "1px solid rgba(255,255,255,0.08)",
  },
  dimText: {
    color: "#8a8f98",
    fontSize: "0.875rem",
    fontWeight: 400,
    letterSpacing: "-0.165px",
  },

  // Deck grid
  deckGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(auto-fill, minmax(200px, 1fr))",
    gap: 12,
  },
  deckCard: {
    background: "rgba(255,255,255,0.02)",
    borderRadius: 8,
    padding: 16,
    border: "1px solid rgba(255,255,255,0.08)",
    display: "flex",
    flexDirection: "column",
    gap: 10,
  },
  deckCardUnbuilt: {
    opacity: 0.55,
    borderStyle: "dashed",
  },
  deckHeader: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
  },
  deckVenue: {
    fontWeight: 590,
    fontSize: "1rem",
    color: "#f7f8f8",
    letterSpacing: "-0.165px",
  },
  deckYear: {
    color: "#62666d",
    fontSize: "0.875rem",
    fontWeight: 510,
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  },
  deckStats: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    fontSize: "0.75rem",
    color: "#8a8f98",
    fontWeight: 510,
  },
  deckWarn: { color: "#dd5b00", fontWeight: 510 },
  deckWarnSoft: { color: "#27a644" },
  deckActions: { display: "flex", gap: 6, marginTop: 4 },

  // Buttons
  smallBtn: {
    padding: "5px 11px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.02)",
    color: "#e2e4e7",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 510,
    fontFamily: FONT_STACK,
    fontFeatureSettings: FONT_FEAT,
    transition: "background 0.15s",
  },
  smallBtnGhost: {
    padding: "5px 11px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.05)",
    background: "transparent",
    color: "#8a8f98",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 510,
    fontFamily: FONT_STACK,
    fontFeatureSettings: FONT_FEAT,
  },
  smallBtnPrimary: {
    padding: "5px 14px",
    borderRadius: 6,
    border: "1px solid #5e6ad2",
    background: "#5e6ad2",
    color: "#ffffff",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 590,
    fontFamily: FONT_STACK,
    fontFeatureSettings: FONT_FEAT,
  },
  primaryBtn: {
    padding: "8px 18px",
    borderRadius: 6,
    border: "1px solid #5e6ad2",
    background: "#5e6ad2",
    color: "#ffffff",
    fontWeight: 590,
    cursor: "pointer",
    fontSize: "0.875rem",
    fontFamily: FONT_STACK,
    fontFeatureSettings: FONT_FEAT,
  },
  ghostBtn: {
    padding: "8px 18px",
    borderRadius: 6,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "rgba(255,255,255,0.02)",
    color: "#d0d6e0",
    cursor: "pointer",
    fontSize: "0.875rem",
    fontWeight: 510,
    fontFamily: FONT_STACK,
    fontFeatureSettings: FONT_FEAT,
  },
  dangerBtn: {
    padding: "8px 18px",
    borderRadius: 6,
    border: "1px solid rgba(221, 91, 0, 0.4)",
    background: "rgba(221, 91, 0, 0.12)",
    color: "#dd5b00",
    fontWeight: 590,
    cursor: "pointer",
    marginTop: 12,
    fontFamily: FONT_STACK,
  },

  // Stats row
  statsRow: { display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" },
  statBox: {
    flex: 1,
    minWidth: 100,
    background: "rgba(255,255,255,0.02)",
    borderRadius: 8,
    padding: "14px 16px",
    textAlign: "center",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  statBoxDanger: { borderColor: "rgba(221,91,0,0.4)" },
  statBoxWarn: { borderColor: "rgba(39,166,68,0.4)" },
  statNum: {
    fontSize: "1.5rem",
    fontWeight: 510,
    color: "#f7f8f8",
    letterSpacing: "-0.288px",
  },
  statLabel: {
    fontSize: "0.75rem",
    color: "#8a8f98",
    marginTop: 4,
    fontWeight: 510,
  },

  // Filter
  filterRow: { display: "flex", gap: 6, marginBottom: 16, flexWrap: "wrap" },
  filterBtn: {
    padding: "5px 12px",
    borderRadius: 9999,
    border: "1px solid rgba(255,255,255,0.08)",
    background: "transparent",
    color: "#d0d6e0",
    cursor: "pointer",
    fontSize: "0.8125rem",
    fontWeight: 510,
    display: "flex",
    alignItems: "center",
    gap: 6,
    fontFamily: FONT_STACK,
    fontFeatureSettings: FONT_FEAT,
  },
  filterBtnActive: {
    background: "#5e6ad2",
    color: "#ffffff",
    borderColor: "#5e6ad2",
  },
  filterCount: {
    background: "rgba(255,255,255,0.1)",
    borderRadius: 9999,
    padding: "1px 6px",
    fontSize: "0.6875rem",
    fontWeight: 510,
  },

  // Card list
  cardList: { display: "flex", flexDirection: "column", gap: 4 },
  cardItem: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    padding: "10px 12px",
    background: "rgba(255,255,255,0.02)",
    borderRadius: 8,
    border: "1px solid rgba(255,255,255,0.05)",
    cursor: "pointer",
    transition: "background 0.15s",
  },
  cardThumb: {
    width: 56,
    height: 56,
    borderRadius: 6,
    overflow: "hidden",
    flexShrink: 0,
    background: "rgba(0,0,0,0.3)",
    border: "1px solid rgba(255,255,255,0.05)",
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
    fontSize: "0.625rem",
    color: "#62666d",
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  cardInfo: { flex: 1, minWidth: 0 },
  cardItemTitle: {
    fontSize: "0.875rem",
    fontWeight: 510,
    color: "#f7f8f8",
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    letterSpacing: "-0.165px",
  },
  cardItemMeta: {
    fontSize: "0.75rem",
    color: "#62666d",
    marginTop: 2,
    whiteSpace: "nowrap",
    overflow: "hidden",
    textOverflow: "ellipsis",
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  cardBadges: { display: "flex", gap: 4, marginTop: 6 },
  cardUploadArea: { flexShrink: 0, cursor: "pointer" },
  cardUploadBtn: {
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    width: 32,
    height: 32,
    borderRadius: 6,
    background: "rgba(255,255,255,0.05)",
    color: "#f7f8f8",
    fontSize: "1rem",
    fontWeight: 590,
    border: "1px solid rgba(255,255,255,0.08)",
  },

  // Badges
  badge: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 9999,
    background: "rgba(255,255,255,0.05)",
    color: "#d0d6e0",
    fontSize: "0.6875rem",
    fontWeight: 510,
    border: "1px solid rgba(255,255,255,0.05)",
  },
  badgeDanger: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 9999,
    background: "rgba(221,91,0,0.12)",
    color: "#dd5b00",
    fontSize: "0.6875rem",
    fontWeight: 510,
    border: "1px solid rgba(221,91,0,0.3)",
  },
  badgeWarn: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 9999,
    background: "rgba(122,127,173,0.15)",
    color: "#7a7fad",
    fontSize: "0.6875rem",
    fontWeight: 510,
    border: "1px solid rgba(122,127,173,0.3)",
  },
  badgeOk: {
    display: "inline-block",
    padding: "2px 8px",
    borderRadius: 9999,
    background: "rgba(39,166,68,0.12)",
    color: "#27a644",
    fontSize: "0.6875rem",
    fontWeight: 510,
    border: "1px solid rgba(39,166,68,0.3)",
  },

  // Cards section / detail
  card: {
    background: "rgba(255,255,255,0.02)",
    borderRadius: 12,
    padding: 22,
    border: "1px solid rgba(255,255,255,0.08)",
  },
  cardTitle: {
    fontSize: "1.125rem",
    fontWeight: 590,
    margin: "0 0 8px",
    color: "#f7f8f8",
    letterSpacing: "-0.24px",
  },

  // Build
  progressOuter: {
    height: 26,
    background: "rgba(0,0,0,0.3)",
    borderRadius: 6,
    overflow: "hidden",
    position: "relative",
    marginBottom: 12,
    border: "1px solid rgba(255,255,255,0.05)",
  },
  progressInner: {
    height: "100%",
    background: "#5e6ad2",
    borderRadius: 6,
    transition: "width 0.3s ease",
  },
  progressText: {
    position: "absolute",
    inset: 0,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: "0.8125rem",
    fontWeight: 590,
    color: "#ffffff",
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  log: {
    background: "#010102",
    padding: 14,
    borderRadius: 8,
    fontSize: "0.75rem",
    lineHeight: 1.6,
    maxHeight: 300,
    overflowY: "auto",
    whiteSpace: "pre-wrap",
    wordBreak: "break-all",
    color: "#8a8f98",
    border: "1px solid rgba(255,255,255,0.05)",
    fontFamily: "'JetBrains Mono', ui-monospace, 'SF Mono', Menlo, monospace",
  },

  emptyState: {
    textAlign: "center",
    color: "#62666d",
    padding: 48,
    fontSize: "0.9375rem",
    fontWeight: 510,
  },

  // Detail view
  detailHeader: { display: "flex", gap: 8, marginBottom: 8 },
  detailAuthors: {
    fontSize: "0.8125rem",
    color: "#62666d",
    marginBottom: 16,
    fontWeight: 400,
  },
  detailSection: { marginTop: 24 },
  detailLabel: {
    fontSize: "0.6875rem",
    fontWeight: 510,
    color: "#8a8f98",
    marginBottom: 8,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  figGrid: {
    display: "flex",
    gap: 10,
    flexWrap: "wrap",
    marginBottom: 10,
  },
  figImg: {
    maxWidth: 280,
    maxHeight: 200,
    borderRadius: 6,
    objectFit: "contain",
    background: "rgba(0,0,0,0.3)",
    border: "1px solid rgba(255,255,255,0.08)",
  },
  uploadLabel: { cursor: "pointer", display: "inline-block" },
  uploadBtn: {
    display: "inline-block",
    padding: "6px 14px",
    borderRadius: 6,
    background: "rgba(255,255,255,0.05)",
    color: "#f7f8f8",
    fontSize: "0.8125rem",
    cursor: "pointer",
    fontWeight: 510,
    border: "1px solid rgba(255,255,255,0.08)",
    fontFamily: FONT_STACK,
  },
  summaryBlock: { marginBottom: 14 },
  summaryKey: {
    fontSize: "0.6875rem",
    fontWeight: 510,
    color: "#7170ff",
    marginBottom: 4,
    textTransform: "uppercase",
    letterSpacing: "0.5px",
    fontFamily: "'JetBrains Mono', ui-monospace, monospace",
  },
  summaryVal: {
    fontSize: "0.875rem",
    color: "#d0d6e0",
    lineHeight: 1.6,
    letterSpacing: "-0.165px",
  },
  abstractText: {
    fontSize: "0.875rem",
    color: "#8a8f98",
    lineHeight: 1.6,
    letterSpacing: "-0.165px",
  },
};
