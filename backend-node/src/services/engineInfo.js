const axios = require('axios');

const AI_ENGINE_URL = process.env.AI_ENGINE_URL || 'http://127.0.0.1:8000';
const cache = new Map();    // path -> { data, at }
const inflight = new Map(); // path -> Promise (concurrent callers share one request)

/**
 * GET an info endpoint of the AI engine with a short cache and "stale-on-error".
 *
 * WHY: while a file is being analysed the engine is busy for many seconds at a time. Pages such as Performance, the
 * GNN checkbox and Admin → AI Models used to call the engine directly on every load, so they waited (up to 8-10 s)
 * or flipped to "AI Engine offline / demo mode" even though the engine was fine and just working. These are
 * descriptive, slow-changing facts (model info, GNN availability), so a recent answer is the right one to show.
 *
 *   ttlMs      — answers younger than this are served without calling the engine
 *   maxStaleMs — if the engine fails/times out, the last good answer is served for up to this long
 */
async function engineGet(path, { ttlMs = 30000, timeoutMs = 5000, maxStaleMs = 10 * 60 * 1000 } = {}) {
  const hit = cache.get(path);
  const now = Date.now();
  if (hit && now - hit.at < ttlMs) return hit.data;
  if (inflight.has(path)) return inflight.get(path);

  const p = axios
    .get(`${AI_ENGINE_URL}${path}`, { timeout: timeoutMs })
    .then(({ data }) => { cache.set(path, { data, at: Date.now() }); return data; })
    .catch((err) => {
      if (hit && Date.now() - hit.at < maxStaleMs) return hit.data; // engine busy → last known answer
      throw err;
    })
    .finally(() => inflight.delete(path));
  inflight.set(path, p);
  return p;
}

const clearEngineCache = () => cache.clear();

module.exports = { engineGet, clearEngineCache };
