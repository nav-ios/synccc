'use strict';
const { ImapFlow } = require('imapflow');

const IGNORED_FILENAMES = ['most important terms', 'terms and conditions', 'mitc'];

async function fetchAttachments(account, card) {
  const { email, app_password } = account;
  const { filter_from, filter_subject, filter_subject_exclude, since } = card;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: email, pass: app_password },
    logger: false,
  });

  const attachments = [];

  try {
    await client.connect();
    const lock = await client.getMailboxLock('INBOX');
    try {
      const sinceDate = since ? new Date(since) : new Date('2024-01-01');
      const criteria = { from: filter_from, since: sinceDate };
      if (filter_subject) criteria.subject = filter_subject;

      let uids = await client.search(criteria, { uid: true });
      if (!Array.isArray(uids)) uids = [];

      uids.sort((a, b) => b - a);
      uids = uids.slice(0, 5);

      for (const uid of uids) {
        let msg;
        try {
          msg = await client.fetchOne(String(uid), { source: true, envelope: true }, { uid: true });
        } catch {
          continue;
        }

        const subject = (msg.envelope?.subject || '').toLowerCase();
        if (filter_subject_exclude && subject.includes(filter_subject_exclude.toLowerCase())) continue;

        const raw = msg.source.toString('binary');
        const boundaryMatch = raw.match(/boundary=["']?([^"'\s;\r\n]+)["']?/i);
        if (!boundaryMatch) continue;

        const bnd = boundaryMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const parts = raw.split(new RegExp(`--${bnd}`, 'g'));
        const emailDate = msg.envelope?.date ? new Date(msg.envelope.date).toISOString() : null;

        for (const part of parts) {
          const filenameMatch = part.match(/filename\*?=["']?(?:UTF-8'')?([^"'\r\n;]+)["']?/i);
          if (!filenameMatch) continue;

          let filename = decodeURIComponent(filenameMatch[1].trim());
          if (!filename.toLowerCase().endsWith('.pdf')) continue;
          if (IGNORED_FILENAMES.some(n => filename.toLowerCase().includes(n))) continue;

          const bodyMatch = part.match(/\r?\n\r?\n([\s\S]+)$/);
          if (!bodyMatch) continue;

          const pdfB64 = Buffer.from(bodyMatch[1].replace(/[\r\n]/g, ''), 'base64').toString('base64');
          attachments.push({ filename, pdf_b64: pdfB64, emailDate });
        }
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout();
  }

  return attachments;
}

module.exports = { fetchAttachments };
