/**
 * Centralized summary prefetch manager.
 * Processes paper summaries with limited concurrency so the server
 * is not overwhelmed, and starts fetching during the search phase
 * so cards already have data when they appear.
 */

const CONCURRENCY = 3;
const CHUNK_THROTTLE_MS = 250;

export class SummaryPrefetcher {
  constructor() {
    this._active = 0;
    this._queue = [];
    this._cache = new Map();
    this._listeners = new Map();
    this._abortControllers = new Map();
    this._chunkTimers = new Map();
  }

  getEntry(paperId) {
    return this._cache.get(paperId) || null;
  }

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

  enqueue(paper) {
    const pid = paper.paper_id;
    if (this._cache.has(pid)) return;
    this._cache.set(pid, {
      loading: true,
      summary: null,
      figures: [],
      streamText: "",
      error: false,
    });
    this._queue.push(paper);
    this._processQueue();
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
      }, CHUNK_THROTTLE_MS)
    );
  }

  _processQueue() {
    while (this._active < CONCURRENCY && this._queue.length > 0) {
      const paper = this._queue.pop();
      this._active++;
      this._fetchSummary(paper).finally(() => {
        this._active--;
        this._processQueue();
      });
    }
  }

  async _fetchSummary(paper) {
    const pid = paper.paper_id;
    const ac = new AbortController();
    this._abortControllers.set(pid, ac);

    try {
      let res;
      try {
        res = await fetch(
          `/api/stream/${encodeURIComponent(pid)}`,
          { signal: ac.signal }
        );
        if (!res.ok) throw new Error("cache miss");
      } catch (e) {
        if (e.name === "AbortError") return;
        res = await fetch("/api/stream-inline", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(paper),
          signal: ac.signal,
        });
      }

      if (!res.ok) throw new Error("Stream failed");

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      const pump = async () => {
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
              } else if (data.type === "error") {
                entry.loading = false;
                entry.error = true;
                this._notify(pid);
              }
            } catch {
              /* ignore parse errors */
            }
          }
        }
      };
      await pump();

      const entry = this._cache.get(pid);
      if (entry && entry.loading) {
        entry.loading = false;
        if (!entry.summary && !fullText) entry.error = true;
        this._notify(pid);
      }
    } catch (e) {
      if (e.name === "AbortError") return;
      const entry = this._cache.get(pid);
      if (entry) {
        entry.loading = false;
        entry.error = true;
        this._notify(pid);
      }
    } finally {
      this._abortControllers.delete(pid);
    }
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
    this.enqueue(paper);
  }

  reset() {
    for (const ac of this._abortControllers.values()) {
      ac.abort();
    }
    this._abortControllers.clear();
    for (const timer of this._chunkTimers.values()) {
      clearTimeout(timer);
    }
    this._chunkTimers.clear();
    this._queue = [];
    this._cache.clear();
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
}
