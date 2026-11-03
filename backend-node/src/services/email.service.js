/**
 * FR-19 — Alert Notifications (email leg).
 *
 * In-dashboard alerts already go out over Socket.IO; this adds the email half
 * the requirement calls for: a message when bulk processing completes (with a
 * stronger subject when high-risk anomalies were found) or fails.
 *
 * Configuration (backend-node/.env) — all optional:
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_SECURE (true for port 465),
 *   SMTP_USER, SMTP_PASS, SMTP_FROM, ALERT_EMAIL_TO (extra recipient, e.g. an
 *   admin mailbox), ALERT_EMAIL_MODE ("all" = every completed job, default;
 *   "critical_only" = only jobs with High/Critical detections), APP_URL.
 *   SMTP_DRY_RUN=true builds and logs the message without sending — handy for
 *   demos and tests when you don't have SMTP credentials.
 *
 * If nothing is configured this is a logged no-op: email problems must never
 * be able to fail or slow a fraud-analysis job, so every entry point here
 * swallows and logs its own errors.
 */
const nodemailer = require('nodemailer');

let cachedTransporter = null;

function isDryRun() { return process.env.SMTP_DRY_RUN === 'true'; }

function isConfigured() {
  return isDryRun() || !!(process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS);
}

function getTransporter() {
  if (cachedTransporter) return cachedTransporter;
  if (isDryRun()) {
    cachedTransporter = nodemailer.createTransport({ jsonTransport: true });
  } else {
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    cachedTransporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });
  }
  return cachedTransporter;
}

// Test hook: forget the cached transport so env changes take effect.
function _reset() { cachedTransporter = null; }

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));

function recipients(userEmail) {
  const list = [userEmail, process.env.ALERT_EMAIL_TO]
    .flatMap((v) => (v ? String(v).split(',') : []))
    .map((v) => v.trim())
    .filter(Boolean);
  return [...new Set(list)];
}

function buildJobEmail(job, kind) {
  const appUrl = (process.env.APP_URL || process.env.FRONTEND_URL || 'http://localhost:5173').replace(/\/$/, '');
  const link = `${appUrl}/analysis/${encodeURIComponent(job.jobId)}`;
  const file = job.originalName || job.fileName || job.jobId;

  if (kind === 'failed') {
    return {
      subject: `DeepGuard: analysis FAILED for ${file}`,
      text: `Analysis of "${file}" failed.\n\nReason: ${job.errorMessage || 'unknown'}\nJob: ${job.jobId}\n`,
      html: `<h2>Analysis failed</h2><p><b>${esc(file)}</b> could not be analysed.</p>
             <p>Reason: ${esc(job.errorMessage || 'unknown')}</p><p>Job ID: ${esc(job.jobId)}</p>`,
    };
  }

  const critical = job.criticalCount || 0;
  const flagged = job.flaggedCount || 0;
  const urgent = critical > 0;
  const subject = urgent
    ? `🚨 DeepGuard: ${critical} critical-risk transaction${critical === 1 ? '' : 's'} found in ${file}`
    : flagged > 0
      ? `⚠️ DeepGuard: ${flagged} flagged transaction${flagged === 1 ? '' : 's'} in ${file}`
      : `✅ DeepGuard: analysis of ${file} completed — nothing flagged`;

  const secs = job.processingTimeMs ? (job.processingTimeMs / 1000).toFixed(1) + 's' : '—';
  const rows = [
    ['Total transactions', job.totalTransactions ?? 0],
    ['Flagged as fraud', flagged],
    ['Critical risk', critical],
    ['Average risk score', `${job.averageRiskScore ?? 0}/100`],
    ['Processing time', secs],
  ];
  return {
    subject,
    text: `${subject}\n\n${rows.map(([k, v]) => `${k}: ${v}`).join('\n')}\n\nOpen the results: ${link}\n`,
    html: `<div style="font-family:Arial,sans-serif;max-width:560px">
      <h2 style="margin:0 0 8px">${esc(subject)}</h2>
      <table cellpadding="6" style="border-collapse:collapse;width:100%">
        ${rows.map(([k, v]) => `<tr><td style="border-bottom:1px solid #ddd;color:#555">${esc(k)}</td>
          <td style="border-bottom:1px solid #ddd"><b>${esc(v)}</b></td></tr>`).join('')}
      </table>
      <p><a href="${esc(link)}" style="background:#0ea5e9;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Open results</a></p>
      <p style="color:#888;font-size:12px">DeepGuard AI Financial Forensics — automated alert</p></div>`,
  };
}

async function sendMail({ to, subject, text, html }) {
  if (!isConfigured()) {
    console.log('✉️  Email alerts not configured (set SMTP_* in .env, or SMTP_DRY_RUN=true) — skipping');
    return { sent: false, reason: 'not_configured' };
  }
  if (!to || to.length === 0) return { sent: false, reason: 'no_recipients' };
  try {
    const info = await getTransporter().sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER || 'deepguard@localhost',
      to: to.join(', '), subject, text, html,
    });
    console.log(`✉️  Alert email ${isDryRun() ? '(dry run) ' : ''}sent to ${to.join(', ')}: ${subject}`);
    return { sent: true, dryRun: isDryRun(), info };
  } catch (err) {
    console.error(`✉️  Alert email failed (job unaffected): ${err.message}`);
    return { sent: false, reason: 'send_failed', error: err.message };
  }
}

/** Called when a job completes. Returns a result object; never throws. */
async function notifyJobCompleted(job, userEmail) {
  try {
    const mode = (process.env.ALERT_EMAIL_MODE || 'all').toLowerCase();
    const hasHighRisk = (job.criticalCount || 0) > 0 || (job.flaggedCount || 0) > 0;
    if (mode === 'critical_only' && !hasHighRisk) return { sent: false, reason: 'below_threshold' };
    return await sendMail({ to: recipients(userEmail), ...buildJobEmail(job, 'completed') });
  } catch (err) {
    console.error(`✉️  notifyJobCompleted error (ignored): ${err.message}`);
    return { sent: false, reason: 'error', error: err.message };
  }
}

/** Called when a job fails. Returns a result object; never throws. */
async function notifyJobFailed(job, userEmail) {
  try {
    return await sendMail({ to: recipients(userEmail), ...buildJobEmail(job, 'failed') });
  } catch (err) {
    return { sent: false, reason: 'error', error: err.message };
  }
}

module.exports = { isConfigured, notifyJobCompleted, notifyJobFailed, buildJobEmail, recipients, _reset };
