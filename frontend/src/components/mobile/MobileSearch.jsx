import { useState, useMemo, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useVenueList, useVenuePreferences } from "../../usePreferences";
import VenueSettings from "../VenueSettings";

const THIS_YEAR = new Date().getFullYear();

export default function MobileSearch({ onSearch, loading, searchProgress, onGoSaved, onGoProgress }) {
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
    <div className="m-search">
      <div className="m-search-title-row">
        <h2 className="m-search-title">Discover<br /><span style={{ color: 'var(--text-dim)' }}>New Knowledge</span></h2>
        <button
          type="button"
          className="m-venue-settings-open-btn"
          onClick={() => setSettingsOpen(true)}
          aria-label="会議を編集"
          title="表示する会議を編集"
        >
          &#9881;
        </button>
      </div>

      <div className="m-search-scroll">
        {groupedVenues.length === 0 ? (
          <div className="m-search-empty-venues">
            表示する会議が設定されていません。
            <button
              type="button"
              className="m-link-btn"
              onClick={() => setSettingsOpen(true)}
            >
              会議を選択
            </button>
          </div>
        ) : (
          groupedVenues.map((group) => (
            <div key={group.label} className="m-venue-group">
              <div className="m-venue-group-label">{group.label}</div>
              <div className="m-venue-chips">
                {group.venues.map((v) => (
                  <button
                    key={v.name}
                    className={`m-chip ${selectedVenues.includes(v.name) ? "m-chip-active" : ""}`}
                    onClick={() => selectVenue(v.name)}
                  >
                    {v.name}
                  </button>
                ))}
              </div>
            </div>
          ))
        )}

        <div className="m-venue-group">
          <div className="m-venue-group-label">年度</div>
          <select
            className="m-year-dropdown"
            value={selectedYear ?? ""}
            onChange={(e) => setSelectedYear(Number(e.target.value))}
          >
            <option value="" disabled>選択してください</option>
            {yearRange.map((y) => (
              <option key={y} value={y}>{y}</option>
            ))}
          </select>
        </div>

        <div className="m-keyword-input">
          <input
            type="text"
            placeholder="キーワード（任意）"
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && handleSearch()}
          />
        </div>
      </div>

      <AnimatePresence>
        {searchProgress && (
          <motion.div
            className="m-search-progress"
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: "auto" }}
            exit={{ opacity: 0, height: 0 }}
          >
            <div className="m-search-progress-header">
              <motion.span
                className="m-search-progress-count"
                key={searchProgress.totalFound}
                initial={{ scale: 1.4 }}
                animate={{ scale: 1 }}
              >
                {searchProgress.totalFound}
              </motion.span>
              <span className="m-search-progress-label">件の論文を発見</span>
            </div>
            {searchProgress.currentVenue && (
              <div className="m-search-progress-venue">
                <span className="m-pulse-dot" />
                <span>{searchProgress.currentVenue} を検索中...</span>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      <div className="m-search-footer">
        <button
          className="m-search-btn"
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
      </div>

      <VenueSettings open={settingsOpen} onClose={() => setSettingsOpen(false)} mobile />
    </div>
  );
}
