import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { parse } from '../src/parsers/commandcode.js';
import { parsers } from '../src/parsers/index.js';
import { TOOLS, getCommandcodeRoots } from '../src/tools.js';

const t0 = '2026-10-01T08:51:53.946Z';
const cwd = '/work/demo-project';

// Shapes copied from a real store (Command Code 3.x session format): the first
// line is a `type:"session"` header with cwd, every later line is a
// `type:"message"` entry. Prompts and replies both carry a stable
// `message.meta.messageId` (an API UUID); only assistant replies carry `usage`.
const header = (id, overrides = {}) => ({ type: 'session', version: 3, id, timestamp: t0, cwd, ...overrides });

const userRecord = (id, messageId) => ({
  type: 'message', id, parentId: null, timestamp: t0,
  message: {
    role: 'user',
    content: [{ type: 'text', text: 'DO NOT UPLOAD' }],
    meta: { source: 'user', createdAt: Date.parse(t0), messageId },
  },
});

const assistantRecord = (id, messageId, overrides = {}) => ({
  type: 'message', id, parentId: `${id}-parent`, timestamp: '2026-10-01T08:52:04.452Z',
  message: {
    role: 'assistant',
    content: [{ type: 'text', text: 'reply' }],
    meta: { source: 'model', createdAt: Date.parse(t0) + 10000, messageId },
  },
  // inputTokens is the TOTAL prompt count (verified: reconstructing costUsd
  // from catalog rates matches only when cache reads/writes are subtracted).
  usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 70, cacheWriteTokens: 10, costUsd: 0.999 },
  model: 'deepseek/deepseek-v4.1-flash',
  ...overrides,
});

function writeTranscript(root, folder, sessionId, records, extension = '.jsonl') {
  const dir = join(root, 'projects', folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sessionId}${extension}`),
    `${records.map(record => JSON.stringify(record)).join('\n')}\n`, 'utf-8');
  return dir;
}

async function fixture(run) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-commandcode-'));
  const previous = process.env.VIBE_USAGE_COMMANDCODE_DIRS;
  process.env.VIBE_USAGE_COMMANDCODE_DIRS = root;
  try { await run(root); }
  finally {
    if (previous === undefined) delete process.env.VIBE_USAGE_COMMANDCODE_DIRS;
    else process.env.VIBE_USAGE_COMMANDCODE_DIRS = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

const sum = (buckets, key) => buckets.reduce((total, bucket) => total + bucket[key], 0);

test('commandcode is registered and resolves roots', () => {
  assert.equal(typeof parsers.commandcode, 'function');
  assert.equal(TOOLS.find(tool => tool.id === 'commandcode')?.name, 'Command Code');
  assert.deepEqual(getCommandcodeRoots({ VIBE_USAGE_COMMANDCODE_DIRS: `/a${delimiter}/b` }), ['/a', '/b']);
  assert.deepEqual(getCommandcodeRoots({}, '/home/me'), [join('/home/me', '.commandcode')]);
});

test('commandcode splits the total input into uncached / cache-read / cache-write', async () => fixture(async root => {
  writeTranscript(root, 'users-jwang-documents-workspace-demo-project', 'session-1', [
    header('session-1'),
    userRecord('u1', 'user-msg-1'),
    assistantRecord('a1', 'call-1'),
  ]);

  const result = await parse();
  assert.equal(result.skipped, undefined);
  assert.equal(result.buckets.length, 1);
  const bucket = result.buckets[0];
  assert.equal(bucket.source, 'commandcode');
  assert.equal(bucket.model, 'deepseek/deepseek-v4.1-flash');
  assert.equal(bucket.project, 'demo-project'); // from the header cwd
  assert.equal(bucket.inputTokens, 20); // 100 total − 70 cache read − 10 cache write
  assert.equal(bucket.cachedInputTokens, 70);
  assert.equal(bucket.cacheCreation5mTokens, 10);
  assert.equal(bucket.cacheCreation1hTokens, 0);
  assert.equal(bucket.outputTokens, 20);
  assert.equal(bucket.totalTokens, 50); // uncached input + output + cache write

  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].project, 'demo-project');
  assert.equal(result.sessions[0].userMessageCount, 1);
  assert.equal(result.sessions[0].messageCount, 2);

  assert.equal(JSON.stringify(result).includes('DO NOT UPLOAD'), false);
}));

test('commandcode collapses a forked copy onto the same API call id', async () => fixture(async root => {
  // A fork/clone replays the source conversation verbatim, keeping the same
  // message.meta.messageId. The copied call must be counted once; the fork's own
  // new call still counts.
  writeTranscript(root, 'work-demo-project', 'source', [
    header('source'), userRecord('u1', 'user-msg-1'), assistantRecord('a1', 'call-1'),
  ]);
  writeTranscript(root, 'work-demo-project', 'fork', [
    header('fork'), userRecord('u1-copy', 'user-msg-1'), assistantRecord('a1-copy', 'call-1'),
    userRecord('u2', 'user-msg-2'), assistantRecord('a2', 'call-2', {
      usage: { inputTokens: 40, outputTokens: 8, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0.1 },
    }),
  ]);

  const result = await parse();
  // One bucket (same model/project/half-hour); the un-deduped total would be 60.
  assert.equal(result.buckets.length, 1);
  assert.equal(sum(result.buckets, 'inputTokens'), 20 + 40);
  assert.equal(sum(result.buckets, 'outputTokens'), 20 + 8);
  assert.equal(result.warnings.length, 0);
}));

test('commandcode dedupes copied events so session timing is not inflated', async () => fixture(async root => {
  writeTranscript(root, 'work-demo-project', 'source', [
    header('source'), userRecord('u1', 'user-msg-1'), assistantRecord('a1', 'call-1'),
  ]);
  // The fork contains only a verbatim copy: no unique prompt, so it contributes
  // no session of its own.
  writeTranscript(root, 'work-demo-project', 'fork', [
    header('fork'), userRecord('u1-copy', 'user-msg-1'), assistantRecord('a1-copy', 'call-1'),
  ]);

  const result = await parse();
  assert.equal(result.sessions.length, 1);
  assert.equal(result.sessions[0].userMessageCount, 1);
  assert.equal(result.sessions[0].messageCount, 2);
}));

test('commandcode ignores checkpoint/prompt sidecar files', async () => fixture(async root => {
  writeTranscript(root, 'work-demo-project', 'session-1', [assistantRecord('a1', 'call-1')], '.checkpoints.jsonl');
  writeTranscript(root, 'work-demo-project', 'session-1', [assistantRecord('a2', 'call-2')], '.prompts.jsonl');

  const result = await parse();
  assert.deepEqual(result.buckets, []);
}));

test('commandcode falls back to the project slug when the header has no cwd', async () => fixture(async root => {
  writeTranscript(root, 'private-tmp-cc-probe', 'session-2', [
    header('session-2', { cwd: undefined }),
    userRecord('u1', 'user-msg-1'),
    assistantRecord('a1', 'call-1'),
  ]);

  const result = await parse();
  assert.equal(result.buckets.length, 1);
  assert.equal(result.buckets[0].project, 'probe');
}));

test('commandcode warns when assistant replies carry no usage (format canary)', async () => fixture(async root => {
  const bare = assistantRecord('a1', 'call-1');
  delete bare.usage;
  writeTranscript(root, 'work-demo-project', 'session-1', [header('session-1'), userRecord('u1', 'user-msg-1'), bare]);

  const result = await parse();
  assert.deepEqual(result.buckets, []);
  assert.equal(result.warnings.some(warning => warning.includes('usage')), true);
}));

test('commandcode without a projects dir is simply empty, not skipped', async () => fixture(async () => {
  const result = await parse();
  assert.deepEqual(result.buckets, []);
  assert.deepEqual(result.sessions, []);
  assert.equal(result.skipped, undefined);
}));
