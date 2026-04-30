import { createContext, useContext, useEffect, useState, useCallback } from "react";
import { GoogleOAuthProvider } from "@react-oauth/google";

const AuthContext = createContext({
  user: null,
  isAdmin: false,
  clientId: "",
  enabled: false,
  ready: false,
  login: async () => {},
  logout: async () => {},
  refresh: async () => {},
});

export function useAuth() {
  return useContext(AuthContext);
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [config, setConfig] = useState({ enabled: false, client_id: "" });
  const [ready, setReady] = useState(false);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch("/api/auth/me", { credentials: "include" });
      const data = await res.json();
      setUser(data.user || null);
    } catch {
      setUser(null);
    }
  }, []);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const res = await fetch("/api/auth/config");
        const data = await res.json();
        if (alive) setConfig(data);
      } catch {
        if (alive) setConfig({ enabled: false, client_id: "" });
      }
      await refresh();
      if (alive) setReady(true);
    })();
    return () => {
      alive = false;
    };
  }, [refresh]);

  const login = useCallback(async (credential) => {
    // Snapshot the anonymous reading list so we can merge it into the user's
    // account after login (so that a solo user who signs in later keeps what
    // they had saved while logged out).
    let preLoginItems = [];
    try {
      const snap = await fetch("/api/reading-list", { credentials: "include" });
      if (snap.ok) {
        const snapData = await snap.json();
        preLoginItems = Array.isArray(snapData.items) ? snapData.items : [];
      }
    } catch {
      /* ignore */
    }

    const res = await fetch("/api/auth/google", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ credential }),
    });
    if (!res.ok) throw new Error("login failed");
    const data = await res.json();
    setUser(data.user);

    if (preLoginItems.length > 0) {
      try {
        await fetch("/api/reading-list/merge", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify({ items: preLoginItems }),
        });
      } catch {
        /* merge is best-effort */
      }
    }

    return data.user;
  }, []);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST", credentials: "include" });
    setUser(null);
  }, []);

  const value = {
    user,
    isAdmin: !!user?.is_admin,
    clientId: config.client_id,
    enabled: !!config.enabled,
    ready,
    login,
    logout,
    refresh,
  };

  if (config.enabled && config.client_id) {
    return (
      <GoogleOAuthProvider clientId={config.client_id}>
        <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
      </GoogleOAuthProvider>
    );
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
