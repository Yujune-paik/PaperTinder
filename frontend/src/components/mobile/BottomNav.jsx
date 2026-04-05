import { motion } from "framer-motion";

const TABS = [
  { id: "search", label: "検索", icon: "\uD83D\uDD0D" },
  { id: "swipe", label: "カード", icon: "\uD83C\uDCCF" },
  { id: "saved", label: "保存", icon: "\uD83D\uDD16" },
  { id: "progress", label: "進捗", icon: "\uD83D\uDCCA" },
];

export default function BottomNav({ activeTab, onChange, savedCount }) {
  return (
    <nav className="m-bottom-nav">
      {TABS.map((tab) => {
        const isActive = activeTab === tab.id;
        return (
          <button
            key={tab.id}
            className={`m-nav-tab ${isActive ? "m-nav-tab-active" : ""}`}
            onClick={() => onChange(tab.id)}
          >
            <span className="m-nav-icon">{tab.icon}</span>
            <span className="m-nav-label">{tab.label}</span>
            {tab.id === "saved" && savedCount > 0 && (
              <motion.span
                className="m-nav-badge"
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                key={savedCount}
              >
                {savedCount}
              </motion.span>
            )}
            {isActive && (
              <motion.div
                className="m-nav-indicator"
                layoutId="nav-indicator"
                transition={{ type: "spring", stiffness: 400, damping: 30 }}
              />
            )}
          </button>
        );
      })}
    </nav>
  );
}
