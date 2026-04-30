import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";
import { useAuth } from "./AuthContext";

const LOCAL_KEY = "pt_venue_preferences";

// ---------------------------------------------------------------------------
// Venue list (immutable catalog from backend) — shared via context so multiple
// components don't each re-fetch /api/venues.
// ---------------------------------------------------------------------------
const VenueListContext = createContext({
  venues: [],
  groups: [],
  defaults: [],
  ready: false,
});

export function VenueListProvider({ children }) {
  const [venues, setVenues] = useState([]);
  const [groups, setGroups] = useState([]);
  const [defaults, setDefaults] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let alive = true;
    fetch("/api/venues")
      .then((r) => r.json())
      .then((d) => {
        if (!alive) return;
        setVenues(d.venues || []);
        setGroups(d.groups || []);
        setDefaults(d.defaults || []);
      })
      .catch(() => {})
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  const value = useMemo(
    () => ({ venues, groups, defaults, ready }),
    [venues, groups, defaults, ready],
  );
  return <VenueListContext.Provider value={value}>{children}</VenueListContext.Provider>;
}

export function useVenueList() {
  return useContext(VenueListContext);
}

// ---------------------------------------------------------------------------
// User venue preferences — single source of truth via context. Saving from
// any consumer (e.g. VenueSettings modal) updates the shared state, so other
// consumers (e.g. SearchBar) re-render immediately.
// ---------------------------------------------------------------------------
const VenuePreferencesContext = createContext({
  preferences: null,
  setPreferences: async () => {},
  loaded: false,
});

export function VenuePreferencesProvider({ children }) {
  const { user } = useAuth();
  const { defaults, ready: venuesReady } = useVenueList();
  const [preferences, setPreferences] = useState(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!venuesReady) return;
    let cancelled = false;

    (async () => {
      if (user) {
        try {
          const res = await fetch("/api/user/preferences", {
            credentials: "include",
          });
          const data = await res.json();
          if (!cancelled) {
            setPreferences(data.venue_preferences || defaults);
            setLoaded(true);
          }
          return;
        } catch {
          /* fall through */
        }
      }
      const local = localStorage.getItem(LOCAL_KEY);
      if (local) {
        try {
          const parsed = JSON.parse(local);
          if (Array.isArray(parsed)) {
            if (!cancelled) {
              setPreferences(parsed);
              setLoaded(true);
            }
            return;
          }
        } catch {
          /* ignore */
        }
      }
      if (!cancelled) {
        setPreferences(defaults);
        setLoaded(true);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [user, venuesReady, defaults]);

  const savePreferences = useCallback(
    async (next) => {
      setPreferences(next);
      if (user) {
        try {
          await fetch("/api/user/preferences", {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            credentials: "include",
            body: JSON.stringify({ venue_preferences: next }),
          });
        } catch {
          /* ignore */
        }
      } else {
        try {
          localStorage.setItem(LOCAL_KEY, JSON.stringify(next));
        } catch {
          /* ignore */
        }
      }
    },
    [user],
  );

  const value = useMemo(
    () => ({ preferences, setPreferences: savePreferences, loaded }),
    [preferences, savePreferences, loaded],
  );

  return (
    <VenuePreferencesContext.Provider value={value}>
      {children}
    </VenuePreferencesContext.Provider>
  );
}

export function useVenuePreferences() {
  return useContext(VenuePreferencesContext);
}
