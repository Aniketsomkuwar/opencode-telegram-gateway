#!/usr/bin/env node
/**
 * OpenCode <-> Telegram bridge (multi-session)
 * One bot, many sessions. Telegram is a second client on the same session store
 * as the TUI, so both devices can drive the same conversation.
 */
import { execSync, execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const HOME = os.homedir();
const BASE_DIR = path.join(HOME, 'opencode-telegram');
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');
const STATE_PATH = path.join(BASE_DIR, 'state.json');
const SERVICE_PATH = path.join(HOME, '.config', 'opencode', 'service.json');
const LOG_PATH = path.join(BASE_DIR, 'bridge.log');

const log = (...a) => { const l = `[${new Date().toISOString()}] ${a.join(' ')}`; try { fs.appendFileSync(LOG_PATH, l + '\n'); } catch {} };
if (!fs.existsSync(CONFIG_PATH)) {
  console.error(`Missing ${CONFIG_PATH}\nCopy config.example.json to config.json and set botToken.`);
  process.exit(1);
}
const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
const state = fs.existsSync(STATE_PATH) ? JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')) : {};
const saveState = () => { try { fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2)); } catch {} };
const TOKEN = cfg.botToken;
if (!TOKEN || TOKEN.includes('PASTE')) { console.error('Set botToken in config.json (get one from @BotFather).'); process.exit(1); }
const ALLOWED = new Set((cfg.allowedUserIds || []).map(String));
const VERBOSE = cfg.verbose === true;   // tool feed is opt-in only

let BASE = null, AUTH = null;
function discover() {
  if (!fs.existsSync(SERVICE_PATH)) {
    console.error(`Missing ${SERVICE_PATH}\nStart the OpenCode service once so it can create its credentials.`);
    process.exit(1);
  }
  const password = JSON.parse(fs.readFileSync(SERVICE_PATH, 'utf8')).password;
  let url = cfg.serviceUrl;
  if (!url) {
    try { url = JSON.parse(execSync('opencode api get /api/info', { encoding: 'utf8', stdio: ['ignore','pipe','ignore'] })).urls[0]; }
    catch { url = `http://127.0.0.1:${cfg.servicePort || 45278}`; }
  }
  BASE = url.replace(/\/$/, '');
  AUTH = 'Basic ' + Buffer.from('opencode:' + password).toString('base64');
}
discover();

async function api(method, p, body) {
  const res = await fetch(BASE + p, {
    method,
    headers: { Authorization: AUTH, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  if (res.status === 401) { discover(); throw new Error('auth failed'); }
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status} ${text.slice(0, 200)}`);
  return text ? JSON.parse(text) : {};
}

const TG = `https://api.telegram.org/bot${TOKEN}`;
async function tg(method, payload) {
  const res = await fetch(`${TG}/${method}`, { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify(payload) });
  const j = await res.json().catch(() => ({}));
  if (!j.ok) log('TG', method, JSON.stringify(j).slice(0,200));
  return j;
}
const send = (chat_id, text, extra={}) => tg('sendMessage', { chat_id, text, parse_mode:'Markdown', ...extra })
  .then(r => r.ok ? r : tg('sendMessage', { chat_id, text, ...extra }));

async function sendLong(chat_id, text, extra={}) {
  const LIMIT = 3800;
  if (text.length <= LIMIT) return send(chat_id, text, extra);
  const parts = []; let rest = text;
  while (rest.length) { let cut = rest.lastIndexOf('\n', LIMIT); if (cut < 1000) cut = LIMIT; parts.push(rest.slice(0, cut)); rest = rest.slice(cut); }
  for (let i=0;i<parts.length;i++) await send(chat_id, parts[i] + (parts.length>1?`\n\n_(${i+1}/${parts.length})_`:''), extra);
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const esc = s => String(s ?? '').replace(/[*_`\[\]]/g, c => '\\' + c);
const short = (s,n=150) => { s = String(s ?? '').replace(/\s+/g,' ').trim(); return s.length>n ? s.slice(0,n)+'…' : s; };
const ago = t => { if (!t) return '?'; const s=(Date.now()-t)/1000; if(s<60)return `${s|0}s`; if(s<3600)return `${s/60|0}m`; if(s<86400)return `${s/3600|0}h`; return `${s/86400|0}d`; };

const pendingPerms = new Map(); let permSeq = 0;
const busySessions = new Set();
const watchTrack = new Map(); // sid -> { seen:Set, title, gone }
let watchAll = cfg.watchAll === true;

// Convert markdown tables into readable bullets (Telegram does not render tables)
function fmt(t) {
  const out = [];
  for (const ln of String(t ?? '').split('\n')) {
    if (/^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$/.test(ln) && ln.includes('-') && ln.includes('|')) continue;
    if (/^\s*\|.*\|\s*$/.test(ln)) {
      const cells = ln.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(c => c.trim()).filter(Boolean);
      if (cells.length >= 2) { out.push('• ' + cells[0] + ' — ' + cells.slice(1).join(' · ')); continue; }
    }
    out.push(ln);
  }
  return out.join('\n');
}

function chatState(userId) { const k=String(userId); state[k] ??= { sessionId:null }; return state[k]; }
const getSession = async id => { try { return (await api('GET', `/api/session/${id}`)).data; } catch { return null; } };
const activeIds = async () => { try { return Object.keys((await api('GET','/api/session/active')).data || {}); } catch { return []; } };

async function sessionList() {
  const list = ((await api('GET','/api/session?limit=25')).data) || [];
  const running = new Set(await activeIds());
  return list.map(s => ({ ...s, running: running.has(s.id) }));
}

async function renderSessions(userId) {
  const list = await sessionList();
  const cur = chatState(userId).sessionId;
  state[userId] = { ...chatState(userId), lastList: list.map(s => s.id) }; saveState();
  if (!list.length) return 'no sessions';
  const rows = list.map((s,i) => {
    const mark = s.id === cur ? '▸' : ' ';
    const dot = s.running ? '▶' : '○';
    const dir = s.location?.directory ? short(s.location.directory, 34) : '';
    return `${mark}${dot} ${i+1}. ${esc(short(s.title || '(untitled)', 46))}\n      \`${dir}\` · ${ago(s.time?.updated)}`;
  });
  return `*Sessions* (${list.filter(s=>s.running).length} running)\n\n` + rows.join('\n') + '\n\n`/use <n>` to switch';
}

function toolLine(title, c) {
  const st = c.state?.status;
  const ic = st === 'error' ? '❌' : '🔧';
  const d = st === 'error'
    ? short(c.state?.error?.message || 'failed', 160)
    : short(c.state?.input?.command || c.state?.input?.filePath || c.state?.input?.path || c.state?.input?.description || '', 110);
  return `${ic} *${esc(short(title,40))}*\n${esc(c.name)}${d?': '+esc(d):''}`;
}

// ---------- run a prompt in the current session ----------
async function runPrompt(chat_id, userId, text) {
  const st = chatState(userId);
  if (st.sessionId) {
    const s = await getSession(st.sessionId);
    if (!s) { st.sessionId = null; saveState(); }
  }
  if (!st.sessionId) {
    const t = text.replace(/^\/new\s*/,'');
    const created = (await api('POST','/api/session',{ title: short(t || 'telegram session', 60) })).data;
    st.sessionId = created.id; saveState();
  }
  const sid = st.sessionId;
  busySessions.add(sid);
  try {
    const before = ((await api('GET', `/api/session/${sid}/message?limit=100`)).data) || [];
    const seen = new Set(); let idleBefore = 0;
    for (const m of before) { if (m.type==='idle') idleBefore++; if (m.type==='assistant') for (const c of m.content||[]) if (c.type==='tool') seen.add(c.id); }

    await api('POST', `/api/session/${sid}/prompt`, { text });
    await tg('sendChatAction', { chat_id, action:'typing' });

    const t0 = Date.now(); let hb = 0;
    while (true) {
      if (Date.now()-t0 > 45*60000) { await send(chat_id,'⏱ still running after 45m — left running locally.'); return; }
      if (Date.now()-hb > 45000) { hb = Date.now(); await tg('sendChatAction', { chat_id, action:'typing' }); }

      try {
        for (const p of (await api('GET', `/api/session/${sid}/permission`)).data || []) {
          if ([...pendingPerms.values()].some(v => v.requestId === p.id)) continue;
          const key = 'p' + (++permSeq);
          pendingPerms.set(key, { sid, rid: p.id });
          await tg('sendMessage', {
            chat_id, parse_mode:'Markdown',
            text: `🔐 *Permission*\n${esc(p.action)}\n${esc((p.resources||[]).join('\n').slice(0,500))}`,
            reply_markup: { inline_keyboard: [[
              { text:'✅ Once', callback_data:`${key}:once` },
              { text:'♾ Always', callback_data:`${key}:always` },
              { text:'⛔ Deny', callback_data:`${key}:reject` }]] },
          });
        }
      } catch {}

      let msgs = [];
      try { msgs = (await api('GET', `/api/session/${sid}/message?limit=100`)).data || []; } catch { await sleep(1500); continue; }

      if (VERBOSE) {
        for (const m of msgs) {
          if (m.type !== 'assistant') continue;
          for (const c of m.content||[]) {
            if (c.type !== 'tool' || seen.has(c.id)) continue;
            if (c.state?.status === 'completed' || c.state?.status === 'error') { seen.add(c.id); await send(chat_id, toolLine('', c)); }
          }
        }
      }

      if (msgs.filter(m=>m.type==='idle').length > idleBefore) {
        const last = msgs.filter(m=>m.type==='assistant').pop();
        const out = last ? (last.content||[]).filter(c=>c.type==='text').map(c=>c.text).join('\n').trim() : '';
        const oc = msgs.filter(m=>m.type==='idle').pop()?.outcome;
        if (out) await sendLong(chat_id, fmt(out), { parse_mode: undefined });
        else if (oc && oc !== 'succeeded') await sendLong(chat_id, `_(${oc})_`, { parse_mode: undefined });
        return;
      }
      await sleep(1500);
    }
  } finally { busySessions.delete(sid); }
}

// ---------- background watcher: all sessions ----------
async function watchTick() {
  if (!watchAll) return;
  const chat = cfg.ownerChatId || (cfg.allowedUserIds||[])[0];
  if (!chat) return;
  const currentSid = state[String(chat)]?.sessionId;
  try {
    const running = await activeIds();
    for (const [sid, rec] of [...watchTrack]) {
      if (!running.includes(sid) && !busySessions.has(sid)) {
        rec.gone++;
        if (rec.gone >= 2) {
          if (sid !== currentSid) await send(chat, `✅ ${esc(short(rec.title,50))}`);
          watchTrack.delete(sid);
        }
      } else rec.gone = 0;
    }
    for (const sid of running) {
      if (!watchTrack.has(sid)) {
        const s = await getSession(sid);
        watchTrack.set(sid, { title:s?.title || sid, gone:0 });
      }
    }
  } catch (e) { log('watch', e.message); }
}

// ---------- commands ----------
async function handleUpdate(u) {
  if (u.callback_query) {
    const cq = u.callback_query;
    if (!ALLOWED.size || !ALLOWED.has(String(cq.from.id))) return tg('answerCallbackQuery', { callback_query_id: cq.id, text:'denied' });
    const [key, decision] = String(cq.data||'').split(':');
    const perm = pendingPerms.get(key);
    if (!perm) return tg('answerCallbackQuery', { callback_query_id: cq.id, text:'expired' });
    try {
      await api('POST', `/api/session/${perm.sid}/permission/${perm.rid}/reply`, { decision });
      pendingPerms.delete(key);
      await tg('answerCallbackQuery', { callback_query_id: cq.id, text: decision });
      await tg('editMessageReplyMarkup', { chat_id: cq.message.chat.id, message_id: cq.message.message_id, reply_markup:{ inline_keyboard: [] } });
    } catch { await tg('answerCallbackQuery', { callback_query_id: cq.id, text:'error' }); }
    return;
  }

  const msg = u.message || u.edited_message;
  if (!msg || !msg.text) return;
  const chat_id = msg.chat.id, userId = msg.from.id, text = msg.text.trim();
  if (!ALLOWED.size) return send(chat_id, `👋 ID \`${userId}\` — add to allowedUserIds in config.json, then restart.`);
  if (!ALLOWED.has(String(userId))) return;
  cfg.ownerChatId ??= chat_id;

  const [cmd, ...rest] = text.split(/\s+/);
  const arg = rest.join(' ').trim();
  const st = chatState(userId);
  log('in', userId, cmd, short(arg, 60));

  try {
    switch ((cmd||'').toLowerCase()) {
      case '/start': case '/help': case '/commands':
        return send(chat_id, [
          '*Remote control*',
          'Plain text runs in the ▸ current session.',
          '',
          '`/sessions` · list all + running state',
          '`/use 3` · switch to #3',
          '`/active` · only running ones',
          '`/new [title]` · new session',
          '`/newdir <path> [title]` · new session in a project folder',
          '`/status` · current session details',
          '`/stop` · interrupt current',
          '`/remember <text>` · append a note via rememberScript',
          '`/watch on|off` · completion pings from ALL sessions',
          '`/ping`',
        ].join('\n'));
      case '/ping': return send(chat_id, `pong · ${(await api('GET','/api/info')).version}`);
      case '/sessions': return send(chat_id, await renderSessions(userId));
      case '/active': {
        const list = (await sessionList()).filter(s => s.running);
        if (!list.length) return send(chat_id, 'nothing running');
        return send(chat_id, '*Running now*\n' + list.map(s => `▶ ${esc(short(s.title||'(untitled)',50))}\n   \`${short(s.location?.directory||'',40)}\``).join('\n'));
      }
      case '/use': {
        const n = parseInt(arg, 10);
        const ids = st.lastList || (await sessionList()).map(s => s.id);
        if (!n || !ids[n-1]) return send(chat_id, 'usage: /sessions then /use <number>');
        const s = await getSession(ids[n-1]);
        if (!s) return send(chat_id, 'session gone');
        st.sessionId = s.id; saveState();
        return send(chat_id, `▸ \`${s.id}\`\n${esc(short(s.title||'',60))}\n\`${short(s.location?.directory||'',50)}\``);
      }
      case '/new': {
        const created = (await api('POST','/api/session',{ title: arg || 'telegram session' })).data;
        st.sessionId = created.id; saveState();
        return send(chat_id, `🆕 \`${created.id}\``);
      }
      case '/newdir': {
        const m = arg.match(/^"([^"]+)"\s*(.*)$/) || arg.match(/^(\S+)\s*(.*)$/);
        if (!m) return send(chat_id, 'usage: /newdir C:\\path [title]');
        const dir = m[1], title = m[2] || 'telegram session';
        const created = (await api('POST','/api/session',{ title, location:{ directory: dir } })).data;
        st.sessionId = created.id; saveState();
        return send(chat_id, `🆕 \`${created.id}\` in \`${esc(dir)}\``);
      }
      case '/status': {
        const info = await api('GET','/api/info');
        const lines = [`*OpenCode ${info.version}*`, `service \`${BASE.replace('http://','')}\``];
        if (st.sessionId) {
          const s = await getSession(st.sessionId);
          if (s) {
            const running = (await activeIds()).includes(s.id);
            lines.push(`▸ \`${s.id}\` ${running?'· ▶ running':'· ○ idle'}`);
            lines.push(esc(short(s.title||'',60)));
            lines.push(`\`${esc(s.location?.directory||'')}\``);
            lines.push(`tokens ${(s.tokens?.input??0)+(s.tokens?.output??0)} · $${(s.cost??0).toFixed(4)}`);
          } else lines.push('session missing');
        } else lines.push('no session — /sessions');
        lines.push(`watch: ${watchAll?'on':'off'}`);
        return send(chat_id, lines.join('\n'));
      }
      case '/stop': {
        if (!st.sessionId) return send(chat_id, 'no session');
        await api('POST', `/api/session/${st.sessionId}/interrupt`);
        return send(chat_id, '⏹ interrupted');
      }
      case '/remember': {
        if (!cfg.rememberScript) return send(chat_id, 'remember is not configured; set rememberScript in config.json');
        if (!arg) return send(chat_id, 'usage: /remember <text>');
        const entry = await remember(arg);
        return send(chat_id, `saved · ${esc(entry)}`);
      }
      case '/watch': {
        if (arg === 'on') watchAll = true; else if (arg === 'off') watchAll = false;
        cfg.watchAll = watchAll;
        try { fs.writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2)); } catch {}
        return send(chat_id, `watch: *${watchAll?'on':'off'}*`);
      }
      default:
        await runPrompt(chat_id, userId, text);
    }
  } catch (e) { log('handler', e.message); await send(chat_id, '⚠️ ' + short(e.message, 300)); }
}

// ---------- main ----------
function remember(text) {
  const script = cfg.rememberScript;
  const ext = path.extname(script).toLowerCase();
  let cmd, args;
  if (ext === '.ps1') {
    cmd = 'powershell.exe';
    args = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Text', text, '-Tag', 'telegram'];
  } else if (ext === '.js' || ext === '.mjs') {
    cmd = process.execPath;
    args = [script, '--text', text, '--tag', 'telegram'];
  } else {
    cmd = script;
    args = ['--text', text, '--tag', 'telegram'];
  }
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { windowsHide: true, timeout: 30000 }, (err, stdout, stderr) => {
      if (err) return reject(new Error((stderr || err.message).trim().slice(0, 200)));
      resolve(stdout.trim());
    });
  });
}

log('bridge start; allowed =', [...ALLOWED].join(',') || '(none)');
try { await tg('deleteWebhook', {}); } catch {}
await tg('setMyCommands', { commands: [
  { command:'sessions', description:'list sessions + running state' },
  { command:'use', description:'switch session by number' },
  { command:'active', description:'only running sessions' },
  { command:'new', description:'new session' },
  { command:'status', description:'current session info' },
  { command:'stop', description:'interrupt current run' },
  { command:'remember', description:'save a note to the brain' },
  { command:'watch', description:'completion pings on/off' },
  { command:'ping', description:'health check' },
]});

let offset = state.__offset || 0;
setInterval(() => { watchTick().catch(e => log('watch loop', e.message)); }, 6000);

for (;;) {
  try {
    const res = await fetch(`${TG}/getUpdates`, {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ offset, timeout:50, allowed_updates:['message','callback_query'] }),
      signal: AbortSignal.timeout(70000),
    });
    const json = await res.json();
    if (json.ok) for (const u of json.result) { offset = u.update_id + 1; state.__offset = offset; saveState(); await handleUpdate(u); }
    else { log('getUpdates', JSON.stringify(json).slice(0,150)); await sleep(5000); }
  } catch (e) { log('poll', e.message); await sleep(3000); }
}
