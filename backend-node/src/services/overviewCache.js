// Tiny shared cache for the dashboard / admin aggregates. Kept in its own module so the upload controller can clear
// it the moment a job completes (otherwise a finished analysis would not show up for up to 30 s).
const TTL_MS = 30 * 1000;
const store = new Map(); // key -> { expires, payload }

module.exports = {
  get: (key) => { const h = store.get(key); return h && h.expires > Date.now() ? h.payload : null; },
  set: (key, payload, ttl = TTL_MS) => { store.set(key, { expires: Date.now() + ttl, payload }); },
  clear: () => store.clear(),
};
