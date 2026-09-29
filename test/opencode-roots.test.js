import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { withUnreadableFile } from '../test-support/file-permissions.js';
import { basename, join } from 'node:path';
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
function sqlite(root, messages, name = 'opencode.db') {
  mkdirSync(root, { recursive: true });
  const quote = v => "'" + String(v).replaceAll("'", "''") + "'";
  const sql = 'CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, data TEXT);'
    + messages.map(m => `INSERT INTO message VALUES (${quote(m.id)},${quote(m.sessionID)},${quote(JSON.stringify(m))});`).join('');
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses the CLI. */ }
  const path = join(root, name);
  if (DatabaseSync) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }
  else execFileSync('sqlite3', [path], { input: sql });
}
function addV2Rows(root, sessions, messages) {
  const quote = v => v == null ? 'NULL' : `'${String(v).replaceAll("'", "''")}'`;
  const sql = 'CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT);'
    + 'CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);'
    + sessions.map(s => `INSERT INTO session_v2 VALUES (${quote(s.id)},${quote(s.directory)});`).join('')
    + messages.map(m => `INSERT INTO session_message VALUES (${quote(m.id)},${quote(m.sessionID)},${quote(m.type)},${m.seq},${m.created},${m.created},${quote(JSON.stringify(m.data))});`).join('');
  const path = join(root, 'opencode.db');
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses the CLI. */ }
  if (DatabaseSync) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }
  else execFileSync('sqlite3', [path], { input: sql });
}
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

test('OpenCode reads V2 message usage and deduplicates migrated V1 message identities', async () => fixture(async (root, primary) => {
  const legacy = rows();
  for (const message of legacy) message.path.root = '/';
  sqlite(primary, legacy);
  addV2Rows(primary, [{ id: 'ses_one', directory: '/work/project' }], [
    { id: 'user', sessionID: 'ses_one', type: 'user', seq: 0, created: start,
      data: { time: { created: start }, agent: 'build' } },
    { id: 'reply', sessionID: 'ses_one', type: 'assistant', seq: 1, created: start + 1000,
      data: { time: { created: start + 1000 },
        tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2, write: 5 } } } },
    { id: 'user-two', sessionID: 'ses_one', type: 'user', seq: 2, created: start + 2000,
      data: { time: { created: start + 2000 }, agent: 'build' } },
    { id: 'reply-two', sessionID: 'ses_one', type: 'assistant', seq: 3, created: start + 3000,
      data: { time: { created: start + 3000 }, model: { id: 'glm-5.3', providerID: 'zai-coding-plan' },
        tokens: { input: 6, output: 4, reasoning: 3, cache: { read: 2, write: 5 } } } },
    { id: 'reply-write-only', sessionID: 'ses_one', type: 'assistant', seq: 4, created: start + 4000,
      data: { time: { created: start + 4000 }, model: { id: 'glm-5.3', providerID: 'zai-coding-plan' },
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 7 } } } },
  ]);

  const result = await parse();
  assert.deepEqual(result.buckets.map(({ model, project, inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, cacheCreation5mTokens }) =>
    ({ model, project, inputTokens, outputTokens, cachedInputTokens, reasoningOutputTokens, cacheCreation5mTokens })), [
    { model: 'test-model', project: 'project', inputTokens: 10, outputTokens: 3, cachedInputTokens: 2, reasoningOutputTokens: 1, cacheCreation5mTokens: 5 },
    { model: 'glm-5.3', project: 'project', inputTokens: 6, outputTokens: 4, cachedInputTokens: 2, reasoningOutputTokens: 3, cacheCreation5mTokens: 12 },
  ]);
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 2);
  assert.equal(result.sessions[0].messageCount, 5);
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

test('OpenCode discovers every opencode*.db sibling and ignores wal, foreign, and directory decoys', async () => fixture(async (root, primary) => {
  sqlite(primary, rows());
  sqlite(primary, rows('ses_two'), 'opencode-feature-branch.db');
  writeFileSync(join(primary, 'opencode.db-wal'), 'ignore');
  writeFileSync(join(primary, 'other.db'), 'ignore');
  mkdirSync(join(primary, 'opencode-directory.db'));
  const stores = getOpenCodeStores();
  assert.deepEqual(stores.map(s => basename(s.path)).sort(), ['opencode-feature-branch.db', 'opencode.db']);
  assert.equal((await parse()).sessions.length, 2);
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

test('OpenCode unsupported SQLite schema protects prior upload state', async () => fixture(async (root, primary) => {
  sqlite(primary, []);
  const path = join(primary, 'opencode.db');
  const sql = 'DROP TABLE message; CREATE TABLE unrelated (id TEXT);';
  let DatabaseSync;
  try { ({ DatabaseSync } = require('node:sqlite')); } catch { /* Node 20 uses the CLI. */ }
  if (DatabaseSync) { const db = new DatabaseSync(path); try { db.exec(sql); } finally { db.close(); } }
  else execFileSync('sqlite3', [path], { input: sql });

  const result = await parse();
  assert.equal(result.skipped, true);
  assert.ok(result.warnings.some(message => message.includes('支援的資料表')));
  assert.deepEqual(result.buckets, []);
}));

test('OpenCode sibling databases merge split history and keep the most complete copy', async () => fixture(async (root, primary) => {
  sqlite(primary, rows());
  const rotated = rows();
  rotated[1] = { ...rotated[1], tokens: { input: 4, output: 1 } };
  rotated.push({ ...rotated[1], id: 'reply-two', time: { created: start + 2000 },
    tokens: { input: 10, output: 3, reasoning: 1, cache: { read: 2 } } });
  sqlite(primary, rotated, 'opencode-rotated.db');
  const result = await parse();
  assert.equal(result.buckets[0].inputTokens, 20);
  assert.equal(result.buckets[0].cachedInputTokens, 4);
  assert.equal(result.sessions[0].messageCount, 3);
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
