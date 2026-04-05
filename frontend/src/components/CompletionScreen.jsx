import { motion } from "framer-motion";
import { useEffect, useState } from "react";

function Confetti() {
  const [pieces, setPieces] = useState([]);

  useEffect(() => {
    const colors = ["#10b981", "#3b82f6", "#f59e0b", "#ef4444", "#8b5cf6", "#ec4899"];
    const newPieces = Array.from({ length: 60 }, (_, i) => ({
      id: i,
      x: Math.random() * 100,
      color: colors[Math.floor(Math.random() * colors.length)],
      delay: Math.random() * 0.8,
      size: 6 + Math.random() * 8,
      rotation: Math.random() * 360,
    }));
    setPieces(newPieces);
  }, []);

  return (
    <div className="confetti-container">
      {pieces.map((p) => (
        <motion.div
          key={p.id}
          className="confetti-piece"
          style={{
            left: `${p.x}%`,
            width: p.size,
            height: p.size,
            background: p.color,
            borderRadius: Math.random() > 0.5 ? "50%" : "2px",
          }}
          initial={{ y: -20, opacity: 1, rotate: 0 }}
          animate={{
            y: window.innerHeight + 100,
            opacity: 0,
            rotate: p.rotation + 720,
          }}
          transition={{
            duration: 2.5 + Math.random(),
            delay: p.delay,
            ease: "easeIn",
          }}
        />
      ))}
    </div>
  );
}

export default function CompletionScreen({ stats, onNext }) {
  return (
    <motion.div
      className="completion-screen"
      initial={{ opacity: 0, scale: 0.8 }}
      animate={{ opacity: 1, scale: 1 }}
      transition={{ type: "spring", stiffness: 200, damping: 20 }}
    >
      <Confetti />

      <motion.div
        className="completion-trophy"
        initial={{ scale: 0 }}
        animate={{ scale: 1 }}
        transition={{ type: "spring", delay: 0.3, stiffness: 300 }}
      >
        &#127942;
      </motion.div>

      <motion.h1
        className="completion-title"
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.5 }}
      >
        完全制覇！
      </motion.h1>

      <motion.div
        className="completion-stats"
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.7 }}
      >
        <div className="completion-venue">
          {stats.venues.join(" + ")} {stats.year}
        </div>
        <div className="completion-numbers">
          <div className="stat-item">
            <span className="stat-value">{stats.totalSwiped}</span>
            <span className="stat-label">本チェック</span>
          </div>
          <div className="stat-item">
            <span className="stat-value">{stats.savedCount}</span>
            <span className="stat-label">本保存</span>
          </div>
        </div>
      </motion.div>

      <motion.div
        className="completion-badges"
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 0.9 }}
      >
        {stats.venues.map((v) => (
          <span key={v} className="badge-large">
            &#127942; {v} {stats.year}
          </span>
        ))}
      </motion.div>

      <motion.button
        className="btn btn-primary btn-lg"
        onClick={onNext}
        initial={{ y: 20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ delay: 1.1 }}
        whileHover={{ scale: 1.05 }}
        whileTap={{ scale: 0.95 }}
      >
        次のベニューへ &#8594;
      </motion.button>
    </motion.div>
  );
}
