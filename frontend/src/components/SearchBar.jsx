import { useState, useMemo } from "react";
import { motion, AnimatePresence } from "framer-motion";

const VENUE_META = {
  CHI:              { group: "HCI",      since: 1982 },
  UIST:             { group: "HCI",      since: 1988 },
  CSCW:             { group: "HCI",      since: 1986 },
  Ubicomp:          { group: "HCI",      since: 2001 },
  ISWC:             { group: "HCI",      since: 1997 },
  HRI:              { group: "HCI",      since: 2006 },
  ISS:              { group: "HCI",      since: 2013 },
  DIS:              { group: "HCI",      since: 1995 },
  TEI:              { group: "HCI",      since: 2007 },
  MobileHCI:        { group: "HCI",      since: 1998 },
  NeurIPS:          { group: "AI / ML",  since: 1987 },
  CVPR:             { group: "AI / ML",  since: 1983 },
  ICCV:             { group: "AI / ML",  since: 1987 },
  ICML:             { group: "AI / ML",  since: 1984 },
  ECCV:             { group: "AI / ML",  since: 1990 },
  AAAI:             { group: "AI / ML",  since: 1980 },
  SIGGRAPH:         { group: "Graphics", since: 1974 },
  "SIGGRAPH Asia":  { group: "Graphics", since: 2008 },
  Nature:           { group: "Journals", since: 1869 },
  Science:          { group: "Journals", since: 1880 },
  "Science Robotics": { group: "Journals", since: 2016 },
};

const GROUPS = ["HCI", "AI / ML", "Graphics", "Journals"];

const THIS_YEAR = new Date().getFullYear();

export default function SearchBar({ onSearch, loading, searchProgress }) {
  const [selectedVenues, setSelectedVenues] = useState([]);
  const [selectedYear, setSelectedYear] = useState(2024);
  const [keyword, setKeyword] = useState("");

  const yearRange = useMemo(() => {
    let earliest = 2000;
    if (selectedVenues.length > 0) {
      earliest = Math.min(
        ...selectedVenues.map((v) => VENUE_META[v]?.since ?? 2000)
      );
    }
    earliest = Math.max(earliest, 2000);
    const years = [];
    for (let y = THIS_YEAR; y >= earliest; y--) years.push(y);
    return years;
  }, [selectedVenues]);

  const toggleVenue = (venue) => {
    setSelectedVenues((prev) =>
      prev.includes(venue) ? prev.filter((v) => v !== venue) : [...prev, venue]
    );
  };

  const handleSearch = () => {
    if (selectedVenues.length === 0) return;
    onSearch(selectedVenues, selectedYear, keyword || null);
  };

  const groupedVenues = useMemo(() => {
    return GROUPS.map((group) => ({
      label: group,
      venues: Object.entries(VENUE_META)
        .filter(([, meta]) => meta.group === group)
        .map(([name]) => name),
    }));
  }, []);

  return (
    <div className="search-bar">
      <h3 className="search-title">&#128269; 論文を探す</h3>

      {groupedVenues.map((group) => (
        <div key={group.label} className="venue-group">
          <div className="venue-group-label">{group.label}</div>
          <div className="venue-chips">
            {group.venues.map((v) => (
              <button
                key={v}
                className={`chip ${selectedVenues.includes(v) ? "chip-active" : ""}`}
                onClick={() => toggleVenue(v)}
              >
                {v}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="year-selector">
        <div className="venue-group-label">年度</div>
        <select
          className="year-dropdown"
          value={selectedYear}
          onChange={(e) => setSelectedYear(Number(e.target.value))}
        >
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
        disabled={loading || selectedVenues.length === 0}
      >
        {loading ? (
          <span className="spinner" />
        ) : (
          <>検索 ({selectedVenues.length}ベニュー)</>
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
    </div>
  );
}
