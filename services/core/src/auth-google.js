#!/usr/bin/env node
'use strict';
/**
 * One-time Google Calendar auth setup.
 * Run: docker compose run --rm core node src/auth-google.js
 *
 * This opens a browser URL, you paste the code back, and tokens are saved
 * to ./data/google_token.json. After this, synccc runs headlessly forever.
 */
const fs = require('fs');
const readline = require('readline');
const path = require('path');
const { buildOAuth2Client, SCOPES, TOKEN_PATH } = require('./calendar/google');
const { load } = require('./config');

async function main() {
  let cfg;
  try { cfg = load(); } catch (e) {
    console.error('Config error:', e.message);
    process.exit(1);
  }

  if (cfg.calendar?.provider !== 'google') {
    console.error('calendar.provider in config.yaml must be set to "google" before running this.');
    process.exit(1);
  }

  const oAuth2 = buildOAuth2Client(cfg.calendar);

  const authUrl = oAuth2.generateAuthUrl({
    access_type: 'offline',
    scope: SCOPES,
    prompt: 'consent',
  });

  console.log('\n──────────────────────────────────────────────');
  console.log('  synccc — Google Calendar One-Time Setup');
  console.log('──────────────────────────────────────────────\n');
  console.log('1. Open this URL in your browser:\n');
  console.log('  ', authUrl);
  console.log('\n2. Sign in and grant access.');
  console.log('3. Copy the authorization code and paste it below.\n');

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question('Paste the authorization code here: ', async (code) => {
    rl.close();
    try {
      const { tokens } = await oAuth2.getToken(code.trim());
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2));
      console.log('\n✓ Token saved to', TOKEN_PATH);
      console.log('✓ Google Calendar is ready. Start synccc normally now.\n');
    } catch (e) {
      console.error('\n✗ Failed to get token:', e.message);
      process.exit(1);
    }
  });
}

main();
