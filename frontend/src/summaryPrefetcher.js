/**
 * Centralized summary prefetch manager.
 *
 * Lookahead model
 * ---------------
 * The parent component owns the deck and knows the order in which the
 * user will encounter cards. It tells the prefetcher "here are the next
 * N papers, in order" via ``setUpcoming(papersInEncounterOrder)``. The
 * prefetcher ensures the first ``LOOKAHEAD`` of those are actively being
 * prefetched (subject to ``CONCURRENCY``). Already-cached entries are
 * skipped; in-flight fetches that fall outside the window are left to
 * complete (the user is briefly viewing the card they just swiped past
 * and may scroll back).
 *
 * Why this model
 * --------------
 * A previous attempt used a LIFO queue + per-paper enqueue, which meant
 * the very first card the user landed on was the LAST to be processed.
 * The encounter-order model guarantees the next paper is generated
 * before the one after it — exactly aligned with the user's swipe motion.
 *
 * Tuning
 * ------
 * - LOOKAHEAD = 6: ≈ 2 generation cycles (CONCURRENCY × 2). At ~20 s
 *   per card and ~20 s cold gen, a 6-deep buffer leaves ≥2× safety.
 * - CONCURRENCY = 3: parallel SSE streams. Higher saturates the
 *   serverless backend; lower starves the lookahead.
 */

const CONCURRENCY = 3;
const LOOKAHEAD = 6;
const CHUNK_THROTTLE_MS = 250;
const FETCH_TIMEOUT_MS = 90_000;

export class SummaryPrefetcher {
  constructor() {
    this._active = 0;            // count of in-flight fetches
    this._cache = new Map();     // paperId → entry
    this._listeners = new Map(); // paperId → Set<callback>
    this._abortControllers = new Map();
    this._chunkTimers = new Map();

    this._upcoming = [];         // papers in user encounter order
    this._lookahead = LOOKAHEAD;
    this._scheduled = false;
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /**
   * Replace the prefetch queue with the next batch of papers in user
   * encounter order. The prefetcher will work on the first ``LOOKAHEAD``
   * entries.
   */
  setUpcoming(papers) {
    this._upcoming = Array.isArray(papers) ? papers.slice() : [];
    this._scheduleWindow();
  }

  setLookahead(n) {
    if (Number.isFinite(n) && n >= 1) {
      this._lookahead = n;
      this._scheduleWindow();
    }
  }

  // Subscribe / unsubscribe from progressive updates for a specific paper.
  subscribe(paperId, callback) {
    if (!this._listeners.has(paperId)) {
      this._listeners.set(paperId, new Set());
    }
    this._listeners.get(paperId).add(callback);
    return this._cache.get(paperId) || null;
  }

  unsubscribe(paperId, callback) {
    const set = this._listeners.get(paperId);
    if (set) {
      set.delete(callback);
      if (set.size === 0) this._listeners.delete(paperId);
    }
  }

  getEntry(paperId) {
    return this._cache.get(paperId) || null;
  }

  retry(paper) {
    const pid = paper.paper_id;
    this._abortControllers.get(pid)?.abort();
    this._abortControllers.delete(pid);
    this._cache.delete(pid);
    const timer = this._chunkTimers.get(pid);
    if (timer) {
      clearTimeout(timer);
      this._chunkTimers.delete(pid);
    }
    this._scheduleWindow();
  }

  reset() {
    for (const ac of this._abortControllers.values()) ac.abort();
    this._abortControllers.clear();
    for (const timer of this._chunkTimers.values()) clearTimeout(timer);
    this._chunkTimers.clear();
    this._upcoming = [];
    this._cache.clear();
    this._active = 0;
  }

  get readyCount() {
    let count = 0;
    for (const entry of this._cache.values()) {
      if (entry.summary && !entry.loading) count++;
    }
    return count;
  }

  get totalQueued() {
    return this._cache.size;
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  _scheduleWindow() {
    // Coalesce multiple synchronous calls into a single processing pass.
    if (this._scheduled) return;
    this._scheduled = true;
    Promise.resolve().then(() => {
      this._scheduled = false;
      this._fillWindow();
    });
  }

  _fillWindow() {
    const end = Math.min(this._upcoming.length, this._lookahead);
    for (let i = 0; i < end && this._active < CONCURRENCY; i++) {
      const paper = this._upcoming[i];
      if (!paper) continue;
      const pid = paper.paper_id;
      const existing = this._cache.get(pid);
      // Already done or already in flight — skip.
      if (existing && (!existing.loading || this._abortControllers.has(pid))) {
        continue;
      }
      // Start a fresh fetch.
      this._cache.set(pid, {
        loading: true,
        summary: null,
        figures: [],
        streamText: "",
        error: false,
      });
      this._active++;
      this._fetchSummary(paper).finally(() => {
        this._active--;
        this._scheduleWindow();
      });
    }
  }

  _notify(paperId) {
    const entry = this._cache.get(paperId);
    if (!entry) return;
    const cbs = this._listeners.get(paperId);
    if (cbs) {
      const snapshot = { ...entry };
      cbs.forEach((cb) => cb(snapshot));
    }
  }

  _notifyThrottled(paperId) {
    if (this._chunkTimers.has(paperId)) return;
    this._chunkTimers.set(
      paperId,
      setTimeout(() => {
        this._chunkTimers.delete(paperId);
        this._notify(paperId);
      }, CHUNK_THROTTLE_MS),
    );
  }

  async _fetchSummary(paper) {
    const pid = paper.paper_id;
    const ac = new AbortController();
    this._abortControllers.set(pid, ac);

    const timeout = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);

    try {
      // Prefer the cached path (GET) — server hits its summary cache
      // without re-uploading paper metadata.
      let res;
      try {
        res = await fetch(
          `/api/stream/${encodeURIComponent(pid)}`,
          { signal: ac.signal, credentials: "include" },
        );
        if (!res.ok) throw new Error("cache miss");
      } catch (e) {
        if (e.name === "AbortError") return;
        res = await fetch("/api/stream-inline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          credentials: "include",
          body: JSON.stringify(paper),
          signal: ac.signal,
        });
      }

      if (!res.ok) throw new Error("Stream failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          try {
            const data = JSON.parse(line.slice(6));
            const entry = this._cache.get(pid);
            if (!entry) continue;

            if (data.type === "figures") {
              entry.figures = data.urls || [];
              this._notify(pid);
            } else if (data.type === "chunk") {
              fullText += data.text;
              entry.streamText = fullText;
              this._notifyThrottled(pid);
            } else if (data.type === "summary") {
              entry.summary = data.data;
              entry.loading = false;
              this._notify(pid);
            } else if (data.type === "done") {
              entry.loading = false;
              this._notify(pid);
            } else if (data.type === "error" || data.type === "rate_limited") {
              entry.loading = false;
              entry.error = true;
              entry.errorMessage = data.message || "";
              this._notify(pid);
            }
          } catch {
            /* ignore parse errors */
          }
        }
      }

      const entry = this._cache.get(pid);
      if (entry && entry.loading) {
        entry.loading = false;
        if (!entry.summary && !fullText) entry.error = true;
        this._notify(pid);
      }
    } catch (e) {
      if (e.name === "AbortError") {
        const entry = this._cache.get(pid);
        if (entry && entry.loading) {
          entry.loading = false;
          entry.error = true;
          this._notify(pid);
        }
        return;
      }
      const entry = this._cache.get(pid);
      if (entry) {
        entry.loading = false;
        entry.error = true;
        this._notify(pid);
      }
    } finally {
      clearTimeout(timeout);
      this._abortControllers.delete(pid);
    }
  }
}
