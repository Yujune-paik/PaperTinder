import { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useVenueList, useVenuePreferences } from "../usePreferences";
import VenueSettings from "./VenueSettings";

const THIS_YEAR = new Date().getFullYear();

export default function SearchBar({ onSearch, loading, searchProgress }) {
  const { venues, groups } = useVenueList();
  const { preferences } = useVenuePreferences();
  const [selectedVenues, setSelectedVenues] = useState([]);
  const [selectedYear, setSelectedYear] = useState(null);
  const [keyword, setKeyword] = useState("");
  const [decks, setDecks] = useState([]);
  const [settingsOpen, setSettingsOpen] = useState(false);

  useEffect(() => {
    fetch("/api/decks").then((r) => r.json()).then((d) => setDecks(d.decks || [])).catch(() => {});
  }, []);

  const venueMeta = useMemo(() => {
    const map = {};
    for (const v of venues) map[v.name] = v;
    return map;
  }, [venues]);

  const preferredSet = useMemo(() => new Set(preferences || []), [preferences]);

  const hasDeck = useMemo(() => {
    if (selectedVenues.length !== 1 || !selectedYear) return false;
    return decks.some((d) => d.venue === selectedVenues[0] && d.year === selectedYear);
  }, [selectedVenues, selectedYear, decks]);

  const yearRange = useMemo(() => {
    let earliest = 2000;
    if (selectedVenues.length > 0) {
      earliest = Math.min(
        ...selectedVenues.map((v) => venueMeta[v]?.since ?? 2000)
      );
    }
    earliest = Math.max(earliest, 2000);
    const years = [];
    for (let y = THIS_YEAR; y >= earliest; y--) years.push(y);
    return years;
  }, [selectedVenues, venueMeta]);

  const selectVenue = (venue) => {
    setSelectedVenues((prev) =>
      prev.includes(venue) ? [] : [venue]
    );
  };

  const handleSearch = () => {
    if (selectedVenues.length === 0) return;
    onSearch(selectedVenues, selectedYear, keyword || null);
  };

  const groupedVenues = useMemo(() => {
    return (groups || []).map((group) => ({
      label: group,
      venues: venues.filter((v) => v.group === group && preferredSet.has(v.name)),
    })).filter((g) => g.venues.length > 0);
  }, [venues, groups, preferredSet]);

  return (
    <div className="search-bar">
      <div className="search-title-row">
        <h3 className="search-title">&#128269; 論文を探す</h3>
        <button
          type="button"
          className="venue-settings-open-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label="会議を編集"
          title="表示する会議を編集"
        >
          &#9881;
        </button>
      </div>

      {groupedVenues.length === 0 ? (
        <div className="search-empty-venues">
          表示する会議が設定されていません。
          <button
            type="button"
            className="link-btn"
            onClick={() => setSettingsOpen(true)}
          >
            会議を選択
          </button>
        </div>
      ) : (
        groupedVenues.map((group) => (
          <div key={group.label} className="venue-group">
            <div className="venue-group-label">{group.label}</div>
            <div className="venue-chips">
              {group.venues.map((v) => (
                <button
                  key={v.name}
                  className={`chip ${selectedVenues.includes(v.name) ? "chip-active" : ""}`}
                  onClick={() => selectVenue(v.name)}
                >
                  {v.name}
                </button>
              ))}
            </div>
          </div>
        ))
      )}

      <div className="year-selector">
        <div className="venue-group-label">年度</div>
        <select
          className="year-dropdown"
          value={selectedYear ?? ""}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
        >
          <option value="" disabled>選択してください</option>
          {yearRange.map((y) => (
            <option key={y} value={y}>{y}</option>
          ))}
        </select>
      </div>

      <div className="keyword-input">
        <input
          type="text"
          placeholder="キーワード（任意）"
          value={keyword}
          onChange={(e) => setKeyword(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && handleSearch()}
        />
      </div>

      <button
        className="btn btn-primary btn-search"
        onClick={handleSearch}
        disabled={loading || selectedVenues.length === 0 || !selectedYear}
      >
        {loading ? (
          <span className="spinner" />
        ) : (
          <>{selectedVenues.length > 0 && selectedYear
            ? hasDeck
              ? `${selectedVenues[0]}'${String(selectedYear).slice(-2)} を読み込む`
              : `${selectedVenues[0]}'${String(selectedYear).slice(-2)} を検索`
            : "会議と年度を選択"}</>
        )}
      </button>

      <AnimatePresence>
        {searchProgress && (
          <motion.div
            className="search-progress"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.3 }}
          >
            <div className="search-progress-header">
              <motion.div
                className="search-progress-count"
                key={searchProgress.totalFound}
                initial={{ scale: 1.4, color: "#6c5ce7" }}
                animate={{ scale: 1, color: "#e8e8f0" }}
                transition={{ type: "spring", stiffness: 300 }}
              >
                {searchProgress.totalFound}
              </motion.div>
              <span className="search-progress-label">件の論文を発見</span>
            </div>

            {searchProgress.currentVenue && (
              <div className="search-progress-venue">
                <span className="search-progress-dot" />
                <span>{searchProgress.currentVenue} を検索中...</span>
              </div>
            )}

            <div className="search-progress-bar-track">
              <motion.div
                className="search-progress-bar-fill"
                initial={{ width: "0%" }}
                animate={{
                  width: `${((searchProgress.venueIndex + (searchProgress.currentVenue ? 0.5 : 1)) / Math.max(searchProgress.venueTotal, 1)) * 100}%`,
                }}
                transition={{ duration: 0.5, ease: "easeOut" }}
              />
            </div>

            <div className="search-progress-venues">
              {Object.entries(searchProgress.venueDone || {}).map(([v, count]) => (
                <motion.span
                  key={v}
                  className="search-progress-venue-badge"
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ type: "spring", stiffness: 400, damping: 15 }}
                >
                  {v}: {count}
                </motion.span>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <VenueSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} />
    </div>
  );
}
