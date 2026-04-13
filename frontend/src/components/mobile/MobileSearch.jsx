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

export default function MobileSearch({ onSearch, loading, searchProgress, onGoSaved, onGoProgress }) {
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
    return GROUPS.map((group) => ({
      label: group,
      venues: Object.entries(VENUE_META)
        .filter(([, meta]) => meta.group === group)
        .map(([name]) => name),
    }));
  }, []);

  return (
    <div className="m-search">
      <h2 className="m-search-title">Discover<br /><span style={{ color: 'var(--text-dim)' }}>New Knowledge</span></h2>

      <div className="m-search-scroll">
        {groupedVenues.map((group) => (
          <div key={group.label} className="m-venue-group">
            <div className="m-venue-group-label">{group.label}</div>
            <div className="m-venue-chips">
              {group.venues.map((v) => (
                <button
                  key={v}
                  className={`m-chip ${selectedVenues.includes(v) ? "m-chip-active" : ""}`}
                  onClick={() => selectVenue(v)}
                >
                  {v}
                </button>
              ))}
            </div>
          </div>
        ))}

        <div className="m-venue-group">
          <div className="m-venue-group-label">年度</div>
          <select
            className="m-year-dropdown"
            value={selectedYear}
            onChange={(e) => setSelectedYear(Number(e.target.value))}
          >
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
          disabled={loading || selectedVenues.length === 0}
        >
          {loading ? (
            <span className="spinner" />
          ) : (
            <>{selectedVenues.length > 0 ? `${selectedVenues[0]} を検索` : "検索"}</>

          )}
        </button>
      </div>
    </div>
  );
}
