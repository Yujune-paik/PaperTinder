import { useState, useRef, useEffect, useCallback, useMemo } from "react";
import TinderCard from "react-tinder-card";
import { motion, AnimatePresence } from "framer-motion";
import PaperCard from "./PaperCard";

const PREFETCH_THRESHOLD = 3;

export default function SwipeStack({ papers, onSwipe, onQueueEmpty, venueProgress }) {
  const [currentIndex, setCurrentIndex] = useState(papers.length - 1);
  const [swipeDirection, setSwipeDirection] = useState(null);
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

  useEffect(() => {
    const handleKeyDown = (e) => {
      if (e.key === "ArrowRight") {
        e.preventDefault();
        swipe("right");
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        swipe("left");
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [swipe]);

  const visibleCards = useMemo(() => {
    const start = Math.max(0, currentIndex - 2);
    const end = currentIndex + 1;
    return papers.slice(start, end).map((p, i) => ({
      paper: p,
      index: start + i,
    }));
  }, [papers, currentIndex]);

  return (
    <div className="swipe-stack-container">
      <AnimatePresence>
        {swipeDirection === "right" && (
          <motion.div
            className="swipe-glow swipe-glow-right"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          />
        )}
        {swipeDirection === "left" && (
          <motion.div
            className="swipe-glow swipe-glow-left"
            initial={{ opacity: 0 }}
            animate={{ opacity: 0.6 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.3 }}
          />
        )}
      </AnimatePresence>

      <div className="card-stack">
        {visibleCards.map(({ paper, index }) => {
          const offset = currentIndex - index;
          return (
            <TinderCard
              ref={(el) => (cardRefs.current[index] = el)}
              key={paper.paper_id}
              onSwipe={(dir) => swiped(dir, paper, index)}
              preventSwipe={["up", "down"]}
              className="swipe-card-wrapper"
            >
              <motion.div
                className="swipe-card"
                style={{
                  zIndex: papers.length - offset,
                  transform: `scale(${1 - offset * 0.04}) translateY(${offset * 12}px)`,
                  opacity: offset > 2 ? 0 : 1 - offset * 0.15,
                }}
                initial={offset === 0 ? { scale: 0.95, opacity: 0 } : false}
                animate={offset === 0 ? { scale: 1, opacity: 1 } : false}
                transition={{ type: "spring", stiffness: 300, damping: 25 }}
              >
                <PaperCard paper={paper} isTop={offset === 0} />
              </motion.div>
            </TinderCard>
          );
        })}
      </div>

      <div className="swipe-controls">
        <button
          className="swipe-btn swipe-btn-left"
          onClick={() => swipe("left")}
          disabled={!canSwipe}
          title="スキップ (←)"
        >
          <span>&#10005;</span>
          <small>Skip</small>
        </button>
        <div className="swipe-counter">
          {papers.length > 0
            ? `${papers.length - currentIndex - 1} / ${papers.length}`
            : ""}
        </div>
        <button
          className="swipe-btn swipe-btn-right"
          onClick={() => swipe("right")}
          disabled={!canSwipe}
          title="保存 (→)"
        >
          <span>&#10003;</span>
          <small>Save</small>
        </button>
      </div>

      {venueProgress && venueProgress.total > 0 && (
        <div className="venue-progress-bar">
          <div className="venue-progress-track">
            <div
              className="venue-progress-fill"
              style={{ width: `${Math.min(100, Math.round((venueProgress.seen / venueProgress.total) * 100))}%` }}
            />
          </div>
          <span className="venue-progress-label">
            {venueProgress.seen} / {venueProgress.total} 件チェック済み
            ({Math.round((venueProgress.seen / venueProgress.total) * 100)}%)
          </span>
        </div>
      )}

      <div className="swipe-hint">
        <kbd>←</kbd> スキップ &nbsp; <kbd>→</kbd> 保存
      </div>
    </div>
  );
}
