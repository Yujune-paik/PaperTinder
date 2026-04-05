import { motion } from "framer-motion";

export default function ReadingList({ items, onClose, onRemove }) {
  return (
    <motion.div
      className="modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="modal-content reading-list-modal"
        initial={{ y: 50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", damping: 25 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>&#128278; 保存リスト</h2>
          <button className="modal-close" onClick={onClose}>
            &#10005;
          </button>
        </div>

        <div className="modal-body">
          {items.length === 0 ? (
            <div className="empty-list">
              <p>保存した論文はまだありません。</p>
              <p>右スワイプで論文を保存しましょう。</p>
            </div>
          ) : (
            <ul className="reading-items">
              {items.map((item) => (
                <li key={item.paper_id} className="reading-item">
                  <div className="reading-item-info">
                    <span className="reading-item-title">{item.title}</span>
                    <span className="reading-item-meta">
                      {item.venue} {item.year}
                    </span>
                  </div>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => onRemove(item.paper_id)}
                    title="削除"
                  >
                    &#128465;
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="modal-footer">
          <span className="item-count">{items.length}件の論文</span>
        </div>
      </motion.div>
    </motion.div>
  );
}
