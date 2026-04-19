'use strict';
const fs = require('fs');
const path = require('path');
const cron = require('node-cron');
const { load, accountFor } = require('./config');
const { processCard } = require('./pipeline');

const STATE_PATH = path.join(__dirname, '../../../data/state.json');

function loadState() {
  if (fs.existsSync(STATE_PATH)) {
    try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); } catch { /* */ }
  }
  return { uploaded: [] };
}

function saveState(state) {
  fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

async function run() {
  console.log(`[synccc] Run started at ${new Date().toISOString()}`);

  let cfg;
  try { cfg = load(); } catch (e) {
    console.error('[synccc] Config error:', e.message);
    process.exit(1);
  }

  const state = loadState();
  const allResults = [];

  for (const card of cfg.cards) {
    const account = accountFor(cfg, card.account_id);
    if (!account) {
      console.error(`[synccc] Card "${card.name}": account_id ${card.account_id} not found`);
      continue;
    }

    const results = await processCard(cfg, state, card, account);
    allResults.push(...results);
    saveState(state);
  }

  const done = allResults.filter(r => r.status === 'done' || r.status === 'done_calendar_error').length;
  const skipped = allResults.filter(r => r.status === 'already_exists').length;
  const errors = allResults.filter(r => r.status.includes('error') || r.status.includes('failed')).length;

  console.log(`[synccc] Run complete — processed: ${done}, skipped: ${skipped}, errors: ${errors}`);
  saveState(state);
}

const runNow = process.argv.includes('--run-now');
if (runNow) {
  run().catch(e => { console.error('[synccc] Fatal:', e.message); process.exit(1); });
} else {
  let cfg;
  try { cfg = load(); } catch (e) {
    console.error('[synccc] Config error:', e.message);
    process.exit(1);
  }

  const cronExpr = cfg.schedule?.cron || '0 8 * * *';
  console.log(`[synccc] Scheduler started. Cron: "${cronExpr}"`);
  console.log('[synccc] Run with --run-now flag to trigger immediately.');

  cron.schedule(cronExpr, () => {
    run().catch(e => console.error('[synccc] Run failed:', e.message));
  });
}
