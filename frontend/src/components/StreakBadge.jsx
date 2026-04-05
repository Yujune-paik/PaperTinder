import { useState, useEffect } from "react";

function getStreak() {
  const raw = localStorage.getItem("pt_streak_data");
  if (!raw) return { streak: 0, lastDate: null };
  try {
    return JSON.parse(raw);
  } catch {
    return { streak: 0, lastDate: null };
  }
}

function updateStreak() {
  const today = new Date().toDateString();
  const data = getStreak();

  if (data.lastDate === today) return data.streak;

  const yesterday = new Date();
  yesterday.setDate(yesterday.getDate() - 1);
  const yesterdayStr = yesterday.toDateString();

  let newStreak;
  if (data.lastDate === yesterdayStr) {
    newStreak = data.streak + 1;
  } else {
    newStreak = 1;
  }

  localStorage.setItem(
    "pt_streak_data",
    JSON.stringify({ streak: newStreak, lastDate: today })
  );
  return newStreak;
}

export default function StreakBadge({ todayCount }) {
  const [streak, setStreak] = useState(0);

  useEffect(() => {
    if (todayCount > 0) {
      setStreak(updateStreak());
    } else {
      setStreak(getStreak().streak);
    }
  }, [todayCount]);

  const badges = JSON.parse(localStorage.getItem("pt_badges") || "[]");

  return (
    <div className="streak-badge">
      <div className="streak-today">
        <span className="streak-number">{todayCount}</span>
        <span className="streak-label">本チェック</span>
      </div>
      {streak > 1 && (
        <div className="streak-days">
          <span className="streak-fire">&#128293;</span>
          <span>{streak}日連続</span>
        </div>
      )}
      {badges.length > 0 && (
        <div className="badges-row">
          {badges.slice(-3).map((b, i) => (
            <span key={i} className="badge-mini" title={b}>
              &#127942;
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
