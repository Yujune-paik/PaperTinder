import { useMemo, useState, useEffect } from "react";
import { useVenueList, useVenuePreferences } from "../usePreferences";
import { useAuth } from "../AuthContext";

export default function VenueSettings({ open, onClose, mobile = false }) {
  const { venues, groups } = useVenueList();
  const { preferences, setPreferences, loaded } = useVenuePreferences();
  const { user } = useAuth();
  const [draft, setDraft] = useState([]);

  useEffect(() => {
    if (open && loaded) {
      setDraft(preferences || []);
    }
  }, [open, loaded, preferences]);

  const grouped = useMemo(() => {
    const byGroup = {};
    for (const v of venues) {
      if (!byGroup[v.group]) byGroup[v.group] = [];
      byGroup[v.group].push(v);
    }
    return (groups || []).map((g) => ({ label: g, venues: byGroup[g] || [] })).filter((g) => g.venues.length);
  }, [venues, groups]);

  if (!open) return null;

  const toggle = (name) => {
    setDraft((prev) =>
      prev.includes(name) ? prev.filter((v) => v !== name) : [...prev, name]
    );
  };

  const save = async () => {
    await setPreferences(draft);
    onClose?.();
  };

  const prefix = mobile ? "m-" : "";

  return (
    <div className={`${prefix}venue-settings-backdrop`} onClick={onClose}>
      <div
        className={`${prefix}venue-settings-modal`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className={`${prefix}venue-settings-header`}>
          <h3>表示する会議を選択</h3>
          <button
            type="button"
            className={`${prefix}venue-settings-close`}
            onClick={onClose}
            aria-label="close"
          >
            &times;
          </button>
        </div>

        <div className={`${prefix}venue-settings-note`}>
          {user
            ? "Google アカウントに設定が保存されます。"
            : "未ログインのため設定はこのブラウザのみに保存されます。"}
        </div>

        <div className={`${prefix}venue-settings-body`}>
          {grouped.map((g) => (
            <div key={g.label} className={`${prefix}venue-settings-group`}>
              <div className={`${prefix}venue-settings-group-label`}>{g.label}</div>
              <div className={`${prefix}venue-settings-items`}>
                {g.venues.map((v) => {
                  const active = draft.includes(v.name);
                  return (
                    <label
                      key={v.name}
                      className={`${prefix}venue-settings-item ${active ? "active" : ""}`}
                    >
                      <input
                        type="checkbox"
                        checked={active}
                        onChange={() => toggle(v.name)}
                      />
                      <span>{v.name}</span>
                    </label>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        <div className={`${prefix}venue-settings-footer`}>
          <button type="button" className={`${prefix}venue-settings-cancel`} onClick={onClose}>
            キャンセル
          </button>
          <button type="button" className={`${prefix}venue-settings-save`} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
