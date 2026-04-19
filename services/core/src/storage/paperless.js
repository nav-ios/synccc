'use strict';
const http = require('http');
const https = require('https');
const { URL } = require('url');

function req(url, method, headers, body, timeoutMs = 60000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method, headers, timeout: timeoutMs,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('Paperless request timeout')); });
    r.on('error', reject);
    if (body) r.write(body);
    r.end();
  });
}

function authHeaders(token) {
  return { Authorization: `Token ${token}` };
}

async function docExists(cfg, title) {
  const { url, token } = cfg.storage.paperless;
  const r = await req(
    `${url}/api/documents/?title__iexact=${encodeURIComponent(title)}&page_size=5`,
    'GET', authHeaders(token),
  );
  if (r.status >= 400) return false;
  const data = JSON.parse(r.body);
  return (data.results || []).length > 0;
}

async function upload(cfg, pdfB64, filename, title) {
  const { url, token } = cfg.storage.paperless;
  const fileBytes = Buffer.from(pdfB64, 'base64');
  const boundary = `----synccc${Date.now()}`;
  const CRLF = '\r\n';

  const parts = [
    Buffer.from(`--${boundary}${CRLF}Content-Disposition: form-data; name="document"; filename="${filename}"${CRLF}Content-Type: application/pdf${CRLF}${CRLF}`),
    fileBytes,
    Buffer.from(`${CRLF}--${boundary}${CRLF}Content-Disposition: form-data; name="title"${CRLF}${CRLF}${title}${CRLF}`),
    Buffer.from(`--${boundary}--${CRLF}`),
  ];
  const body = Buffer.concat(parts);

  const r = await req(`${url}/api/documents/post_document/`, 'POST', {
    ...authHeaders(token),
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
    'Content-Length': body.length,
  }, body, 30000);

  return r.body.trim().replace(/^"|"$/g, '');
}

async function pollTask(cfg, taskId, maxMs = 120000) {
  const { url, token } = cfg.storage.paperless;
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await new Promise(r => setTimeout(r, 4000));
    const r = await req(`${url}/api/tasks/?task_id=${taskId}`, 'GET', authHeaders(token));
    const data = JSON.parse(r.body);
    const task = Array.isArray(data) ? data[0] : data;
    if (!task) continue;
    if (task.status === 'SUCCESS') return task;
    if (task.status === 'FAILURE') throw new Error('Paperless task failed: ' + task.result);
  }
  return { status: 'TIMEOUT' };
}

async function getOcr(cfg, docId) {
  const { url, token } = cfg.storage.paperless;
  const r = await req(`${url}/api/documents/${docId}/`, 'GET', authHeaders(token));
  if (r.status >= 400) throw new Error(`Paperless doc fetch ${r.status}`);
  return JSON.parse(r.body).content || '';
}

async function findDocByTitle(cfg, title) {
  const { url, token } = cfg.storage.paperless;
  const r = await req(
    `${url}/api/documents/?title__iexact=${encodeURIComponent(title)}&page_size=1`,
    'GET', authHeaders(token),
  );
  if (r.status >= 400) return null;
  const data = JSON.parse(r.body);
  return data.results?.[0] || null;
}

module.exports = { docExists, upload, pollTask, getOcr, findDocByTitle };
