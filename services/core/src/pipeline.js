'use strict';
const crypto = require('crypto');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { fetchAttachments } = require('./imap');
const ai = require('./ai');
const paperless = require('./storage/paperless');
const local = require('./storage/local');
const icaldav = require('./calendar/icaldav');
const google = require('./calendar/google');

const DECRYPTOR_URL = process.env.DECRYPTOR_URL || 'http://localhost:5680';

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 32);
}

function post(url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 60000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('Decryptor timeout')); });
    r.on('error', reject);
    r.write(body);
    r.end();
  });
}

async function decryptPdf(pdfB64, passwords) {
  const body = JSON.stringify({ pdf_b64: pdfB64, passwords: passwords || [] });
  const r = await post(`${DECRYPTOR_URL}/decrypt`, body);
  if (r.status >= 400) throw new Error(`Decryptor ${r.status}: ${r.body.slice(0, 200)}`);
  return JSON.parse(r.body).pdf_b64;
}

async function processCard(cfg, state, card, account) {
  const results = [];
  console.log(`[pipeline] Processing: ${card.name}`);

  let attachments;
  try {
    attachments = await fetchAttachments(account, card);
    console.log(`[pipeline] ${card.name}: found ${attachments.length} attachment(s)`);
  } catch (e) {
    console.error(`[pipeline] ${card.name}: IMAP error — ${e.message}`);
    return [{ card: card.name, status: 'imap_error', error: e.message }];
  }

  for (const att of attachments) {
    const label = `${card.name}/${att.filename}`;

    let decryptedB64;
    try {
      decryptedB64 = await decryptPdf(att.pdf_b64, card.passwords || []);
    } catch (e) {
      console.error(`[pipeline] ${label}: decrypt failed — ${e.message}`);
      results.push({ card: card.name, filename: att.filename, status: 'decrypt_failed', error: e.message });
      continue;
    }

    const hash = sha256(Buffer.from(decryptedB64, 'base64'));
    if (state.uploaded.includes(hash)) {
      console.log(`[pipeline] ${label}: already processed (hash match)`);
      results.push({ card: card.name, filename: att.filename, status: 'already_exists' });
      continue;
    }

    const title = att.filename.replace(/\.pdf$/i, '');
    let ocrText = '';
    let docRef = null;

    const storageProvider = cfg.storage?.provider || 'local';

    if (storageProvider === 'paperless') {
      try {
        if (await paperless.docExists(cfg, title)) {
          console.log(`[pipeline] ${label}: already in Paperless`);
          state.uploaded.push(hash);
          results.push({ card: card.name, filename: att.filename, status: 'already_exists' });
          continue;
        }
        const taskId = await paperless.upload(cfg, decryptedB64, att.filename, title);
        const task = await paperless.pollTask(cfg, taskId);
        if (task.status === 'FAILURE') throw new Error(task.result);

        const doc = await paperless.findDocByTitle(cfg, title);
        if (doc) {
          ocrText = await paperless.getOcr(cfg, doc.id);
          docRef = `${cfg.storage.paperless.url}/documents/${doc.id}/details`;
        }
        console.log(`[pipeline] ${label}: uploaded to Paperless (OCR: ${ocrText.length} chars)`);
      } catch (e) {
        if (e.message?.includes('duplicate')) {
          state.uploaded.push(hash);
          results.push({ card: card.name, filename: att.filename, status: 'already_exists' });
          continue;
        }
        console.error(`[pipeline] ${label}: Paperless error — ${e.message}`);
        results.push({ card: card.name, filename: att.filename, status: 'paperless_error', error: e.message });
        continue;
      }
    } else {
      try {
        if (local.docExists(cfg, att.filename)) {
          state.uploaded.push(hash);
          results.push({ card: card.name, filename: att.filename, status: 'already_exists' });
          continue;
        }
        local.save(cfg, decryptedB64, att.filename);
        ocrText = await local.getOcr(cfg, att.filename);
        console.log(`[pipeline] ${label}: saved locally (OCR: ${ocrText.length} chars)`);
      } catch (e) {
        console.error(`[pipeline] ${label}: local storage/OCR error — ${e.message}`);
        results.push({ card: card.name, filename: att.filename, status: 'ocr_error', error: e.message });
        continue;
      }
    }

    state.uploaded.push(hash);

    let parsed = null;
    if (ocrText.length > 100) {
      parsed = await ai.parse(cfg, card.name, ocrText);
    }

    const calendarProvider = cfg.calendar?.provider || 'none';
    const uid = `synccc-${hash}`;

    if (calendarProvider !== 'none') {
      try {
        let calResult;
        if (calendarProvider === 'icaldav') {
          calResult = await icaldav.createEvent(cfg.calendar, card, parsed, uid);
        } else if (calendarProvider === 'google') {
          calResult = await google.createEvent(cfg.calendar, card, parsed, uid);
        }
        console.log(`[pipeline] ${label}: calendar — ${calResult.status}`);
        results.push({ card: card.name, filename: att.filename, status: 'done', calendar: calResult });
      } catch (e) {
        console.error(`[pipeline] ${label}: calendar error — ${e.message}`);
        results.push({ card: card.name, filename: att.filename, status: 'done_calendar_error', error: e.message });
      }
    } else {
      results.push({ card: card.name, filename: att.filename, status: 'done' });
    }
  }

  return results;
}

module.exports = { processCard };
