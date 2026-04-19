'use strict';
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');

const TOKEN_PATH = path.join(__dirname, '../../../../data/google_token.json');
const SCOPES = ['https://www.googleapis.com/auth/calendar'];

function getCredentialsPath(calCfg) {
  return path.resolve(calCfg.google?.credentials_file || './google_credentials.json');
}

function loadCredentials(calCfg) {
  const p = getCredentialsPath(calCfg);
  if (!fs.existsSync(p)) {
    throw new Error(
      `Google credentials not found at ${p}.\n` +
      'Follow the setup guide in the README to create OAuth2 credentials.'
    );
  }
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function buildOAuth2Client(calCfg) {
  const creds = loadCredentials(calCfg);
  const { client_id, client_secret, redirect_uris } = creds.installed || creds.web;
  return new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);
}

function loadToken() {
  if (!fs.existsSync(TOKEN_PATH)) return null;
  try { return JSON.parse(fs.readFileSync(TOKEN_PATH, 'utf8')); } catch { return null; }
}

function getAuthClient(calCfg) {
  const oAuth2 = buildOAuth2Client(calCfg);
  const token = loadToken();
  if (!token) {
    throw new Error(
      'Google Calendar token not found. Run the one-time auth setup:\n' +
      '  docker compose run --rm core node src/auth-google.js\n' +
      'Then follow the printed instructions.'
    );
  }
  oAuth2.setCredentials(token);
  oAuth2.on('tokens', updated => {
    const merged = { ...token, ...updated };
    fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
    fs.writeFileSync(TOKEN_PATH, JSON.stringify(merged, null, 2));
  });
  return oAuth2;
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function buildDescription(ai, cardName) {
  const lines = [];
  const cn = ai?.cardName || cardName;

  lines.push(`📋 ${cn}`);
  lines.push('─────────────────────────────');

  if (ai?.billingFrom || ai?.billingTo)
    lines.push(`🗓 Billing Cycle: ${formatDate(ai.billingFrom) || '?'} → ${formatDate(ai.billingTo) || '?'}`);

  if (ai?.amount)
    lines.push(`💳 Total Due:   Rs.${parseFloat(ai.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);
  if (ai?.minAmount)
    lines.push(`⚡ Minimum Due: Rs.${parseFloat(ai.minAmount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}`);

  const cats = ai?.categorySummary ? Object.entries(ai.categorySummary) : [];
  if (cats.length) {
    lines.push('', '📊 Spending Breakdown:');
    const sorted = cats.sort((a, b) => b[1] - a[1]);
    const max = sorted[0][1];
    for (const [cat, amt] of sorted) {
      const bar = max > 0 ? '█'.repeat(Math.min(10, Math.max(1, Math.round(amt / max * 10)))) : '';
      lines.push(`  ${cat}: Rs.${Number(amt).toLocaleString('en-IN')}  ${bar}`);
    }
  }

  const txns = ai?.transactions || [];
  if (txns.length) {
    lines.push('', `💰 Transactions (${txns.length}):`);
    const sorted = [...txns].sort((a, b) => (b.date || '') > (a.date || '') ? 1 : -1);
    for (const t of sorted) {
      const sign = t.type === 'credit' ? '↩' : '↳';
      const dt = formatDate(t.date) || t.date || '';
      const desc = String(t.description || '').slice(0, 40).padEnd(40);
      const amt = t.amount != null ? `Rs.${Number(t.amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '';
      lines.push(`  ${sign} ${dt}  ${desc}  ${amt}`);
    }
  }

  const insights = ai?.insights || [];
  if (insights.length) {
    lines.push('', '🧠 Insights:');
    for (const ins of insights) lines.push(`  • ${ins}`);
  }

  return lines.join('\n');
}

async function eventExists(calendar, calendarId, iCalUID) {
  try {
    const res = await calendar.events.list({ calendarId, iCalUID, maxResults: 1 });
    return (res.data.items || []).length > 0;
  } catch {
    return false;
  }
}

async function createEvent(calCfg, card, ai, uid) {
  const auth = getAuthClient(calCfg);
  const calendar = google.calendar({ version: 'v3', auth });
  const calendarId = calCfg.google?.calendar_id || 'primary';

  const dueDate = ai?.dueDate;
  if (!dueDate) return { status: 'no_due_date' };
  if (dueDate < new Date().toISOString().slice(0, 10)) return { status: 'past_due_skipped' };

  const iCalUID = `${uid}@synccc`;

  if (await eventExists(calendar, calendarId, iCalUID)) return { status: 'already_exists' };

  const amount = ai?.amount;
  const amountStr = amount ? `Rs.${parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '';
  const summary = ai?.eventTitle || (amountStr ? `${card.name} — ${amountStr}` : card.name);

  const nextDay = new Date(dueDate + 'T00:00:00Z');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const endDate = nextDay.toISOString().slice(0, 10);

  const event = {
    summary,
    description: buildDescription(ai, card.name),
    iCalUID,
    start: { date: dueDate },
    end: { date: endDate },
    reminders: {
      useDefault: false,
      overrides: [
        { method: 'popup', minutes: 7 * 24 * 60 },   // 7 days
        { method: 'popup', minutes: 3 * 24 * 60 },   // 3 days
        { method: 'popup', minutes: 1 * 24 * 60 },   // 1 day
      ],
    },
  };

  await calendar.events.insert({ calendarId, resource: event });
  return { status: 'created', dueDate, summary, txnCount: ai?.transactions?.length ?? 0 };
}

module.exports = { createEvent, buildOAuth2Client, SCOPES, TOKEN_PATH };
