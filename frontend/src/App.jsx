import { useState, useEffect, useCallback, useRef } from "react";
import { motion, AnimatePresence } from "framer-motion";
import SearchBar from "./components/SearchBar";
import SwipeStack from "./components/SwipeStack";
import ReadingList from "./components/ReadingList";
import ExportModal from "./components/ExportModal";
import StreakBadge from "./components/StreakBadge";
import ProgressBar from "./components/ProgressBar";
import CompletionScreen from "./components/CompletionScreen";

export default function App() {
  const [papers, setPapers] = useState([]);
  const [readingList, setReadingList] = useState([]);
  const [showReadingList, setShowReadingList] = useState(false);
  const [showExport, setShowExport] = useState(false);
  const [loading, setLoading] = useState(false);
  const [searchState, setSearchState] = useState({ venues: [], year: 2024 });
  const [todayCount, setTodayCount] = useState(0);
  const [progress, setProgress] = useState([]);
  const [showCompletion, setShowCompletion] = useState(false);
  const [completionStats, setCompletionStats] = useState(null);
  const [seenIds, setSeenIds] = useState(new Set());
  const [searchProgress, setSearchProgress] = useState(null);
  const abortRef = useRef(null);

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
    } catch {
      /* ignore */
    }
  };

  const fetchProgress = async () => {
    try {
      const res = await fetch("/api/progress");
      const data = await res.json();
      setProgress(data.progress || []);
    } catch {
      /* ignore */
    }
  };

  const handleSearch = async (venues, year, keyword) => {
    if (abortRef.current) abortRef.current.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setSearchState({ venues, year });
    setShowCompletion(false);
    setPapers([]);
    setSearchProgress({ currentVenue: null, venueIndex: 0, venueTotal: venues.length, totalFound: 0, venueDone: {} });

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
        } catch {
          /* ignore */
        }
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
        } catch {
          /* ignore */
        }
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

  return (
    <div className="app">
      <header className="app-header">
        <div className="header-left">
          <h1 className="logo">PaperTinder</h1>
          <span className="tagline">Swipe to Read</span>
        </div>
        <div className="header-right">
          <StreakBadge todayCount={todayCount} />
          <button
            className="btn btn-ghost"
            onClick={() => setShowReadingList(true)}
          >
            <span className="btn-icon">&#128278;</span>
            保存リスト ({readingList.length})
          </button>
          <button className="btn btn-ghost" onClick={() => setShowExport(true)}>
            <span className="btn-icon">&#128196;</span>
            Export
          </button>
        </div>
      </header>

      <div className="app-body">
        <aside className="sidebar">
          <SearchBar onSearch={handleSearch} loading={loading} searchProgress={searchProgress} />
          <ProgressBar progress={progress} onResume={handleResume} />
        </aside>

        <main className="main-area">
          {showCompletion && completionStats ? (
            <CompletionScreen
              stats={completionStats}
              onNext={() => setShowCompletion(false)}
            />
          ) : loading && searchProgress ? (
            <div className="paper-loading-stage">
              <div className="loading-stack-visual">
                <AnimatePresence>
                  {papers.slice(-8).map((paper, i, arr) => {
                    const offset = arr.length - 1 - i;
                    return (
                      <motion.div
                        key={paper.paper_id}
                        className="loading-card-mini"
                        initial={{ opacity: 0, y: 60, scale: 0.85, rotateZ: (Math.random() - 0.5) * 6 }}
                        animate={{
                          opacity: 1 - offset * 0.1,
                          y: -offset * 8,
                          scale: 1 - offset * 0.02,
                          rotateZ: (offset % 2 === 0 ? 1 : -1) * offset * 0.8,
                        }}
                        transition={{ type: "spring", stiffness: 300, damping: 20 }}
                        style={{ zIndex: arr.length - offset }}
                      >
                        <div className="loading-card-venue">{paper.venue || "Paper"}</div>
                        <div className="loading-card-title">{paper.title}</div>
                      </motion.div>
                    );
                  })}
                </AnimatePresence>
              </div>
              <motion.div
                className="loading-count-display"
                key={papers.length}
                initial={{ scale: 1.3 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 400 }}
              >
                <span className="loading-count-number">{papers.length}</span>
                <span className="loading-count-label">件の論文を準備中...</span>
              </motion.div>
              {searchProgress?.currentVenue && (
                <div className="loading-venue-status">
                  <span className="loading-pulse" />
                  {searchProgress.currentVenue} を検索中
                </div>
              )}
            </div>
          ) : papers.length > 0 ? (
            <SwipeStack
              papers={papers}
              onSwipe={handleSwipe}
              onQueueEmpty={handleQueueEmpty}
            />
          ) : (
            <div className="empty-state">
              <div className="empty-icon">&#128218;</div>
              <h2>論文を探す</h2>
              <p>
                左のパネルからベニュー・年を選択して検索してください。
                <br />
                カードをスワイプして論文をチェック！
              </p>
            </div>
          )}
        </main>
      </div>

      {showReadingList && (
        <ReadingList
          items={readingList}
          onClose={() => setShowReadingList(false)}
          onRemove={async (paperId) => {
            await fetch(`/api/reading-list/${encodeURIComponent(paperId)}`, {
              method: "DELETE",
            });
            fetchReadingList();
          }}
        />
      )}

      {showExport && <ExportModal onClose={() => setShowExport(false)} />}
    </div>
  );
}
