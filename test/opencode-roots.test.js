import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { withUnreadableFile } from '../test-support/file-permissions.js';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { parse } from '../src/parsers/opencode.js';
import { validateExtraRoot } from '../src/extra-roots.js';
import { getOpenCodeStores } from '../src/opencode-roots.js';
const require = createRequire(import.meta.url);
const start = Date.parse('2026-09-12T00:00:00Z');
function rows(session = 'ses_one', model = 'test-model') {
  return [{ id: 'user', sessionID: session, role: 'user', time: { created: start }, path: { root: '/work/project' } },
    { id: 'reply', sessionID: session, role: 'assistant', time: { created: start + 1000 },
      modelID: model, tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2 } }, path: { root: '/work/project' } }];
}
function execSql(path, sql) {
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses the CLI. */ }
  if (DatabaseSync) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }
  else execFileSync('sqlite3', [path], { input: sql });
}
function quoteSql(value) { return "'" + String(value).replaceAll("'", "''") + "'"; }
function sqlite(root, messages, name = 'opencode.db') {
  mkdirSync(root, { recursive: true });
  const sql = 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);'
    + messages.map(m => `INSERT INTO message VALUES (${quoteSql(m.id)},${quoteSql(m.sessionID)},${quoteSql(JSON.stringify(m))});`).join('');
  execSql(join(root, name), sql);
}
// OpenCode 2.x layout: usage lives in the session_message projection, the
// project directory in the session row, and there is no legacy message table.
function sqliteV2(root, { sessions = [], messages = [], sessionTable = 'session_v2' }) {
  mkdirSync(root, { recursive: true });
  const sql = `CREATE TABLE ${sessionTable} (id TEXT PRIMARY KEY, directory TEXT);`
    + 'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);'
    + sessions.map(s => `INSERT INTO ${sessionTable} VALUES (${quoteSql(s.id)},${quoteSql(s.directory)});`).join('')
    + messages.map(m => `INSERT INTO session_message VALUES (${quoteSql(m.id)},${quoteSql(m.sessionID)},${quoteSql(m.type)},${Number(m.time)},${quoteSql(JSON.stringify(m.data))});`).join('');
  execSql(join(root, 'opencode.db'), sql);
}
function v2Message(id, sessionID, type, time, data = {}) { return { id, sessionID, type, time, data }; }
function json(root, messages) {
  mkdirSync(join(root, 'storage', 'message'), { recursive: true });
  for (const m of messages) {
    const dir = join(root, 'storage', 'message', m.sessionID);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, m.id + '.json'), JSON.stringify(m));
  }
}
async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'opencode-roots-'));
  const old = process.env.VIBE_USAGE_OPENCODE_DIRS;
  const oldDb = process.env.OPENCODE_DB;
  process.env.VIBE_USAGE_OPENCODE_DIRS = join(root, 'default');
  delete process.env.OPENCODE_DB;
  try { await run(root, join(root, 'default')); }
  finally {
    if (old === undefined) delete process.env.VIBE_USAGE_OPENCODE_DIRS;
    else process.env.VIBE_USAGE_OPENCODE_DIRS = old;
    if (oldDb === undefined) delete process.env.OPENCODE_DB;
    else process.env.OPENCODE_DB = oldDb;
    rmSync(root, { recursive: true, force: true });
  }
}

test('OpenCode discovers XDG_DATA_HOME SQLite and legacy stores using native paths', async () => fixture(async (root, primary) => {
  const oldXdg = process.env.XDG_DATA_HOME;
  const dataHome = join(root, 'custom data');
  const store = join(dataHome, 'opencode');
  process.env.XDG_DATA_HOME = dataHome;
  delete process.env.VIBE_USAGE_OPENCODE_DIRS;
  try {
    json(store, rows());
    assert.deepEqual(getOpenCodeStores(), [{ kind: 'json', path: realpathSync(join(store, 'storage', 'message')) }]);
    assert.equal((await parse()).buckets[0].inputTokens, 10);
    sqlite(store, rows());
    assert.deepEqual(getOpenCodeStores(), [{ kind: 'sqlite', path: realpathSync(join(store, 'opencode.db')) }]);
    assert.equal((await parse()).buckets[0].inputTokens, 10);

    // An explicit directory override still replaces normal machine discovery.
    process.env.VIBE_USAGE_OPENCODE_DIRS = primary;
    json(primary, rows('ses_override'));
    assert.deepEqual(getOpenCodeStores(), [{ kind: 'json', path: realpathSync(join(primary, 'storage', 'message')) }]);

    // An explicit database remains authoritative even with XDG configured.
    process.env.OPENCODE_DB = join(store, 'opencode.db');
    assert.deepEqual(getOpenCodeStores(), [{ kind: 'sqlite', path: realpathSync(join(store, 'opencode.db')) }]);
  } finally {
    if (oldXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = oldXdg;
  }
}));

test('OpenCode validates SQLite and legacy layouts without throwing on absent paths', async () => fixture(async root => {
  const db = join(root, 'db'), old = join(root, 'json');
  sqlite(db, []); json(old, []);
  assert.equal(validateExtraRoot('opencode', db).ok, true);
  assert.equal(validateExtraRoot('opencode', old).ok, true);
  assert.equal(validateExtraRoot('opencode', join(root, 'absent')).ok, false);
  mkdirSync(join(root, 'wrong', 'opencode.db'), { recursive: true });
  assert.equal(validateExtraRoot('opencode', join(root, 'wrong')).ok, false);
}));

test('OpenCode combines default SQLite and extra SQLite raw rows exactly once', async () => fixture(async (root, primary) => {
  sqlite(primary, rows()); const extra = join(root, 'extra'); sqlite(extra, rows('ses_two'));
  const result = await parse({ extraRoots: [extra] });
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].inputTokens, 20);
  assert.equal(result.buckets[0].cachedInputTokens, 4);
  assert.equal(result.buckets[0].reasoningOutputTokens, 2);
  assert.equal(result.sessions.length, 2);
  assert.deepEqual(await parse({ extraRoots: [extra] }), result);
}));

test('OpenCode merges SQLite and JSON stores and preserves top-level model precedence', async () => fixture(async (root, primary) => {
  json(primary, rows()); const extra = join(root, 'extra');
  const nested = rows('ses_two'); nested[1].model = { modelID: 'nested-model' }; delete nested[1].modelID;
  sqlite(extra, nested);
  const both = rows('ses_three', 'keep-existing'); both[1].model = { modelID: 'do-not-rename' };
  const extraJson = join(root, 'extra-json'); json(extraJson, both);
  const result = await parse({ extraRoots: [extra, extraJson] });
  assert.deepEqual(result.buckets.map(b => b.model).sort(), ['keep-existing', 'nested-model', 'test-model']);
  assert.equal(result.sessions.length, 3);
}));

test('OpenCode deduplicates copied databases, symlinks, and SQLite/JSON copies by message identity', async () => fixture(async (root, primary) => {
  sqlite(primary, rows()); const copy = join(root, 'copy'); cpSync(primary, copy, { recursive: true });
  const alias = join(root, 'alias'); symlinkSync(primary, alias, 'dir');
  const legacy = join(root, 'legacy'); json(legacy, rows());
  const result = await parse({ extraRoots: [primary, copy, alias, legacy] });
  assert.equal(getOpenCodeStores({ extraRoots: [primary, alias] }).length, 1);
  assert.equal(result.buckets[0].inputTokens, 10);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
}));

test('OpenCode keeps richer copies and additional messages while preserving independent sessions', async () => fixture(async (root, primary) => {
  sqlite(primary, rows()); const extra = join(root, 'extra'); const messages = rows();
  messages[1].tokens.input = 15;
  messages.push({ ...messages[1], id: 'reply-two', time: { created: start + 2000 } });
  json(extra, messages);
  const result = await parse({ extraRoots: [extra] });
  assert.equal(result.buckets[0].inputTokens, 30);
  assert.equal(result.sessions[0].messageCount, 3);
}));

test('OpenCode SQLite precedence is per root, including an empty migrated database', async () => fixture(async (root, primary) => {
  sqlite(primary, []); json(primary, rows()); const extra = join(root, 'extra'); json(extra, rows('ses_two'));
  const result = await parse({ extraRoots: [extra] });
  assert.equal(result.buckets[0].inputTokens, 10);
  assert.equal(result.sessions.length, 1);
}));

test('OpenCode missing configured roots and corrupt stores suppress partial uploads', async () => fixture(async (root, primary) => {
  sqlite(primary, rows());
  for (const name of ['missing', 'broken-db', 'broken-json']) {
    const dir = join(root, name);
    if (name === 'broken-db') { mkdirSync(dir); writeFileSync(join(dir, 'opencode.db'), 'not sqlite'); }
    if (name === 'broken-json') { json(dir, rows()); writeFileSync(join(dir, 'storage/message/ses_one/reply.json'), '{'); }
    const result = await parse({ extraRoots: [dir] });
    assert.equal(result.skipped, true);
    assert.ok(result.warnings.length);
    assert.deepEqual(result.buckets, []);
  }
}));


test('OpenCode does not rename existing unknown-project buckets from cwd metadata', async () => fixture(async (root, primary) => {
  const messages = rows(); messages[1].path = { cwd: '/work/do-not-rename' };
  sqlite(primary, messages);
  assert.equal((await parse()).buckets[0].project, 'unknown');
}));

test('unreadable OpenCode database protects the source state', {
  skip: process.getuid?.() === 0 && 'POSIX root bypasses chmod denial; run as an unprivileged user',
}, async () => fixture(async (root, primary) => {
  sqlite(primary, rows()); const path = join(primary, 'opencode.db');
  await withUnreadableFile(path, async () => {
    const result = await parse();
    assert.equal(result.skipped, true);
    assert.ok(result.warnings.length);
    assert.deepEqual(result.buckets, []);
  });
}));

test('OpenCode reads the 2.x session_message projection without a legacy message table', async () => fixture(async (root, primary) => {
  sqliteV2(primary, {
    sessions: [{ id: 'ses_v2', directory: '/work/v2-project' }],
    messages: [
      v2Message('msg_u1', 'ses_v2', 'user', start, { type: 'user', text: 'private prompt text' }),
      v2Message('msg_a1', 'ses_v2', 'assistant', start + 1000, {
        type: 'assistant',
        model: { id: 'claude-opus-4-6', providerID: 'opencode' },
        tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 4 } },
      }),
      v2Message('msg_idle', 'ses_v2', 'idle', start + 2000, { type: 'idle' }),
    ],
  });
  const result = await parse();
  assert.equal(result.skipped, undefined);
  assert.equal(result.buckets.length, 1);
  assert.deepEqual(result.buckets[0], {
    source: 'opencode',
    model: 'claude-opus-4-6',
    project: 'v2-project',
    bucketStart: '2026-09-12T00:00:00.000Z',
    inputTokens: 10,
    outputTokens: 3,
    cachedInputTokens: 2,
    reasoningOutputTokens: 1,
    cacheCreation5mTokens: 4,
    cacheCreation1hTokens: 0,
    totalTokens: 18,
  });
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
  assert.equal(result.sessions[0].messageCount, 2);
}));

test('OpenCode reads a store whose session row uses the pre-split session table name', async () => fixture(async (root, primary) => {
  sqliteV2(primary, {
    sessionTable: 'session',
    sessions: [{ id: 'ses_plain', directory: '/work/plain-session' }],
    messages: [v2Message('msg_a1', 'ses_plain', 'assistant', start, {
      model: { id: 'kimi-k2.5', providerID: 'opencode' },
      tokens: { input: 5, output: 2, reasoning: 0, cache: { read: 0, write: 0 } },
    })],
  });
  const result = await parse();
  assert.equal(result.buckets[0].project, 'plain-session');
  assert.equal(result.buckets[0].model, 'kimi-k2.5');
  assert.equal(result.buckets[0].inputTokens, 5);
}));

test('OpenCode counts a message present in both stores once and keeps its legacy project', async () => fixture(async (root, primary) => {
  sqlite(primary, rows());
  const shared = JSON.parse(JSON.stringify(rows()));
  const sql = 'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);'
    + 'CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT);'
    + `INSERT INTO session_v2 VALUES (${quoteSql('ses_one')},${quoteSql('/work/migrated-project')});`
    + shared.filter(m => m.role === 'assistant').map(m => `INSERT INTO session_message VALUES (${quoteSql(m.id)},${quoteSql(m.sessionID)},${quoteSql('assistant')},${m.time.created},${quoteSql(JSON.stringify(m))});`).join('');
  execSql(join(primary, 'opencode.db'), sql);
  const result = await parse();
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].inputTokens, 10);
  assert.equal(result.buckets[0].project, 'project');
}));

test('OpenCode names an unreadable store shape instead of reporting a missing table', async () => fixture(async (root, primary) => {
  mkdirSync(primary, { recursive: true });
  execSql(join(primary, 'opencode.db'), 'CREATE TABLE unrelated (id TEXT);');
  const result = await parse();
  assert.equal(result.skipped, true);
  assert.deepEqual(result.buckets, []);
  assert.match(result.warnings[0], /不认识的表结构/);
}));

test('OpenCode reads the OPENCODE_DB override instead of the default database', async () => fixture(async (root, primary) => {
  sqlite(primary, rows('ses_stale', 'stale-model'));
  const active = join(root, 'custom-location', 'active.sqlite');
  sqlite(join(root, 'custom-location'), rows('ses_active', 'active-model'), 'active.sqlite');
  process.env.OPENCODE_DB = active;
  const stores = getOpenCodeStores();
  assert.ok(stores.some(store => store.kind === 'sqlite' && store.path === realpathSync(active)));
  const result = await parse();
  assert.deepEqual(result.buckets.map(bucket => bucket.model), ['active-model']);
  assert.equal(result.sessions.length, 1);
}));

test('OpenCode active database override takes precedence over legacy JSON in its directory', async () => fixture(async (root, primary) => {
  json(primary, rows());
  sqlite(primary, [], 'active.sqlite');
  process.env.OPENCODE_DB = join(primary, 'active.sqlite');
  const result = await parse();
  assert.deepEqual(result.buckets, []);
  assert.deepEqual(result.sessions, []);
}));

test('OpenCode missing OPENCODE_DB override protects prior upload state', async () => fixture(async (root, primary) => {
  sqlite(primary, rows());
  process.env.OPENCODE_DB = join(root, 'missing', 'active.sqlite');
  const result = await parse();
  assert.equal(result.skipped, true);
  assert.ok(result.warnings.some(message => message.includes('無法讀取資料庫')));
  assert.deepEqual(result.buckets, []);
}));
