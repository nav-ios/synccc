'use strict';
const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const CONFIG_PATH = process.env.CONFIG_PATH || path.join(__dirname, '../../..', 'config.yaml');

function load() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`config.yaml not found at ${CONFIG_PATH}. Copy config.example.yaml to config.yaml and fill in your values.`);
  }
  const raw = yaml.load(fs.readFileSync(CONFIG_PATH, 'utf8'));
  validate(raw);
  return raw;
}

function validate(cfg) {
  if (!cfg.accounts?.length) throw new Error('config: accounts[] is required');
  if (!cfg.cards?.length) throw new Error('config: cards[] is required');
  if (!cfg.ai?.provider) throw new Error('config: ai.provider is required');

  const validAI = ['gemini', 'anthropic', 'openai'];
  if (!validAI.includes(cfg.ai.provider))
    throw new Error(`config: ai.provider must be one of: ${validAI.join(', ')}`);

  const validStorage = ['paperless', 'local'];
  if (cfg.storage?.provider && !validStorage.includes(cfg.storage.provider))
    throw new Error(`config: storage.provider must be one of: ${validStorage.join(', ')}`);

  const validCal = ['icaldav', 'google', 'none'];
  if (cfg.calendar?.provider && !validCal.includes(cfg.calendar.provider))
    throw new Error(`config: calendar.provider must be one of: ${validCal.join(', ')}`);

  const accountIds = new Set(cfg.accounts.map(a => a.id));
  for (const card of cfg.cards) {
    if (!accountIds.has(card.account_id))
      throw new Error(`config: card "${card.name}" references unknown account_id ${card.account_id}`);
  }
}

function accountFor(cfg, accountId) {
  return cfg.accounts.find(a => a.id === accountId);
}

module.exports = { load, accountFor };
