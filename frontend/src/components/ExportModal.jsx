import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "framer-motion";

const SERVICES = {
  scrapbox_push: {
    label: "Scrapbox に直接投稿",
    icon: "\u{1F4DD}",
    description: "日次サマリーページをScrapboxプロジェクトに直接インポート",
    requiresConfig: true,
  },
  scrapbox_copy: {
    label: "Scrapbox テキストをコピー",
    icon: "\u{1F4CB}",
    description: "Scrapboxフォーマットのテキストをクリップボードにコピー",
    requiresConfig: false,
  },
};

export default function ExportModal({ onClose }) {
  const [serviceStatus, setServiceStatus] = useState({});
  const [selectedService, setSelectedService] = useState(null);
  const [phase, setPhase] = useState("select");
  const [exportText, setExportText] = useState("");
  const [result, setResult] = useState(null);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetch("/api/export/status")
      .then((r) => r.json())
      .then((data) => setServiceStatus(data))
      .catch(() => {});
  }, []);

  const handleSelectService = (key) => {
    setSelectedService(key);
    if (key === "scrapbox_copy") {
      handleScrapboxCopy();
    } else {
      setPhase("confirm");
    }
  };

  const handleScrapboxCopy = async () => {
    setPhase("loading");
    setLoading(true);
    try {
      const res = await fetch("/api/export/scrapbox");
      const data = await res.json();
      setExportText(data.text || "");
      setPhase("copy");
    } catch {
      setExportText("エクスポートに失敗しました。");
      setPhase("copy");
    } finally {
      setLoading(false);
    }
  };

  const handleExport = async () => {
    setPhase("loading");
    setLoading(true);
    try {
      let res;
      if (selectedService === "scrapbox_push") {
        res = await fetch("/api/export/scrapbox/push", { method: "POST" });
      } else if (selectedService === "notebooklm") {
        res = await fetch("/api/export/notebooklm", { method: "POST" });
      }
      const data = await res.json();
      setResult(data);
      setPhase("result");
    } catch (e) {
      setResult({ status: "error", message: e.message });
      setPhase("result");
    } finally {
      setLoading(false);
    }
  };

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

  const renderSelect = () => (
    <div className="export-services">
      {Object.entries(SERVICES).map(([key, svc]) => {
        const isConfigured =
          !svc.requiresConfig ||
          (key === "scrapbox_push" && serviceStatus.scrapbox) ||
          (key === "notebooklm" && serviceStatus.notebooklm);
        const disabled = svc.requiresConfig && !isConfigured;

        return (
          <button
            key={key}
            className={`export-service-btn ${disabled ? "disabled" : ""}`}
            onClick={() => !disabled && handleSelectService(key)}
            disabled={disabled}
          >
            <span className="export-service-icon">{svc.icon}</span>
            <div className="export-service-info">
              <span className="export-service-label">{svc.label}</span>
              <span className="export-service-desc">
                {disabled ? "未設定 — 環境変数を設定してください" : svc.description}
              </span>
            </div>
            {!disabled && <span className="export-service-arrow">&rsaquo;</span>}
            {disabled && <span className="export-service-badge">未設定</span>}
          </button>
        );
      })}
    </div>
  );

  const renderConfirm = () => {
    const svc = SERVICES[selectedService];
    return (
      <div className="export-confirm">
        <div className="export-confirm-icon">{svc.icon}</div>
        <h3>{svc.label}</h3>
        <p>{svc.description}</p>
        <p className="export-confirm-note">
          保存した論文のセクションごとの要約を日次ページとしてエクスポートします。
        </p>
        <div className="export-confirm-actions">
          <button className="btn btn-ghost" onClick={() => setPhase("select")}>
            戻る
          </button>
          <button className="btn btn-primary" onClick={handleExport}>
            エクスポート実行
          </button>
        </div>
      </div>
    );
  };

  const renderLoading = () => (
    <div className="export-loading">
      <span className="spinner" />
      <p>エクスポート中...</p>
    </div>
  );

  const renderCopy = () => (
    <>
      <textarea
        className="export-textarea"
        value={exportText}
        readOnly
        rows={20}
      />
      <div className="modal-footer">
        <button
          className={`btn ${copied ? "btn-success" : "btn-primary"}`}
          onClick={handleCopy}
        >
          {copied ? "\u2713 コピー済み！" : "クリップボードにコピー"}
        </button>
        <p className="export-hint">
          Scrapboxの「ページをインポート」に貼り付けてください。
        </p>
      </div>
    </>
  );

  const renderResult = () => {
    if (!result) return null;
    const isOk = result.status === "ok" || result.status === "partial";
    return (
      <div className={`export-result ${isOk ? "success" : "error"}`}>
        <div className="export-result-icon">{isOk ? "\u2705" : "\u274C"}</div>
        <h3>{isOk ? "エクスポート完了" : "エラー"}</h3>
        {result.message && <p>{result.message}</p>}
        {result.project && <p>プロジェクト: {result.project}</p>}
        {result.pages_imported != null && (
          <p>{result.pages_imported}ページをインポートしました</p>
        )}
        {result.notebook_url && (
          <a
            href={result.notebook_url}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-primary export-open-link"
          >
            NotebookLMで開く
          </a>
        )}
        {result.papers_added != null && (
          <p>{result.papers_added}本の論文を追加しました</p>
        )}
        {result.errors && result.errors.length > 0 && (
          <div className="export-errors">
            <p>一部エラーがあります:</p>
            <ul>
              {result.errors.map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          </div>
        )}
        <button
          className="btn btn-ghost"
          onClick={() => {
            setPhase("select");
            setResult(null);
            setSelectedService(null);
          }}
        >
          戻る
        </button>
      </div>
    );
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
          <h2>
            {phase === "select" && "エクスポート先を選択"}
            {phase === "confirm" && "確認"}
            {phase === "loading" && "エクスポート中"}
            {phase === "copy" && "Scrapbox テキスト"}
            {phase === "result" && "結果"}
          </h2>
          <button className="modal-close" onClick={onClose}>
            &#10005;
          </button>
        </div>

        <div className="modal-body">
          <AnimatePresence mode="wait">
            <motion.div
              key={phase}
              initial={{ opacity: 0, x: 20 }}
              animate={{ opacity: 1, x: 0 }}
              exit={{ opacity: 0, x: -20 }}
              transition={{ duration: 0.15 }}
            >
              {phase === "select" && renderSelect()}
              {phase === "confirm" && renderConfirm()}
              {phase === "loading" && renderLoading()}
              {phase === "copy" && renderCopy()}
              {phase === "result" && renderResult()}
            </motion.div>
          </AnimatePresence>
        </div>
      </motion.div>
    </motion.div>
  );
}
