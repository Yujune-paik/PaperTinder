import { motion, AnimatePresence } from "framer-motion";

const SHARE_ACTIONS = [
  {
    key: "notebooklm_share",
    icon: "\u{1F4E4}",
    label: "NotebookLM に共有",
    desc: "論文セッション文書をNotebookLMへ送信",
  },
  {
    key: "scrapbox_copy",
    icon: "\u{1F4CB}",
    label: "Scrapbox テキストをコピー",
    desc: "Scrapboxフォーマットでクリップボードにコピー",
  },
  {
    key: "scrapbox_push",
    icon: "\u{1F4DD}",
    label: "Scrapbox に直接投稿",
    desc: "Scrapboxプロジェクトに直接インポート",
  },
];

export default function MobileSaved({ items, onRemove, onExport }) {
  return (
    <div className="m-saved">
      <div className="m-saved-header">
        <h2>&#128278; 保存リスト</h2>
        <span className="m-saved-count">{items.length}件</span>
      </div>

      {items.length === 0 ? (
        <div className="m-saved-empty">
          <div className="m-empty-icon">&#128278;</div>
          <p>保存した論文はまだありません</p>
          <p className="m-saved-hint">カードを右スワイプで保存できます</p>
        </div>
      ) : (
        <ul className="m-saved-list">
          <AnimatePresence>
            {items.map((item) => (
              <motion.li
                key={item.paper_id}
                className="m-saved-item"
                initial={{ opacity: 0, x: -20 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: 20 }}
                transition={{ duration: 0.2 }}
              >
                <div className="m-saved-item-info">
                  <span className="m-saved-item-title">{item.title}</span>
                  <span className="m-saved-item-meta">
                    {item.venue} {item.year}
                  </span>
                </div>
                <button
                  className="m-saved-item-delete"
                  onClick={() => onRemove(item.paper_id)}
                  title="削除"
                >
                  &#128465;
                </button>
              </motion.li>
            ))}
          </AnimatePresence>
        </ul>
      )}

      <div className="m-saved-share">
        <div className="m-saved-share-label">共有・エクスポート</div>
        <div className="m-saved-share-actions">
          {SHARE_ACTIONS.map((action) => (
            <button
              key={action.key}
              className="m-saved-share-btn"
              onClick={() => onExport(action.key)}
              disabled={items.length === 0}
            >
              <span className="m-saved-share-btn-icon">{action.icon}</span>
              <div className="m-saved-share-btn-text">
                <span className="m-saved-share-btn-label">{action.label}</span>
                <span className="m-saved-share-btn-desc">{action.desc}</span>
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
