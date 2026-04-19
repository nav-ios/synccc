'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');

const TIKA_URL = process.env.TIKA_URL || 'http://localhost:9998';

function getStorageDir(cfg) {
  const dir = cfg.storage?.local?.path || './data/statements';
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function docExists(cfg, filename) {
  const dir = getStorageDir(cfg);
  return fs.existsSync(path.join(dir, filename));
}

function save(cfg, pdfB64, filename) {
  const dir = getStorageDir(cfg);
  const dest = path.join(dir, filename);
  fs.writeFileSync(dest, Buffer.from(pdfB64, 'base64'));
  return dest;
}

async function getOcr(cfg, filename) {
  const dir = getStorageDir(cfg);
  const filePath = path.join(dir, filename);
  if (!fs.existsSync(filePath)) throw new Error(`File not found: ${filePath}`);

  const fileBytes = fs.readFileSync(filePath);
  return new Promise((resolve, reject) => {
    const u = new URL(`${TIKA_URL}/tika`);
    const mod = u.protocol === 'https:' ? https : http;
    const r = mod.request({
      hostname: u.hostname,
      port: u.port || 9998,
      path: '/tika',
      method: 'PUT',
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Length': fileBytes.length,
        Accept: 'text/plain',
      },
      timeout: 60000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    });
    r.on('timeout', () => { r.destroy(); reject(new Error('Tika OCR timeout')); });
    r.on('error', reject);
    r.write(fileBytes);
    r.end();
  });
}

module.exports = { docExists, save, getOcr };
