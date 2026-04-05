import { useState, useEffect } from "react";
import { motion } from "framer-motion";

export default function ExportModal({ onClose }) {
  const [exportText, setExportText] = useState("");
  const [loading, setLoading] = useState(true);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    const fetchExport = async () => {
      try {
        const res = await fetch("/api/export/scrapbox");
        const data = await res.json();
        setExportText(data.text || "");
      } catch {
        setExportText("エクスポートに失敗しました。");
      } finally {
        setLoading(false);
      }
    };
    fetchExport();
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(exportText);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = exportText;
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand("copy");
      document.body.removeChild(textarea);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <motion.div
      className="modal-overlay"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      onClick={onClose}
    >
      <motion.div
        className="modal-content export-modal"
        initial={{ y: 50, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ type: "spring", damping: 25 }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h2>&#128196; Scrapbox Export</h2>
          <button className="modal-close" onClick={onClose}>
            &#10005;
          </button>
        </div>

        <div className="modal-body">
          {loading ? (
            <div className="export-loading">
              <span className="spinner" />
              <p>エクスポートを生成中...</p>
            </div>
          ) : (
            <textarea
              className="export-textarea"
              value={exportText}
              readOnly
              rows={20}
            />
          )}
        </div>

        <div className="modal-footer">
          <button
            className={`btn ${copied ? "btn-success" : "btn-primary"}`}
            onClick={handleCopy}
            disabled={loading}
          >
            {copied ? "&#10003; コピー済み！" : "&#128203; クリップボードにコピー"}
          </button>
          <p className="export-hint">
            Scrapboxの「ページをインポート」に貼り付けてください。
          </p>
        </div>
      </motion.div>
    </motion.div>
  );
}
