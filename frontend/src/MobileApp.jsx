import { useState, useEffect, useCallback, useRef } from "react";
import MobileSearch from "./components/mobile/MobileSearch";
import MobileSwipe from "./components/mobile/MobileSwipe";
import MobileSaved from "./components/mobile/MobileSaved";
import MobileProgress from "./components/mobile/MobileProgress";
import ExportModal from "./components/ExportModal";
import StreakBadge from "./components/StreakBadge";
import { SummaryPrefetcher } from "./summaryPrefetcher";
import "./mobile.css";

export default function MobileApp() {
  const [activeTab, setActiveTab] = useState("search");
  const [papers, setPapers] = useState([]);
  const [readingList, setReadingList] = useState([]);
  const [loading, setLoading] = useState(false);
  const [searchState, setSearchState] = useState({ venues: [], year: 2024 });
  const [todayCount, setTodayCount] = useState(0);
  const [progress, setProgress] = useState([]);
  const [showCompletion, setShowCompletion] = useState(false);
  const [completionStats, setCompletionStats] = useState(null);
  const [seenIds, setSeenIds] = useState(new Set());
  const [searchProgress, setSearchProgress] = useState(null);
  const [showExport, setShowExport] = useState(false);
  const [exportService, setExportService] = useState(null);
  const abortRef = useRef(null);
  const prefetcherRef = useRef(null);
  if (!prefetcherRef.current) {
    prefetcherRef.current = new SummaryPrefetcher();
  }

  useEffect(() => {
    const today = new Date().toDateString();
    const stored = localStorage.getItem("pt_today");
    const storedDate = localStorage.getItem("pt_today_date");
    if (storedDate === today) {
      setTodayCount(parseInt(stored || "0", 10));
    } else {
      localStorage.setItem("pt_today_date", today);
      localStorage.setItem("pt_today", "0");
    }
    fetchReadingList();
    fetchProgress();
  }, []);

  const fetchReadingList = async () => {
    try {
      const res = await fetch("/api/reading-list");
      const data = await res.json();
      setReadingList(data.items || []);
    } catch { /* ignore */ }
  };

  const fetchProgress = async () => {
    try {
      const res = await fetch("/api/progress");
      const data = await res.json();
      setProgress(data.progress || []);
    } catch { /* ignore */ }
  };

  const handleSearch = async (venues, year, keyword) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setSearchState({ venues, year });
    setShowCompletion(false);
    setPapers([]);
    prefetcherRef.current.reset();
    setSearchProgress({ currentVenue: null, venueIndex: 0, venueTotal: venues.length, totalFound: 0, venueDone: {} });
    setActiveTab("swipe");

    try {
      const progRes = await Promise.all(
        venues.map((v) =>
          fetch(`/api/progress/${encodeURIComponent(v)}/${year}`).then((r) => r.json())
        )
      );
      const allSeen = new Set();
      progRes.forEach((p) => (p.seen || []).forEach((id) => allSeen.add(id)));
      setSeenIds(allSeen);

      const res = await fetch("/api/papers/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ venues, year, keyword, limit: 50 }),
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
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const event = JSON.parse(line.slice(6));

            if (event.type === "venue_start") {
              setSearchProgress((prev) => ({
                ...prev,
                currentVenue: event.venue,
                venueIndex: event.venue_index,
                venueTotal: event.venue_total,
              }));
            } else if (event.type === "papers") {
              const newPapers = (event.papers || []).filter((p) => !allSeen.has(p.paper_id));
              if (newPapers.length > 0) {
                setPapers((prev) => [...prev, ...newPapers]);
                newPapers.forEach((p) => prefetcherRef.current.enqueue(p));
              }
              setSearchProgress((prev) => ({
                ...prev,
                totalFound: event.total_found,
              }));
            } else if (event.type === "venue_done") {
              setSearchProgress((prev) => ({
                ...prev,
                totalFound: event.total_found,
                venueDone: { ...prev.venueDone, [event.venue]: event.venue_count },
              }));
            } else if (event.type === "done") {
              setSearchProgress((prev) => ({ ...prev, currentVenue: null }));
            }
          } catch { /* ignore parse errors */ }
        }
      }

      fetchProgress();
    } catch (err) {
      if (err.name !== "AbortError") console.error("Search failed:", err);
    } finally {
      setLoading(false);
      setSearchProgress(null);
      abortRef.current = null;
    }
  };

  const handleResume = async (venue, year) => {
    await handleSearch([venue], year, null);
  };

  const incrementToday = useCallback(() => {
    setTodayCount((prev) => {
      const next = prev + 1;
      localStorage.setItem("pt_today", String(next));
      return next;
    });
  }, []);

  const handleSwipe = useCallback(
    async (paper, direction) => {
      incrementToday();

      const venue = paper.venue || searchState.venues[0] || "";
      if (venue) {
        try {
          await fetch(
            `/api/progress/${encodeURIComponent(venue)}/${searchState.year}/seen`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ paper_id: paper.paper_id }),
            }
          );
        } catch { /* ignore */ }
      }

      if (direction === "right") {
        try {
          await fetch("/api/reading-list", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              paper_id: paper.paper_id,
              title: paper.title,
              venue: paper.venue,
              year: paper.year,
            }),
          });
          if (venue) {
            await fetch(
              `/api/progress/${encodeURIComponent(venue)}/${searchState.year}/saved`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ paper_id: paper.paper_id }),
              }
            );
          }
          fetchReadingList();
        } catch { /* ignore */ }
      }
      fetchProgress();
    },
    [searchState, incrementToday]
  );

  const handleQueueEmpty = useCallback(() => {
    if (searchState.venues.length > 0) {
      const totalSwiped = todayCount;
      const savedCount = readingList.length;
      setCompletionStats({
        venues: searchState.venues,
        year: searchState.year,
        totalSwiped,
        savedCount,
      });
      setShowCompletion(true);

      const badges = JSON.parse(localStorage.getItem("pt_badges") || "[]");
      searchState.venues.forEach((v) => {
        const badge = `${v} ${searchState.year}`;
        if (!badges.includes(badge)) badges.push(badge);
      });
      localStorage.setItem("pt_badges", JSON.stringify(badges));
    }
  }, [searchState, todayCount, readingList]);

  const handleRemove = async (paperId) => {
    await fetch(`/api/reading-list/${encodeURIComponent(paperId)}`, {
      method: "DELETE",
    });
    fetchReadingList();
  };

  const prevTab = useRef("search");
  const goBack = useCallback(() => {
    if (activeTab === "saved" || activeTab === "progress") {
      setActiveTab(prevTab.current === "swipe" ? "swipe" : "search");
    } else if (activeTab === "swipe") {
      setActiveTab("search");
    }
  }, [activeTab]);

  const navigateTo = useCallback((tab) => {
    prevTab.current = activeTab;
    setActiveTab(tab);
  }, [activeTab]);

  return (
    <div className="m-app">
      {/* ── Contextual Header ── */}
      {activeTab === "search" && (
        <header className="m-header">
          <h1 className="m-logo">PaperTinder</h1>
          <div className="m-header-right">
            <StreakBadge todayCount={todayCount} />
            <button
              className="m-header-pill"
              onClick={() => navigateTo("saved")}
            >
              <span className="m-header-pill-icon">&#9776;</span>
              {readingList.length > 0 && (
                <span className="m-header-pill-count">{readingList.length}</span>
              )}
            </button>
          </div>
        </header>
      )}

      {activeTab === "swipe" && (
        <header className="m-header m-header-float">
          <button className="m-float-btn" onClick={goBack}>
            &#8592;
          </button>
          <div />
          <button
            className="m-float-btn m-float-btn-saved"
            onClick={() => navigateTo("saved")}
          >
            &#9733;
            {readingList.length > 0 && (
              <span className="m-float-badge">{readingList.length}</span>
            )}
          </button>
        </header>
      )}

      {(activeTab === "saved" || activeTab === "progress") && (
        <header className="m-header m-header-sub">
          <button className="m-float-btn" onClick={goBack}>
            &#8592;
          </button>
          <h2 className="m-sub-title">
            {activeTab === "saved" ? "Library" : "Progress"}
          </h2>
          <div style={{ width: 36 }} />
        </header>
      )}

      {/* ── Main Content ── */}
      <main className="m-main">
        {activeTab === "search" && (
          <MobileSearch
            onSearch={handleSearch}
            loading={loading}
            searchProgress={searchProgress}
            onGoSaved={() => navigateTo("saved")}
            onGoProgress={() => navigateTo("progress")}
          />
        )}
        {activeTab === "swipe" && (
          <MobileSwipe
            papers={papers}
            loading={loading}
            searchProgress={searchProgress}
            showCompletion={showCompletion}
            completionStats={completionStats}
            prefetcher={prefetcherRef.current}
            onSwipe={handleSwipe}
            onQueueEmpty={handleQueueEmpty}
            onDismissCompletion={() => setShowCompletion(false)}
            onGoSearch={() => setActiveTab("search")}
          />
        )}
        {activeTab === "saved" && (
          <MobileSaved
            items={readingList}
            onRemove={handleRemove}
            onExport={(serviceKey) => {
              setExportService(serviceKey || null);
              setShowExport(true);
            }}
          />
        )}
        {activeTab === "progress" && (
          <MobileProgress
            progress={progress}
            onResume={handleResume}
          />
        )}
      </main>

      {showExport && (
        <ExportModal
          onClose={() => {
            setShowExport(false);
            setExportService(null);
          }}
          initialService={exportService}
        />
      )}
    </div>
  );
}
