/**
 * FR-18 — Bulk Processing Queue.
 *
 * Multiple files can be uploaded at once; each becomes a queued job that a
 * bounded number of workers process, so a burst of uploads can't overload the
 * Node process or flood the AI Engine.
 *
 * Two interchangeable back-ends behind one interface:
 *   - "redis":  Bull queue on Redis (REDIS_URL set and reachable). Jobs are
 *               persisted in Redis — the spec's "Redis" business rule.
 *   - "memory": in-process FIFO with the same concurrency limit. Used when
 *               REDIS_URL is unset or Redis can't be reached, so the app
 *               works out of the box on a laptop with no extra services.
 *               (Queued-but-unstarted jobs are lost if the server restarts.)
 *
 * Interface: { mode, concurrency, add(data), getStatus(), close() }
 * `processor(data)` is called once per job and must return a promise.
 */

function createMemoryQueue({ processor, concurrency = 2 }) {
  const waiting = [];
  let active = 0, completed = 0, failed = 0, closed = false;

  function pump() {
    while (!closed && active < concurrency && waiting.length > 0) {
      const data = waiting.shift();
      active++;
      Promise.resolve()
        .then(() => processor(data))
        .then(() => { completed++; }, (err) => {
          failed++;
          console.error(`❌ Queue job failed (${data?.jobId}): ${err?.message || err}`);
        })
        .finally(() => { active--; setImmediate(pump); });
    }
  }

  return {
    mode: 'memory',
    concurrency,
    async add(data) { waiting.push(data); setImmediate(pump); return { position: waiting.length }; },
    async getStatus() { return { mode: 'memory', concurrency, waiting: waiting.length, active, completed, failed }; },
    async close() { closed = true; },
  };
}

async function createBullQueue({ processor, concurrency, redisUrl, connectTimeoutMs }) {
  const Bull = require('bull');
  const queue = new Bull('deepguard-uploads', redisUrl, {
    defaultJobOptions: { attempts: 1, removeOnComplete: 500, removeOnFail: 500 },
  });
  let lastError = null;
  queue.on('error', (e) => { lastError = e; }); // keep Redis blips from crashing the process

  // NOTE: queue.isReady() is NOT a connectivity check — Bull resolves it while
  // the ioredis client is still "connecting" and just buffers commands offline
  // (verified against a dead port). Only a real round-trip proves Redis is up.
  const ready = await Promise.race([
    queue.isReady().then(() => queue.client.ping()).then((pong) => pong === 'PONG', () => false),
    new Promise((r) => setTimeout(() => r(false), connectTimeoutMs)),
  ]);
  if (!ready) {
    // Bull's ioredis clients retry forever; shut them down before falling back.
    await Promise.race([queue.close(true).catch(() => {}), new Promise((r) => setTimeout(r, 1500))]);
    const e = new Error(lastError?.message || `no response from Redis within ${connectTimeoutMs}ms`);
    throw e;
  }

  queue.process(concurrency, (job) => processor(job.data));
  return {
    mode: 'redis',
    concurrency,
    async add(data) {
      const job = await queue.add(data);
      const counts = await queue.getJobCounts();
      return { position: (counts.waiting || 0) + (counts.active || 0), bullId: job.id };
    },
    async getStatus() {
      const c = await queue.getJobCounts();
      return { mode: 'redis', concurrency, waiting: c.waiting || 0, active: c.active || 0,
               completed: c.completed || 0, failed: c.failed || 0, delayed: c.delayed || 0 };
    },
    async close() { await queue.close(); },
  };
}

async function createUploadQueue({ processor, concurrency, redisUrl, connectTimeoutMs = 4000 } = {}) {
  const n = Math.max(1, parseInt(concurrency ?? process.env.QUEUE_CONCURRENCY ?? '2', 10) || 2);
  const url = redisUrl ?? process.env.REDIS_URL;
  if (url) {
    try {
      const q = await createBullQueue({ processor, concurrency: n, redisUrl: url, connectTimeoutMs });
      console.log(`📬 Upload queue: Redis (Bull), concurrency ${n}`);
      return q;
    } catch (err) {
      console.warn(`⚠️  REDIS_URL is set but Redis is unreachable (${err.message}) — ` +
        `falling back to the in-process queue (concurrency ${n}).`);
    }
  } else {
    console.log(`📬 Upload queue: in-process (set REDIS_URL to use Redis), concurrency ${n}`);
  }
  return createMemoryQueue({ processor, concurrency: n });
}

module.exports = { createUploadQueue, createMemoryQueue };
