import { useCallback, useEffect, useState } from "react";
import { useAuth } from "./AuthContext";

const LOCAL_KEY = "pt_venue_preferences";

export function useVenueList() {
  const [venues, setVenues] = useState([]);
  const [groups, setGroups] = useState([]);
  const [defaults, setDefaults] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    fetch("/api/venues")
      .then((r) => r.json())
      .then((d) => {
        setVenues(d.venues || []);
        setGroups(d.groups || []);
        setDefaults(d.defaults || []);
      })
      .catch(() => {})
      .finally(() => setReady(true));
  }, []);

  return { venues, groups, defaults, ready };
}

export function useVenuePreferences() {
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
    [user]
  );

  return { preferences, setPreferences: savePreferences, loaded };
}
