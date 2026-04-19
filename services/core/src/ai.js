'use strict';
const https = require('https');
const http = require('http');
const { URL } = require('url');

function buildPrompt(cardName, ocrText) {
  const chunk = ocrText.length > 40000
    ? ocrText.slice(-28000) + '\n\n--- EARLIER PAGES ---\n\n' + ocrText.slice(0, 8000)
    : ocrText;

  return `You are a personal finance accountant. Analyze this credit card statement OCR (may be noisy) for: "${cardName}".

Extract ALL of the following for the CURRENT billing cycle only:

1. card_name: exact product name from statement
2. billing_period_from: YYYY-MM-DD
3. billing_period_to: YYYY-MM-DD
4. payment_due_date: YYYY-MM-DD (if you see DD/MM/YYYY treat it as day/month/year)
5. total_amount_due: digits + decimal only, no commas (e.g. 12345.67)
6. minimum_amount_due: digits + decimal only, or null
7. currency: e.g. INR
8. transactions: array of ALL transactions visible. Each:
   { "date": "YYYY-MM-DD", "description": "merchant name", "amount": 1234.56, "type": "debit" or "credit" }
9. category_summary: top spending categories with totals, e.g.:
   { "Food & Dining": 3200, "Shopping": 8500, "Travel": 1200 }
10. calendar_event_title: short, e.g. "HDFC Swiggy — Rs.12345 due 15 Apr"
11. accountant_insights: array of 3-5 bullet strings (under 100 chars each):
    - Largest spend category
    - Any unusually large single transaction
    - Spending trend observation
    - Whether minimum vs full pay makes sense
    Keep them direct and useful.

Respond with ONLY valid JSON, no markdown fences. Dates as YYYY-MM-DD. Amounts as numbers.

OCR TEXT:
${chunk}`;
}

function post(url, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const mod = u.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers,
      timeout: 120000,
    }, res => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('AI request timeout')); });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

async function callGemini(cfg, prompt) {
  const key = cfg.ai.gemini_api_key;
  const model = cfg.ai.gemini_model || 'gemini-2.0-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  const body = JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] });
  const r = await post(url, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }, body);
  if (r.status >= 400) throw new Error(`Gemini ${r.status}: ${r.body.slice(0, 200)}`);
  const d = JSON.parse(r.body);
  return d.candidates?.[0]?.content?.parts?.[0]?.text || null;
}

async function callAnthropic(cfg, prompt) {
  const body = JSON.stringify({
    model: cfg.ai.anthropic_model || 'claude-3-5-haiku-20241022',
    max_tokens: 8192,
    messages: [{ role: 'user', content: prompt }],
  });
  const r = await post('https://api.anthropic.com/v1/messages', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    'x-api-key': cfg.ai.anthropic_api_key,
    'anthropic-version': '2023-06-01',
  }, body);
  if (r.status >= 400) throw new Error(`Anthropic ${r.status}: ${r.body.slice(0, 200)}`);
  const d = JSON.parse(r.body);
  return d.content?.[0]?.text || null;
}

async function callOpenAI(cfg, prompt) {
  const body = JSON.stringify({
    model: cfg.ai.openai_model || 'gpt-4o-mini',
    messages: [{ role: 'user', content: prompt }],
    response_format: { type: 'json_object' },
  });
  const r = await post('https://api.openai.com/v1/chat/completions', {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(body),
    Authorization: `Bearer ${cfg.ai.openai_api_key}`,
  }, body);
  if (r.status >= 400) throw new Error(`OpenAI ${r.status}: ${r.body.slice(0, 200)}`);
  const d = JSON.parse(r.body);
  return d.choices?.[0]?.message?.content || null;
}

function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/);
  if (fence) return fence[1];
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) return text.slice(start, end + 1);
  return null;
}

function normalizeDate(s) {
  if (!s) return null;
  const t = String(s).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const m = t.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{4})$/);
  if (m) return `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}`;
  return null;
}

function normalizeAmount(v) {
  if (v == null || v === '') return null;
  const s = String(v).replace(/,/g, '').replace(/[^\d.]/g, '');
  return s === '' || s === '.' ? null : s;
}

async function parse(cfg, cardName, ocrText) {
  const prompt = buildPrompt(cardName, ocrText);
  let rawText = null;

  try {
    if (cfg.ai.provider === 'gemini') rawText = await callGemini(cfg, prompt);
    else if (cfg.ai.provider === 'anthropic') rawText = await callAnthropic(cfg, prompt);
    else if (cfg.ai.provider === 'openai') rawText = await callOpenAI(cfg, prompt);
  } catch (e) {
    console.error(`[ai] ${cardName}: API call failed — ${e.message}`);
    return null;
  }

  const jsonStr = extractJson(rawText);
  if (!jsonStr) { console.error(`[ai] ${cardName}: no JSON in response`); return null; }

  let p;
  try { p = JSON.parse(jsonStr); } catch (e) {
    console.error(`[ai] ${cardName}: JSON parse error — ${e.message}`);
    return null;
  }

  return {
    dueDate: normalizeDate(p.payment_due_date ?? p.due_date),
    amount: normalizeAmount(p.total_amount_due ?? p.amount_due),
    minAmount: normalizeAmount(p.minimum_amount_due),
    cardName: (p.card_name && String(p.card_name).trim()) || null,
    billingFrom: normalizeDate(p.billing_period_from),
    billingTo: normalizeDate(p.billing_period_to),
    eventTitle: (p.calendar_event_title && String(p.calendar_event_title).trim()) || null,
    transactions: Array.isArray(p.transactions) ? p.transactions : [],
    categorySummary: (p.category_summary && typeof p.category_summary === 'object') ? p.category_summary : {},
    insights: Array.isArray(p.accountant_insights) ? p.accountant_insights : [],
  };
}

module.exports = { parse };
