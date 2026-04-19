'use strict';

// Google Calendar support — coming in a future release.
// For now, configure calendar.provider: icaldav in config.yaml.
// Contributions welcome: https://github.com/yourusername/synccc

async function createEvent(_calCfg, _card, _ai, _uid) {
  throw new Error('Google Calendar is not yet implemented. Use calendar.provider: icaldav or none.');
}

module.exports = { createEvent };
