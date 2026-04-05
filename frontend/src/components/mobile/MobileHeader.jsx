import StreakBadge from "../StreakBadge";

export default function MobileHeader({ todayCount, onExport }) {
  return (
    <header className="m-header">
      <h1 className="m-logo">PaperTinder</h1>
      <div className="m-header-right">
        <StreakBadge todayCount={todayCount} />
        <button className="m-header-btn" onClick={onExport} title="Export">
          &#128196;
        </button>
      </div>
    </header>
  );
}
