import { motion, AnimatePresence } from "framer-motion";

export default function MobileSaved({ items, onRemove }) {
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
    </div>
  );
}
