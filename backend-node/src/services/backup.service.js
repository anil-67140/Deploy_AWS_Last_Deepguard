/**
 * FR-20 — Data Backup and Recovery.
 *
 * Business rule from the spec: backups run daily at 2:00 AM and are retained
 * for 30 days. Recovery = restore any retained backup back into MongoDB.
 *
 * Design notes
 *  - Pure Node/Mongoose: no `mongodump` binary needed (which many Windows dev
 *    machines don't have on PATH).
 *  - Each backup is ONE file: deepguard-backup-YYYYMMDD-HHmmss.ndjson.gz —
 *    streamed line-by-line through gzip so large collections never sit fully
 *    in memory. Line 1 is a header, then {c: collection, d: document} lines,
 *    then a final {_end: counts} line used to detect truncated/corrupt files.
 *  - Written to a .tmp file and renamed only when complete, so a crash
 *    mid-backup can never leave a half-written file that looks restorable.
 *  - Restore verifies the whole file first, then upserts by _id — so it is
 *    idempotent (restoring twice is harmless) and it never deletes anything.
 *  - Backup names are validated against a strict pattern before touching the
 *    filesystem (blocks path traversal like "../../etc/passwd").
 *  - Models are injected (createBackupService({ models, dir })) so the logic
 *    is unit-testable without a live database.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const readline = require('readline');
const { pipeline } = require('stream/promises');

const NAME_RE = /^deepguard-backup-\d{8}-\d{6}\.ndjson\.gz$/;
const RESTORE_BATCH = 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

const pad = (n) => String(n).padStart(2, '0');
function stamp(d = new Date()) {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

function createBackupService({ models, dir, retentionDays = 30 }) {
  fs.mkdirSync(dir, { recursive: true });
  let running = false; // prevents two backups (e.g. cron + manual click) overlapping

  function resolveName(name) {
    if (typeof name !== 'string' || !NAME_RE.test(name)) {
      const e = new Error('Invalid backup name'); e.status = 400; throw e;
    }
    const full = path.join(dir, name);
    if (!fs.existsSync(full)) { const e = new Error('Backup not found'); e.status = 404; throw e; }
    return full;
  }

  async function runBackup() {
    if (running) { const e = new Error('A backup is already running'); e.status = 409; throw e; }
    running = true;
    const started = Date.now();
    const createdAt = new Date();
    const name = `deepguard-backup-${stamp(createdAt)}.ndjson.gz`;
    const finalPath = path.join(dir, name);
    const tmpPath = finalPath + '.tmp';
    try {
      const gz = zlib.createGzip();
      const out = fs.createWriteStream(tmpPath);
      const done = pipeline(gz, out);
      const write = async (obj) => {
        if (!gz.write(JSON.stringify(obj) + '\n')) await new Promise((r) => gz.once('drain', r));
      };

      const counts = {};
      await write({ _meta: { version: 1, createdAt: createdAt.toISOString(), collections: Object.keys(models) } });
      for (const [cname, Model] of Object.entries(models)) {
        counts[cname] = 0;
        for await (const doc of Model.find({}).lean().cursor()) {
          await write({ c: cname, d: doc });
          counts[cname]++;
        }
      }
      await write({ _end: counts });
      gz.end();
      await done;
      fs.renameSync(tmpPath, finalPath);

      const size = fs.statSync(finalPath).size;
      const meta = { name, createdAt: createdAt.toISOString(), size, counts, durationMs: Date.now() - started };
      fs.writeFileSync(finalPath + '.meta.json', JSON.stringify(meta));
      const pruned = pruneOldBackups();
      console.log(`💾 Backup ${name}: ${JSON.stringify(counts)}, ${(size / 1024).toFixed(1)} KB` +
        (pruned.length ? `, pruned ${pruned.length} old` : ''));
      return { ...meta, pruned };
    } catch (err) {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
      throw err;
    } finally {
      running = false;
    }
  }

  function pruneOldBackups(now = Date.now()) {
    const removed = [];
    for (const f of fs.readdirSync(dir)) {
      if (!NAME_RE.test(f)) continue;
      const full = path.join(dir, f);
      if (now - fs.statSync(full).mtimeMs > retentionDays * DAY_MS) {
        fs.unlinkSync(full);
        try { fs.unlinkSync(full + '.meta.json'); } catch (_) {}
        removed.push(f);
      }
    }
    return removed;
  }

  function listBackups() {
    return fs.readdirSync(dir)
      .filter((f) => NAME_RE.test(f))
      .map((f) => {
        const full = path.join(dir, f);
        const st = fs.statSync(full);
        let counts = null;
        try { counts = JSON.parse(fs.readFileSync(full + '.meta.json', 'utf8')).counts; } catch (_) {}
        return { name: f, size: st.size, createdAt: st.mtime.toISOString(), counts };
      })
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async function* readLines(full) {
    const rl = readline.createInterface({ input: fs.createReadStream(full).pipe(zlib.createGunzip()), crlfDelay: Infinity });
    for await (const line of rl) if (line.trim()) yield JSON.parse(line);
  }

  /** Reads the entire file; throws if it's truncated/corrupt. Returns per-collection counts. */
  async function verifyBackup(name) {
    const full = resolveName(name);
    const seen = {}; let end = null; let header = false;
    try {
      for await (const rec of readLines(full)) {
        if (rec._meta) header = true;
        else if (rec._end) end = rec._end;
        else if (rec.c) seen[rec.c] = (seen[rec.c] || 0) + 1;
      }
    } catch (err) {
      throw Object.assign(new Error(`Backup is corrupt or unreadable: ${err.message}`), { status: 422 });
    }
    if (!header || !end) throw Object.assign(new Error('Backup is incomplete (missing header/end marker)'), { status: 422 });
    for (const [c, n] of Object.entries(end)) {
      if ((seen[c] || 0) !== n) {
        throw Object.assign(new Error(`Backup integrity check failed for "${c}": expected ${n}, found ${seen[c] || 0}`), { status: 422 });
      }
    }
    return end;
  }

  async function restoreBackup(name) {
    const full = resolveName(name);
    const expected = await verifyBackup(name); // never start writing from a bad file
    const restored = {}; const buffers = {};
    const flush = async (c) => {
      const buf = buffers[c];
      if (!buf || buf.length === 0) return;
      await models[c].bulkWrite(
        buf.map((d) => ({ replaceOne: { filter: { _id: d._id }, replacement: d, upsert: true } })),
        { ordered: false, timestamps: false }
      );
      restored[c] = (restored[c] || 0) + buf.length;
      buffers[c] = [];
    };
    for await (const rec of readLines(full)) {
      if (!rec.c || !models[rec.c]) continue; // header/end lines, or a collection this build doesn't know
      (buffers[rec.c] ||= []).push(rec.d);
      if (buffers[rec.c].length >= RESTORE_BATCH) await flush(rec.c);
    }
    for (const c of Object.keys(buffers)) await flush(c);
    console.log(`♻️  Restored ${name}: ${JSON.stringify(restored)}`);
    return { name, restored, expected };
  }

  function getBackupPath(name) { return resolveName(name); }

  function deleteBackup(name) {
    const full = resolveName(name);
    fs.unlinkSync(full);
    try { fs.unlinkSync(full + '.meta.json'); } catch (_) {}
  }

  /** Daily schedule (default 02:00 server time, per FR-20). Returns the cron task. */
  function startScheduler(expr = process.env.BACKUP_CRON || '0 2 * * *') {
    const cron = require('node-cron');
    if (!cron.validate(expr)) throw new Error(`Invalid BACKUP_CRON expression: ${expr}`);
    const task = cron.schedule(expr, () => {
      runBackup().catch((e) => console.error(`❌ Scheduled backup failed: ${e.message}`));
    });
    console.log(`🗓️  Automatic backups scheduled (${expr}), retention ${retentionDays} days → ${dir}`);
    return task;
  }

  return { runBackup, listBackups, verifyBackup, restoreBackup, deleteBackup, getBackupPath, pruneOldBackups, startScheduler };
}

module.exports = { createBackupService, NAME_RE };
