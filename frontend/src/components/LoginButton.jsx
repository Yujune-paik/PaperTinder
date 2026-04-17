import { useState } from "react";
import { GoogleLogin } from "@react-oauth/google";
import { useAuth } from "../AuthContext";

export default function LoginButton({ compact = false }) {
  const { user, enabled, login, logout } = useAuth();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState(null);

  if (!enabled) return null;

  if (user) {
    return (
      <div className="auth-user" style={{ position: "relative" }}>
        <button
          type="button"
          className="auth-user-btn"
          onClick={() => setOpen((o) => !o)}
          aria-label="User menu"
        >
          {user.picture ? (
            <img src={user.picture} alt="" className="auth-avatar" />
          ) : (
            <div className="auth-avatar auth-avatar-placeholder">
              {(user.name || user.email || "?").slice(0, 1)}
            </div>
          )}
          {!compact && <span className="auth-name">{user.name || user.email}</span>}
        </button>
        {open && (
          <div className="auth-menu">
            <div className="auth-menu-name">{user.name}</div>
            <div className="auth-menu-email">{user.email}</div>
            <button
              type="button"
              className="auth-menu-item"
              onClick={async () => {
                setOpen(false);
                await logout();
              }}
            >
              ログアウト
            </button>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="auth-login">
      <GoogleLogin
        onSuccess={async (resp) => {
          try {
            await login(resp.credential);
            setError(null);
          } catch (e) {
            setError(e.message || "login error");
          }
        }}
        onError={() => setError("login error")}
        theme="filled_black"
        size={compact ? "medium" : "medium"}
        shape="pill"
        text="signin"
      />
      {error && <div className="auth-login-error">{error}</div>}
    </div>
  );
}
