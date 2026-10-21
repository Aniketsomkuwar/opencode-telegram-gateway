#!/usr/bin/env node
// Send a one-off Telegram message to the owner. Usage: node notify.mjs "text"
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const dir = path.join(os.homedir(), '.opencode-telegram');
const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), 'opencode-telegram', 'config.json'), 'utf8'));
const chatId = cfg.ownerChatId || (cfg.allowedUserIds || [])[0];
if (!cfg.botToken || cfg.botToken.includes('PASTE')) { console.error('no token'); process.exit(1); }
if (!chatId) { console.error('no ownerChatId'); process.exit(1); }

const text = process.argv.slice(2).join(' ') || '(empty)';
const res = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'Markdown' }),
});
const json = await res.json();
if (!json.ok) {
  const r2 = await fetch(`https://api.telegram.org/bot${cfg.botToken}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
  console.log((await r2.json()).ok ? 'sent' : 'failed');
} else console.log('sent');
