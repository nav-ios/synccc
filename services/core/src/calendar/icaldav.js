'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

const CALDAV_BASE = 'https://caldav.icloud.com';

function req(url, method, headers, body, redirects = 0) {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method, headers, timeout: 30000,
    }, res => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        const loc = res.headers.location;
        const next = loc.startsWith('http') ? loc : new URL(loc, url).href;
        res.resume();
        resolve(req(next, res.statusCode === 303 ? 'GET' : method, headers, res.statusCode === 303 ? null : body, redirects + 1));
        return;
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8'), headers: res.headers }));
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('CalDAV timeout')); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function caldav(user, pass, url, method, body, extra = {}) {
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const headers = { Authorization: `Basic ${auth}`, ...extra };
  if (body) {
    headers['Content-Type'] = 'application/xml; charset=utf-8';
    headers['Content-Length'] = Buffer.byteLength(body);
  }
  return req(url, method, headers, body);
}

async function discoverCalendarUrl(user, pass, calendarName) {
  const r1 = await caldav(user, pass, `${CALDAV_BASE}/`, 'PROPFIND',
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:"><d:prop><d:current-user-principal/></d:prop></d:propfind>`,
    { Depth: '0' });
  const pm = r1.body.match(/<[^:>]*:?current-user-principal[^>]*>[\s\S]*?<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i);
  if (!pm) throw new Error(`CalDAV: no principal (${r1.status})`);
  const principalUrl = pm[1].trim().startsWith('http') ? pm[1].trim() : CALDAV_BASE + pm[1].trim();

  const r2 = await caldav(user, pass, principalUrl, 'PROPFIND',
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-home-set/></d:prop></d:propfind>`,
    { Depth: '0' });
  const hm = r2.body.match(/<[^:>]*:?calendar-home-set[^>]*>[\s\S]*?<[^:>]*:?href[^>]*>([^<]+)<\/[^:>]*:?href>/i);
  if (!hm) throw new Error('CalDAV: no calendar home');
  const homeUrl = hm[1].trim().startsWith('http') ? hm[1].trim() : CALDAV_BASE + hm[1].trim();

  const r3 = await caldav(user, pass, homeUrl, 'PROPFIND',
    `<?xml version="1.0"?><d:propfind xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><d:displayname/></d:prop></d:propfind>`,
    { Depth: '1' });

  const blocks = r3.body.match(/<[^:]*:?response>[\s\S]*?<\/[^:]*:?response>/gi) || [];
  for (const b of blocks) {
    const nm = b.match(/<[^:]*:?displayname>([^<]*)<\/[^:]*:?displayname>/i);
    const href = b.match(/<[^:]*:?href>([^<]+)<\/[^:]*:?href>/i);
    if (nm && nm[1].trim() === calendarName && href)
      return href[1].startsWith('http') ? href[1] : CALDAV_BASE + href[1];
  }

  const calUrl = homeUrl.endsWith('/') ? `${homeUrl}synccc/` : `${homeUrl}/synccc/`;
  await caldav(user, pass, calUrl, 'MKCALENDAR',
    `<?xml version="1.0"?><c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:set><d:prop><d:displayname>${calendarName}</d:displayname></d:prop></d:set></c:mkcalendar>`);
  return calUrl;
}

async function getExistingUids(user, pass, calUrl) {
  const r = await caldav(user, pass, calUrl, 'REPORT',
    `<?xml version="1.0"?><c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav"><d:prop><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>`,
    { Depth: '1' });
  const uids = new Set();
  for (const m of r.body.matchAll(/UID:([^\r\n]+)/g)) uids.add(m[1].trim());
  return uids;
}

function foldLine(name, value) {
  const line = `${name}:${value}`;
  const out = [];
  let pos = 0;
  while (pos < line.length) {
    out.push((pos === 0 ? '' : ' ') + line.slice(pos, pos + (pos === 0 ? 75 : 74)));
    pos += pos === 0 ? 75 : 74;
  }
  return out.join('\r\n');
}

function escapeIcal(s) {
  return String(s).replace(/\\/g, '\\\\').replace(/;/g, '\\;').replace(/,/g, '\\,').replace(/\r?\n/g, '\\n');
}

function makeVEvent(summary, dtstart, dtend, uid, description) {
  const now = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';
  const parts = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//synccc//EN',
    'BEGIN:VEVENT',
    `UID:${uid}`,
    `DTSTAMP:${now}`,
    `DTSTART;VALUE=DATE:${dtstart}`,
    `DTEND;VALUE=DATE:${dtend}`,
    foldLine('SUMMARY', escapeIcal(summary)),
    'BEGIN:VALARM', 'TRIGGER:-P7D', 'ACTION:DISPLAY', 'DESCRIPTION:7 days until CC payment', 'END:VALARM',
    'BEGIN:VALARM', 'TRIGGER:-P3D', 'ACTION:DISPLAY', 'DESCRIPTION:3 days until CC payment', 'END:VALARM',
    'BEGIN:VALARM', 'TRIGGER:-P1D', 'ACTION:DISPLAY', 'DESCRIPTION:CC payment due tomorrow', 'END:VALARM',
  ];
  if (description) parts.push(foldLine('DESCRIPTION', escapeIcal(description)));
  parts.push('END:VEVENT', 'END:VCALENDAR');
  return parts.join('\r\n');
}

async function putEvent(user, pass, calUrl, uid, vevent) {
  const eventUrl = calUrl.endsWith('/') ? `${calUrl}${uid}.ics` : `${calUrl}/${uid}.ics`;
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  await req(eventUrl, 'PUT', {
    Authorization: `Basic ${auth}`,
    'Content-Type': 'text/calendar; charset=utf-8',
    'Content-Length': Buffer.byteLength(vevent),
  }, vevent);
}

function formatDate(iso) {
  if (!iso) return '';
  const [y, m, d] = iso.split('-');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${d} ${months[parseInt(m, 10) - 1]} ${y}`;
}

function buildDescription(ai, cardName, docUrl = null) {
  const lines = [];
  const cn = (ai && ai.cardName) ? ai.cardName : cardName;

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

  if (docUrl) {
    lines.push('', '─────────────────────────────');
    lines.push(`📄 ${docUrl}`);
  }

  return lines.join('\n');
}

async function createEvent(calCfg, card, ai, uid) {
  const { user, password, calendar_name } = calCfg.icaldav;
  const calUrl = await discoverCalendarUrl(user, password, calendar_name);
  const existingUids = await getExistingUids(user, password, calUrl);

  if (existingUids.has(uid)) return { status: 'already_exists' };

  const dueDate = ai?.dueDate;
  if (!dueDate) return { status: 'no_due_date' };

  if (dueDate < new Date().toISOString().slice(0, 10)) return { status: 'past_due_skipped' };

  const amount = ai?.amount;
  const amountStr = amount ? `Rs.${parseFloat(amount).toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '';
  const summary = ai?.eventTitle || (amountStr ? `${card.name} — ${amountStr}` : card.name);

  const dtstart = dueDate.replace(/-/g, '');
  const nextDay = new Date(dueDate + 'T00:00:00Z');
  nextDay.setUTCDate(nextDay.getUTCDate() + 1);
  const dtend = nextDay.toISOString().slice(0, 10).replace(/-/g, '');

  const description = buildDescription(ai, card.name);
  const vevent = makeVEvent(summary, dtstart, dtend, uid, description);
  await putEvent(user, password, calUrl, uid, vevent);

  return { status: 'created', dueDate, summary, txnCount: ai?.transactions?.length ?? 0 };
}

module.exports = { createEvent };
