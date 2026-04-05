import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import TinderCard from "react-tinder-card";
import { motion, AnimatePresence } from "framer-motion";
import MobilePaperCard from "./MobilePaperCard";
import CompletionScreen from "../CompletionScreen";

const PREFETCH_WINDOW = 5;

export default function MobileSwipe({
  papers,
  loading,
  searchProgress,
  showCompletion,
  completionStats,
  onSwipe,
  onQueueEmpty,
  onDismissCompletion,
  onGoSearch,
}) {
  const [currentIndex, setCurrentIndex] = useState(papers.length - 1);
  const [swipeDirection, setSwipeDirection] = useState(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const currentIndexRef = useRef(currentIndex);
  const cardRefs = useRef([]);

  useEffect(() => {
    setCurrentIndex(papers.length - 1);
    currentIndexRef.current = papers.length - 1;
    cardRefs.current = papers.map(() => null);
  }, [papers]);

  const canSwipe = currentIndex >= 0;

  const swiped = useCallback(
    (direction, paper, index) => {
      setSwipeDirection(direction);
      setDetailOpen(false);
      setTimeout(() => setSwipeDirection(null), 400);
      currentIndexRef.current = index - 1;
      setCurrentIndex(index - 1);
      onSwipe(paper, direction);
      if (index - 1 < 0) {
        setTimeout(() => onQueueEmpty(), 500);
      }
    },
    [onSwipe, onQueueEmpty]
  );

  const swipe = useCallback(
    (dir) => {
      if (canSwipe && cardRefs.current[currentIndex]) {
        cardRefs.current[currentIndex].swipe(dir);
      }
    },
    [canSwipe, currentIndex]
  );

  const handleSwipeRequest = useCallback(
    (dir) => swipe(dir),
    [swipe]
  );

  const visibleCards = useMemo(() => {
    const start = Math.max(0, currentIndex - (PREFETCH_WINDOW - 1));
    const end = currentIndex + 1;
    return papers.slice(start, end).map((p, i) => ({
      paper: p,
      index: start + i,
    }));
  }, [papers, currentIndex]);

  if (showCompletion && completionStats) {
    return (
      <div className="m-swipe-completion">
        <CompletionScreen
          stats={completionStats}
          onNext={onDismissCompletion}
        />
      </div>
    );
  }

  if (loading && searchProgress) {
    return (
      <div className="m-swipe-loading">
        <div className="m-loading-stack">
          <AnimatePresence>
            {papers.slice(-5).map((paper, i, arr) => {
              const offset = arr.length - 1 - i;
              return (
                <motion.div
                  key={paper.paper_id}
                  className="m-loading-card"
                  initial={{ opacity: 0, y: 40, scale: 0.9 }}
                  animate={{
                    opacity: 1 - offset * 0.15,
                    y: -offset * 6,
                    scale: 1 - offset * 0.03,
                    rotateZ: (offset % 2 === 0 ? 1 : -1) * offset * 0.6,
                  }}
                  transition={{ type: "spring", stiffness: 300, damping: 20 }}
                  style={{ zIndex: arr.length - offset }}
                >
                  <span className="m-loading-card-venue">{paper.venue || "Paper"}</span>
                  <span className="m-loading-card-title">{paper.title}</span>
                </motion.div>
              );
            })}
          </AnimatePresence>
        </div>
        <motion.div
          className="m-loading-count"
          key={papers.length}
          initial={{ scale: 1.3 }}
          animate={{ scale: 1 }}
          transition={{ type: "spring", stiffness: 400 }}
        >
          <span className="m-loading-count-num">{papers.length}</span>
          <span className="m-loading-count-text">件の論文を準備中...</span>
        </motion.div>
        {searchProgress?.currentVenue && (
          <div className="m-loading-venue">
            <span className="m-pulse-dot" />
            {searchProgress.currentVenue} を検索中
          </div>
        )}
      </div>
    );
  }

  if (papers.length === 0) {
    return (
      <div className="m-swipe-empty">
        <div className="m-empty-icon">&#128218;</div>
        <h2>論文を探そう</h2>
        <p>検索タブからベニュー・年を選んで検索してください</p>
        <button className="m-search-btn" onClick={onGoSearch}>
          &#128269; 検索する
        </button>
      </div>
    );
  }

  return (
    <div className="m-swipe">
      <AnimatePresence>
        {swipeDirection === "right" && (
          <motion.div
            className="m-glow m-glow-right"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          />
        )}
        {swipeDirection === "left" && (
          <motion.div
            className="m-glow m-glow-left"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.5 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          />
        )}
      </AnimatePresence>

      <div className="m-card-stack">
        {visibleCards.map(({ paper, index }) => {
          const offset = currentIndex - index;
          return (
            <TinderCard
              ref={(el) => (cardRefs.current[index] = el)}
              key={paper.paper_id}
              onSwipe={(dir) => swiped(dir, paper, index)}
              preventSwipe={["up", "down"]}
              swipeRequirementType="position"
              swipeThreshold={100}
              className="m-card-wrapper"
            >
              <motion.div
                className="m-card"
                style={{
                  zIndex: papers.length - offset,
                  transform: `scale(${1 - offset * 0.04}) translateY(${offset * 10}px)`,
                  opacity: offset > 2 ? 0 : 1 - offset * 0.15,
                  pointerEvents: offset > 2 ? "none" : "auto",
                }}
                initial={offset === 0 ? { scale: 0.95, opacity: 0 } : false}
                animate={offset === 0 ? { scale: 1, opacity: 1 } : false}
                transition={{ type: "spring", stiffness: 300, damping: 25 }}
              >
                <MobilePaperCard
                  paper={paper}
                  isTop={offset === 0}
                  shouldPreload={true}
                  onDetailOpen={() => setDetailOpen(true)}
                  onDetailClose={() => setDetailOpen(false)}
                  onSwipeRequest={handleSwipeRequest}
                />
              </motion.div>
            </TinderCard>
          );
        })}
      </div>

      <div className="m-swipe-controls">
        <button
          className="m-swipe-btn m-swipe-btn-left"
          onClick={() => swipe("left")}
          disabled={!canSwipe}
        >
          <span>&#10005;</span>
          <small>Skip</small>
        </button>
        <div className="m-swipe-counter">
          {papers.length > 0
            ? `${papers.length - currentIndex - 1} / ${papers.length}`
            : ""}
        </div>
        <button
          className="m-swipe-btn m-swipe-btn-right"
          onClick={() => swipe("right")}
          disabled={!canSwipe}
        >
          <span>&#10003;</span>
          <small>Save</small>
        </button>
      </div>
    </div>
  );
}
