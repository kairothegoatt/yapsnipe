#!/usr/bin/env node
// yapsnipe - list every free short username on yapper.website.
// Zero dependencies, Node 18+.
'use strict';

const fs = require('fs');
const path = require('path');

const DIR = __dirname;
const CONFIG = path.join(DIR, 'config.json');
const STATE = path.join(DIR, 'state.json');
const OUT = path.join(DIR, 'available.txt');
const CURL = path.join(DIR, 'curl.txt');
const PLACEHOLDER = 'PASTE';

// ---------- args ----------
function parseArgs(argv) {
  const o = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { o._.push(a); continue; }
    const k = a.slice(2);
    if (['dry', 'fresh', 'help', 'single'].includes(k)) o[k] = true;
    else o[k] = argv[++i];
  }
  return o;
}

const args = parseArgs(process.argv.slice(2));
const cmd = args.help ? 'help' : (args._[0] || 'help');

function die(msg) { console.error('error: ' + msg); process.exit(1); }

// ---------- config ----------
function loadConfig() {
  if (!fs.existsSync(CONFIG)) die('config.json not found. Copy config.example.json to config.json and fill it in.');
  let c;
  // Notepad sometimes saves with a BOM, which JSON.parse rejects
  try { c = JSON.parse(fs.readFileSync(CONFIG, 'utf8').replace(/^﻿/, '')); }
  catch (e) { die('config.json is not valid JSON: ' + e.message); }
  loginFromCurl(c);
  return c;
}

// If curl.txt holds a "Copy as cURL" from the browser, take the login headers from it.
// Handles both the cmd flavour (^" escapes) and the bash flavour ('...').
function loginFromCurl(c) {
  if (!fs.existsSync(CURL)) return;
  const text = fs.readFileSync(CURL, 'utf8').replace(/\^(.)/g, '$1');
  if (!text.trim()) return;
  const found = {};
  const re = /-H\s+["']([A-Za-z-]+):\s*([^"']*)["']/g;
  let m;
  while ((m = re.exec(text))) found[m[1].toLowerCase()] = m[2].trim();
  c.extraHeaders = c.extraHeaders || {};
  for (const k of ['apikey', 'authorization'])
    if (found[k]) c.extraHeaders[k] = found[k];
  if (!found.authorization) die('curl.txt has no "authorization" header. Copy a request that goes to api.yapper.website.');
}

function requireReady(c) {
  if (!c.checkUrl || c.checkUrl.includes(PLACEHOLDER))
    die('checkUrl in config.json is still the placeholder. See README step 3 to find the real one.');
  if (!c.checkUrl.includes('{name}') && !JSON.stringify(c.body || '').includes('{name}'))
    die('put {name} in checkUrl (GET) or in body (POST) where the username goes.');
  if (JSON.stringify(c.body || '').includes(PLACEHOLDER))
    die('body in config.json is still the placeholder. See README step 3.');
  if (c.needsCookie !== false && (!c.cookie || c.cookie.includes(PLACEHOLDER)))
    die('cookie in config.json is still the placeholder. See README step 2.');
  for (const [k, v] of Object.entries(c.extraHeaders || {}))
    if (String(v).includes(PLACEHOLDER)) die('not logged in yet. Paste a request copied as cURL into curl.txt (README step 2).');
}

// Builds the request for one name. Supabase RPCs are POSTs with a JSON body.
function request(c, name) {
  const url = c.checkUrl.replace('{name}', encodeURIComponent(name));
  if (!c.body) return { url, method: c.method || 'GET' };
  const body = JSON.stringify(c.body).split('{name}').join(name.replace(/["\\]/g, ''));
  return { url, method: c.method || 'POST', body };
}

// ---------- candidates ----------
function candidates(c) {
  const chars = args.chars || c.chars || 'abcdefghijklmnopqrstuvwxyz0123456789';
  // --len n means exactly n; otherwise --min/--max (or minLength/maxLength in config)
  const min = parseInt(args.len || args.min || c.minLength || c.length || 2, 10);
  const max = parseInt(args.len || args.max || c.maxLength || c.length || 2, 10);
  if (!(min >= 1 && max <= 4 && min <= max)) die('lengths must be between 1 and 4, with --min no bigger than --max.');
  // Shortest names first, so the most valuable results arrive early
  const list = [];
  let level = [''];
  for (let len = 1; len <= max; len++) {
    const next = [];
    for (const p of level) for (const ch of chars) next.push(p + ch);
    level = next;
    if (len >= min) for (const n of level) list.push(n);
  }
  return args.limit ? list.slice(0, parseInt(args.limit, 10)) : list;
}

// ---------- http ----------
const sleep = ms => new Promise(r => setTimeout(r, ms));

function headers(c) {
  const h = {
    'accept': 'application/json, text/plain, */*',
    'user-agent': c.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36',
  };
  if (c.cookie && !c.cookie.includes(PLACEHOLDER)) h.cookie = c.cookie;
  if (c.extraHeaders) Object.assign(h, c.extraHeaders);
  return h;
}

async function fetchRetry(req, c) {
  let wait = 1000;
  const h = headers(c);
  if (req.body) h['content-type'] = 'application/json';
  const timeout = parseInt(c.timeoutMs || 20000, 10);
  for (let attempt = 1; attempt <= 6; attempt++) {
    try {
      const res = await fetch(req.url, {
        method: req.method, headers: h, body: req.body, redirect: 'manual',
        signal: AbortSignal.timeout(timeout),
      });
      if (res.status === 429) {
        const ra = parseFloat(res.headers.get('retry-after'));
        const ms = Number.isFinite(ra) ? ra * 1000 : wait;
        note(`rate limited by the server, waiting ${Math.round(ms / 1000)}s (try ${attempt}/6)`);
        await sleep(ms);
        wait = Math.min(wait * 2, 60000);
        continue;
      }
      if (res.status >= 500) {
        note(`server error ${res.status}, retrying in ${Math.round(wait / 1000)}s (try ${attempt}/6)`);
        await sleep(wait); wait = Math.min(wait * 2, 60000);
        continue;
      }
      return { status: res.status, body: await res.text() };
    } catch (e) {
      if (attempt === 6) throw e;
      const why = e.name === 'TimeoutError' ? `no reply after ${timeout / 1000}s` : (e.cause && e.cause.code || e.message);
      note(`${why}, retrying in ${Math.round(wait / 1000)}s (try ${attempt}/6)`);
      await sleep(wait); wait = Math.min(wait * 2, 60000);
    }
  }
  throw new Error('gave up after repeated 429/5xx');
}

// Returns true (free), false (taken) or null (unknown).
function interpret(status, body, c) {
  if (status === 401 || status === 403) return 'auth';
  if (status >= 300 && status < 400) return 'auth';
  if (c.mode === 'profile') return status === 404 ? true : status === 200 ? false : null;
  if (status === 404) return true;

  let j = null;
  try { j = JSON.parse(body); } catch (_) { /* not JSON */ }
  if (typeof j === 'boolean') return j;
  // Supabase table lookups return [] when no row matches, i.e. nobody has the name
  if (Array.isArray(j)) return j.length === 0;
  if (j && typeof j === 'object') {
    const obj = j.data && typeof j.data === 'object' ? j.data : j;
    for (const k of ['available', 'free', 'is_available', 'isAvailable', 'ok', 'valid'])
      if (typeof obj[k] === 'boolean') return obj[k];
    for (const k of ['taken', 'exists', 'is_taken', 'isTaken'])
      if (typeof obj[k] === 'boolean') return !obj[k];
    return null;
  }
  const t = String(body).trim().toLowerCase();
  if (t === 'true' || t === 'ok') return true;
  if (t === 'false') return false;
  if (t.includes('available')) return !t.includes('not');
  return null;
}

// Checks many names in one request. batchUrl's {names} becomes
// "username.ilike.aa,username.ilike.ab,...", and every row that comes back is a taken name.
async function checkBatch(names, c) {
  const list = names.map(n => 'username.ilike.' + n).join(',');
  const url = c.batchUrl.replace('{names}', encodeURIComponent(list));
  let r;
  try { r = await fetchRetry({ url, method: 'GET' }, c); }
  catch (e) { return names.map(n => [n, { err: e.cause && e.cause.code || e.message }]); }
  if (r.status === 401 || r.status === 403) return names.map(n => [n, 'auth']);
  let rows = null;
  try { rows = JSON.parse(r.body); } catch (_) { /* not JSON */ }
  if (r.status !== 200 || !Array.isArray(rows)) {
    const err = `batch lookup failed (status ${r.status}): ${r.body.slice(0, 200)}\nRun "node snipe.js scan --single" to check one name at a time instead.`;
    return names.map(n => [n, { batchErr: err }]);
  }
  const taken = new Set(rows.map(row => String(row.username || '').toLowerCase()));
  return names.map(n => [n, !taken.has(n.toLowerCase())]);
}

// ---------- state ----------
function loadState() {
  if (args.fresh || !fs.existsSync(STATE)) return { free: [], taken: [], unknown: [] };
  try { return JSON.parse(fs.readFileSync(STATE, 'utf8')); }
  catch (_) { return { free: [], taken: [], unknown: [] }; }
}
function saveState(s) {
  const tmp = STATE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, STATE);
  // Keep available.txt current too, so a long run shows results as it goes
  fs.writeFileSync(OUT, s.free.join('\n') + (s.free.length ? '\n' : ''));
}

// With over a million names, rewriting state after every batch would dominate the run.
let lastSave = 0;
function saveSoon(s) {
  if (Date.now() - lastSave < 5000) return;
  saveState(s);
  lastSave = Date.now();
}

let lastLen = 0;
let lastProgress = '';
function progress(msg) {
  const pad = Math.max(0, lastLen - msg.length);
  process.stdout.write('\r' + msg + ' '.repeat(pad));
  lastLen = msg.length;
  lastProgress = msg;
}

// Shows a retry/wait message on the progress line so a slow run never looks frozen.
function note(msg) {
  const line = (lastProgress ? lastProgress + '  | ' : '') + msg;
  const pad = Math.max(0, lastLen - line.length);
  process.stdout.write('\r' + line + ' '.repeat(pad));
  lastLen = line.length;
}

// ---------- commands ----------
function help() {
  console.log(`yapsnipe - find every free short username on yapper.website

usage: node snipe.js <command> [flags]

commands
  list               print the candidate names (no network)
  test <name>        check one name and show the raw response
  scan               check every candidate, write free ones to available.txt
  help               this text

flags
  --chars <set>      characters to use   (default a-z0-9)
  --min <n>          shortest length     (default from config, 2)
  --max <n>          longest length      (default from config, 3)
  --len <n>          only this length, e.g. --len 2 -> 1296 names
  --limit <n>        only the first n candidates
  --concurrency <n>  parallel requests   (default 3)
  --delay <ms>       pause between batches (default 300)
  --fresh            ignore state.json and start over
  --single           one name per request even if batchUrl is set (slower)
  --dry              scan without touching the network (shows what it would do)
`);
}

function list() {
  const c = fs.existsSync(CONFIG) ? loadConfig() : {};
  const l = candidates(c);
  if (l.length <= 2000) console.log(l.join(' '));
  else console.log(`${l.slice(0, 10).join(' ')} ... ${l.slice(-5).join(' ')}`);
  const byLen = {};
  for (const n of l) byLen[n.length] = (byLen[n.length] || 0) + 1;
  console.log('\n' + Object.entries(byLen).map(([k, v]) => `${k} chars: ${v}`).join('   '));
  console.log(`${l.length} candidates`);
}

async function test() {
  const c = loadConfig(); requireReady(c);
  const name = args._[1];
  if (!name) die('usage: node snipe.js test <name>');
  const req = request(c, name);
  try {
    const r = await fetchRetry(req, c);
    console.log(`${req.method} ${req.url}${req.body ? '\nbody ' + req.body : ''}\nstatus ${r.status}\n${r.body.slice(0, 500)}`);
    const v = interpret(r.status, r.body, c);
    console.log('\nverdict: ' + (v === true ? 'FREE' : v === false ? 'TAKEN' : v === 'auth' ? 'NOT LOGGED IN (login expired: paste a fresh cURL into curl.txt)' : 'UNKNOWN - response shape not recognised'));
  } catch (e) { die('network: ' + (e.cause && e.cause.code || e.message)); }
}

async function scan() {
  const c = loadConfig();
  const all = candidates(c);
  if (args.dry) {
    console.log(`dry run: would check ${all.length} names (${all[0]} .. ${all[all.length - 1]})`);
    if (!c.checkUrl || c.checkUrl.includes(PLACEHOLDER)) console.log('note: checkUrl is still the placeholder, a real scan would stop here.');
    else console.log('first URL: ' + c.checkUrl.replace('{name}', encodeURIComponent(all[0])));
    return;
  }
  requireReady(c);

  const s = loadState();
  const done = new Set([...s.free, ...s.taken]);
  const todo = all.filter(n => !done.has(n));
  s.unknown = [];
  const conc = Math.max(1, parseInt(args.concurrency || c.concurrency || 3, 10));
  const delay = Math.max(0, parseInt(args.delay ?? c.delayMs ?? 300, 10));

  // Ctrl+C finishes the current batch, then saves. A second Ctrl+C quits at once.
  let stop = false;
  let fatal = null;
  process.on('SIGINT', () => {
    if (stop) { saveState(s); process.exit(130); }
    stop = true;
  });

  const batched = !!c.batchUrl && !args.single;
  const step = batched ? Math.max(1, parseInt(c.batchSize || 100, 10)) : conc;
  console.log(`${all.length} candidates, ${todo.length} left to check, ` +
    (batched ? `${step} names per request` : `concurrency ${conc}`));
  const t0 = Date.now();
  let checked = 0;
  progress(`checked ${done.size}/${all.length}  free ${s.free.length}  taken ${s.taken.length}  (waiting for first reply...)`);

  for (let i = 0; i < todo.length && !stop && !fatal; i += step) {
    const batch = todo.slice(i, i + step);
    const results = batched ? await checkBatch(batch, c) : await Promise.all(batch.map(async n => {
      try {
        const r = await fetchRetry(request(c, n), c);
        return [n, interpret(r.status, r.body, c)];
      } catch (e) { return [n, { err: e.cause && e.cause.code || e.message }]; }
    }));
    for (const [n, v] of results) {
      if (v === 'auth') { fatal = 'server says not logged in. Your login expires after about an hour: copy a fresh request as cURL into curl.txt, then run scan again to resume.'; break; }
      if (v && v.batchErr) { fatal = v.batchErr; break; }
      if (v && v.err) { fatal = 'network problem: ' + v.err + '. Progress saved; run scan again to resume.'; break; }
      if (v === true) s.free.push(n);
      else if (v === false) s.taken.push(n);
      else s.unknown.push(n);
      checked++;
    }
    saveSoon(s);
    progress(`checked ${done.size + checked}/${all.length}  free ${s.free.length}  taken ${s.taken.length}  unknown ${s.unknown.length}`);
    if (delay) await sleep(delay);
  }

  saveState(s);
  process.stdout.write('\n');
  // Return instead of process.exit(): exiting with sockets still closing crashes Node on Windows
  if (fatal) { console.error('error: ' + fatal); process.exitCode = 1; return; }
  if (stop) {
    console.log(`stopped. progress saved to state.json (${s.free.length} free so far). Run scan again to resume.`);
    process.exitCode = 130;
    return;
  }
  const freeSet = new Set(s.free);
  const free = all.filter(n => freeSet.has(n));
  fs.writeFileSync(OUT, free.join('\n') + (free.length ? '\n' : ''));
  console.log(`done in ${Math.round((Date.now() - t0) / 1000)}s.`);
  console.log(`\n${free.length} available:\n${free.length > 500 ? free.slice(0, 500).join(' ') + ' ... (full list in available.txt)' : free.join(' ') || '(none)'}`);
  console.log(`\nsaved to ${OUT}`);
  if (s.unknown.length) console.log(`\n${s.unknown.length} names gave a response I couldn't read. Run "node snipe.js test ${s.unknown[0]}" to see it.`);
}

(async () => {
  try {
    if (cmd === 'list') list();
    else if (cmd === 'test') await test();
    else if (cmd === 'scan' || cmd === 'snipe') await scan();
    else help();
  } catch (e) { die(e.message); }
})();
