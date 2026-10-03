import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { gunzipSync } from 'node:zlib';
import {
  resolveCodexExtraHome,
  resolveCachedUploadProjectSetting,
  resolveUploadProjectSetting,
  mapWithConcurrency,
  formatDuration,
  estimateRemainingSeconds,
} from '../src/sync.js';
import { normalizeParserResult } from '../src/parsers/contract.js';

const execFileAsync = promisify(execFile);

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('explicit project-upload settings preserve both privacy choices', () => {
  assert.equal(resolveUploadProjectSetting({ uploadProject: true }), true);
  assert.equal(resolveUploadProjectSetting({ uploadProject: false }), false);
});

test('unavailable or malformed settings abort instead of becoming false', () => {
  for (const settings of [null, undefined, {}, { uploadProject: 'false' }]) {
    assert.throws(
      () => resolveUploadProjectSetting(settings),
      error => error.code === 'SETTINGS_UNAVAILABLE',
    );
  }
});

test('cached project-upload settings are scoped to the confirming API', () => {
  const config = {
    lastUploadProject: true,
    lastUploadProjectApiUrl: 'https://confirmed.example',
  };
  assert.equal(
    resolveCachedUploadProjectSetting(config, 'https://confirmed.example'),
    true,
  );
  assert.equal(
    resolveCachedUploadProjectSetting(config, 'https://different.example'),
    undefined,
  );
  assert.equal(
    resolveCachedUploadProjectSetting({ lastUploadProject: false }, 'https://confirmed.example'),
    undefined,
  );
});

test('temporary extra Codex home overrides persisted config only for this run', () => {
  assert.equal(resolveCodexExtraHome('/persisted/.codex', '/temporary/.codex'), '/temporary/.codex');
  assert.equal(resolveCodexExtraHome('/persisted/.codex', undefined), '/persisted/.codex');
});

// A quiet (daemon) sync used to drop Cursor's fetch soft-skip warning on the
// floor, so an export that failed on every single run left no trace anywhere:
// daemon.log empty, `status` still reporting the tool as installed. Warnings
// must reach stderr regardless of quiet, or a permanent failure is invisible.
// Without an up-front total, a multi-thousand-batch first sync is
// indistinguishable from a hang: the per-batch line only ever shows one batch.
test('a sync announces how much it is about to upload', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-pending-line-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        req.on('data', () => {});
        req.on('end', () => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 250, sessions: 0 }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_pending_line_test',
        apiUrl,
        hostname: 'pending-line-test',
      }));
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['pending-line-test'] = async () => ({
          buckets: Array.from({ length: 250 }, (_, index) => ({
            source: 'pending-line-test',
            model: 'model-' + index,
            project: 'project',
            bucketStart: '2026-09-09T00:00:00.000Z',
            inputTokens: index + 1,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: index + 1,
          })),
          sessions: [],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true });
      `;
      const { stdout } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', command],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: homeDir,
            VIBE_USAGE_DEV: '0',
            VIBE_USAGE_CONFIG_DIR: configDir,
            VIBE_USAGE_STATE_DIR: stateDir,
          },
        },
      );
      assert.match(stdout, /待上传 250 buckets，分 3 批/);
      assert.match(stdout, /上传 .+（已压缩），用时/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('actual-call timestamps ride only on servers that advertise them', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-call-times-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  let advertise = false;
  const ingestedBuckets = [];
  const run = tokens => execFileAsync(process.execPath, ['--input-type=module', '-e', `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) delete parsers[source];
    parsers['call-times-test'] = async () => ({
      buckets: [{
        source: 'call-times-test', model: 'm', project: 'p',
        bucketStart: '2026-10-03T01:30:00.000Z',
        firstCallAt: '2026-10-03T01:32:00.000Z',
        lastCallAt: '2026-10-03T01:47:00.000Z',
        inputTokens: ${tokens}, outputTokens: 0, cachedInputTokens: 0, reasoningOutputTokens: 0,
        totalTokens: ${tokens},
      }],
      sessions: [],
    });
    const { runSync } = await import('./src/sync.js');
    await runSync({ throws: true, quiet: true });
  `], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      VIBE_USAGE_DEV: '0',
      VIBE_USAGE_CONFIG_DIR: configDir,
      VIBE_USAGE_STATE_DIR: stateDir,
    },
  });
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true, ...(advertise ? { bucketCallTimestamps: true } : {}) }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks);
            const body = (req.headers['content-encoding'] || '') === 'gzip' ? gunzipSync(raw) : raw;
            ingestedBuckets.push(...JSON.parse(body.toString('utf8')).buckets);
          } catch { /* assertion fails on the empty list */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 1, sessions: 0 }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_call_times_gate', apiUrl, hostname: 'call-times-host',
      }));
      // Hosted-style server (no capability): the fields must never leave.
      await run(5);
      assert.equal(ingestedBuckets.length, 1);
      assert.equal('firstCallAt' in ingestedBuckets[0], false);
      assert.equal('lastCallAt' in ingestedBuckets[0], false);

      // Local server advertising the capability: the fields ride along.
      advertise = true;
      await run(9);
      const sent = ingestedBuckets[ingestedBuckets.length - 1];
      assert.equal(sent.firstCallAt, '2026-10-03T01:32:00.000Z');
      assert.equal(sent.lastCallAt, '2026-10-03T01:47:00.000Z');
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a quiet sync still writes a parser skip warning to stderr', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-quiet-warning-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_quiet_warning_test',
        apiUrl,
        hostname: 'quiet-warning-test',
      }));
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['cursor'] = async () => ({
          buckets: [],
          sessions: [],
          skipped: true,
          warnings: ['cursor: Cursor usage export skipped (timeout after 120000ms). …'],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;
      const { stderr } = await execFileAsync(
        process.execPath,
        ['--input-type=module', '-e', command],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            HOME: homeDir,
            VIBE_USAGE_DEV: '0',
            VIBE_USAGE_CONFIG_DIR: configDir,
            VIBE_USAGE_STATE_DIR: stateDir,
          },
        },
      );
      assert.match(stderr, /Cursor usage export skipped/);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Local-server quota sync: fixtures point Codex at the fake server so a gate
// failure cannot silently reach the real provider endpoint.
function quotaSyncFixture() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-quota-sync-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  const codexHome = join(root, 'codex');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });
  mkdirSync(codexHome, { recursive: true });
  writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
    tokens: { access_token: 'fixture-quota-token', account_id: 'fixture-account' },
  }));
  return { root, configDir, stateDir, homeDir, codexHome };
}

function quotaSyncCommand() {
  return `
    import { parsers } from './src/parsers/index.js';
    for (const source of Object.keys(parsers)) delete parsers[source];
    const { runSync } = await import('./src/sync.js');
    await runSync({ throws: true, quiet: true });
  `;
}

test('quota sync uploads an opted-in snapshot to its bound loopback server', async () => {
  const { root, configDir, stateDir, homeDir, codexHome } = quotaSyncFixture();
  let codexCalls = 0;
  const ingestBodies = [];
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true, quotaSnapshots: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/codex/usage') {
        codexCalls += 1;
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({
          rate_limit: {
            primary_window: {
              used_percent: 25, limit_window_seconds: 18_000, reset_after_seconds: 3_600,
            },
          },
          plan_type: 'plus',
        }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks);
            const body = (req.headers['content-encoding'] || '') === 'gzip'
              ? gunzipSync(raw) : raw;
            ingestBodies.push(JSON.parse(body.toString('utf8')));
          } catch { /* assertion fails on the empty list */ }
          // Always answer: a handler error must not leave the CLI child
          // retrying its ingest until timeout.
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 0, sessions: 0 }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(codexHome, 'config.toml'), `chatgpt_base_url = "${apiUrl}"\n`);
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_quota_sync_happy_path',
        apiUrl,
        hostname: 'quota-sync-host',
        quotaSyncProducts: ['codex'],
        quotaSyncApiUrl: apiUrl,
      }));
      await execFileAsync(process.execPath, ['--input-type=module', '-e', quotaSyncCommand()], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          VIBE_USAGE_DEV: '0',
          VIBE_USAGE_CONFIG_DIR: configDir,
          VIBE_USAGE_STATE_DIR: stateDir,
          CODEX_HOME: codexHome,
        },
      });
      assert.equal(codexCalls, 1);
      const quotaUploads = ingestBodies.filter(body => Array.isArray(body.quotas) && body.quotas.length);
      assert.equal(quotaUploads.length, 1);
      const [upload] = quotaUploads;
      assert.equal(upload.quotas[0].id, 'codex');
      assert.equal(upload.quotas[0].status, 'ok');
      assert.equal(upload.quotas[0].meters[0].id, 'five-hour');
      assert.equal(upload.client.hostname, 'quota-sync-host');
      assert.equal(JSON.stringify(upload).includes('fixture-quota-token'), false);
      assert.equal(JSON.stringify(upload).includes('fixture-account'), false);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quota sync uploads definitive no-data states instead of leaving cards loading forever', async () => {
  const { root, configDir, stateDir, homeDir, codexHome } = quotaSyncFixture();
  const ingestBodies = [];
  const run = apiUrl => execFileAsync(process.execPath, ['--input-type=module', '-e', quotaSyncCommand()], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      HOME: homeDir,
      VIBE_USAGE_DEV: '0',
      VIBE_USAGE_CONFIG_DIR: configDir,
      VIBE_USAGE_STATE_DIR: stateDir,
      CODEX_HOME: codexHome,
    },
  });
  try {
    // No auth.json in CODEX_HOME: missing_credentials is a definitive answer.
    rmSync(join(codexHome, 'auth.json'));
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true, quotaSnapshots: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks);
            const body = (req.headers['content-encoding'] || '') === 'gzip'
              ? gunzipSync(raw) : raw;
            ingestBodies.push(JSON.parse(body.toString('utf8')));
          } catch { /* assertion fails on the empty list */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 0, sessions: 0 }));
        });
        return;
      }
      // Any provider request would mean the fetch ran despite missing credentials.
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_quota_sync_definitive',
        apiUrl,
        hostname: 'quota-sync-host',
        quotaSyncProducts: ['codex'],
        quotaSyncApiUrl: apiUrl,
      }));
      await run(apiUrl);
    });
    let uploads = ingestBodies.filter(body => Array.isArray(body.quotas) && body.quotas.length);
    assert.equal(uploads.length, 1);
    const [missing] = uploads[0].quotas;
    assert.equal(missing.id, 'codex');
    assert.equal(missing.status, 'no_data');
    assert.equal(missing.emptyReason, 'notDetected');
    assert.deepEqual(missing.meters, []);

    // A rejected token (401 after the one re-read) is also definitive.
    ingestBodies.length = 0;
    rmSync(join(codexHome, 'auth.json'), { force: true });
    writeFileSync(join(codexHome, 'auth.json'), JSON.stringify({
      tokens: { access_token: 'fixture-quota-token', account_id: 'fixture-account' },
    }));
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true, quotaSnapshots: true }));
        return;
      }
      if (req.method === 'GET' && req.url.startsWith('/api/codex/usage')) {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid_token' }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          try {
            const raw = Buffer.concat(chunks);
            const body = (req.headers['content-encoding'] || '') === 'gzip'
              ? gunzipSync(raw) : raw;
            ingestBodies.push(JSON.parse(body.toString('utf8')));
          } catch { /* assertion fails on the empty list */ }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ingested: 0, sessions: 0 }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(codexHome, 'config.toml'), `chatgpt_base_url = "${apiUrl}"\n`);
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_quota_sync_definitive',
        apiUrl,
        hostname: 'quota-sync-host',
        quotaSyncProducts: ['codex'],
        quotaSyncApiUrl: apiUrl,
      }));
      await run(apiUrl);
    });
    uploads = ingestBodies.filter(body => Array.isArray(body.quotas) && body.quotas.length);
    assert.equal(uploads.length, 1);
    const [rejected] = uploads[0].quotas;
    assert.equal(rejected.status, 'no_data');
    assert.equal(rejected.emptyReason, 'unauthorized');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('quota sync never invokes providers without capability or destination binding', async () => {
  const { root, configDir, stateDir, homeDir, codexHome } = quotaSyncFixture();
  let advertiseCapability = true;
  let codexCalls = 0;
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(advertiseCapability
          ? { uploadProject: true, quotaSnapshots: true }
          : { uploadProject: true }));
        return;
      }
      if (req.method === 'GET' && req.url === '/api/codex/usage') {
        codexCalls += 1;
        res.writeHead(500).end();
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(codexHome, 'config.toml'), `chatgpt_base_url = "${apiUrl}"\n`);
      const writeConfig = target => {
        writeFileSync(join(configDir, 'config.json'), JSON.stringify({
          apiKey: 'vbu_quota_sync_gates',
          apiUrl,
          hostname: 'quota-sync-gates',
          quotaSyncProducts: ['codex'],
          quotaSyncApiUrl: target,
        }));
      };

      advertiseCapability = false;
      writeConfig(apiUrl);
      await execFileAsync(process.execPath, ['--input-type=module', '-e', quotaSyncCommand()], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          VIBE_USAGE_DEV: '0',
          VIBE_USAGE_CONFIG_DIR: configDir,
          VIBE_USAGE_STATE_DIR: stateDir,
          CODEX_HOME: codexHome,
        },
      });

      advertiseCapability = true;
      writeConfig('https://other.example');
      await execFileAsync(process.execPath, ['--input-type=module', '-e', quotaSyncCommand()], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: homeDir,
          VIBE_USAGE_DEV: '0',
          VIBE_USAGE_CONFIG_DIR: configDir,
          VIBE_USAGE_STATE_DIR: stateDir,
          CODEX_HOME: codexHome,
        },
      });

      assert.equal(codexCalls, 0);
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('formatDuration renders seconds, minutes and hours', () => {
  assert.equal(formatDuration(0), '0s');
  assert.equal(formatDuration(59), '59s');
  assert.equal(formatDuration(60), '1m');
  assert.equal(formatDuration(90), '1m30s');
  assert.equal(formatDuration(600), '10m');
  assert.equal(formatDuration(3600), '1h');
  assert.equal(formatDuration(3660), '1h 1m');
  // Unchanged from the session-summary formatter this replaced.
  assert.equal(formatDuration(251880), '69h 58m');
  assert.equal(formatDuration(-5), '0s');
});

// The estimate is extrapolated from batches that actually finished. A first
// sync and a steady-state trickle differ by orders of magnitude, so any
// a-priori rate would be wrong for one of them -- report nothing instead.
test('remaining-time estimate only extrapolates from completed batches', () => {
  assert.equal(estimateRemainingSeconds({ elapsedMs: 5000, doneBatches: 0, totalBatches: 53 }), null);
  assert.equal(estimateRemainingSeconds({ elapsedMs: 0, doneBatches: 3, totalBatches: 53 }), null);
  assert.equal(estimateRemainingSeconds({ elapsedMs: 5000, doneBatches: 53, totalBatches: 53 }), null);
  assert.equal(estimateRemainingSeconds({ elapsedMs: 5000, doneBatches: 1, totalBatches: 53 }), 260);
  assert.equal(estimateRemainingSeconds({ elapsedMs: 10_000, doneBatches: 2, totalBatches: 4 }), 10);
});

test('mapWithConcurrency preserves order and bounds in-flight work', async () => {
  const order = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const result = await mapWithConcurrency([0, 1, 2, 3, 4, 5, 6, 7], 3, async (n) => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((resolve) => setTimeout(resolve, n % 2 === 0 ? 10 : 1));
    inFlight--;
    order.push(n);
    return n * 10;
  });
  // Output order follows input order, not completion order.
  assert.deepEqual(result, [0, 10, 20, 30, 40, 50, 60, 70]);
  assert.ok(maxInFlight <= 3);
  assert.deepEqual(order.slice().sort((a, b) => a - b), [0, 1, 2, 3, 4, 5, 6, 7]); // every item ran once
});

test('normalizeParserResult accepts object and legacy bare-array shapes', () => {
  const buckets = [{ source: 'codex', model: 'm' }];
  assert.deepEqual(normalizeParserResult('codex', { buckets, sessions: [] }), {
    buckets, sessions: [], skipped: false, warnings: [],
  });
  assert.deepEqual(normalizeParserResult('codex', buckets), {
    buckets, sessions: [], skipped: false, warnings: [],
  });
});

test('normalizeParserResult rejects malformed results', () => {
  assert.throws(() => normalizeParserResult('codex', { buckets: 'nope', sessions: [] }), /invalid result/);
  assert.throws(() => normalizeParserResult('codex', { buckets: [], sessions: 'nope' }), /invalid result/);
  assert.throws(() => normalizeParserResult('codex', null), /invalid result/);
});

test('normalizeParserResult rejects sources that mismatch the registry key', () => {
  assert.throws(
    () => normalizeParserResult('cursor', {
      buckets: [{ source: 'codex', model: 'm' }],
      sessions: [],
    }),
    /emitted a bucket with source="codex"/,
  );
  assert.throws(
    () => normalizeParserResult('cursor', {
      buckets: [],
      sessions: [{ source: 'codex', sessionHash: 's' }],
    }),
    /emitted a session with source="codex"/,
  );
});

test('a successful batch is persisted before a later batch fails', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-sync-batches-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const received = [];
  let phase = 'first';
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const compressed = Buffer.concat(chunks);
          const body = req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(compressed)
            : compressed;
          const payload = JSON.parse(body.toString('utf8'));
          received.push({ phase, buckets: payload.buckets.length });
          const phaseRequestCount = received.filter(item => item.phase === phase).length;

          if (phase === 'first' && phaseRequestCount === 2) {
            res.writeHead(400, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ error: 'forced tail failure' }));
            return;
          }
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ingested: payload.buckets.length,
            sessions: payload.sessions?.length || 0,
          }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_sync_batch_test',
        apiUrl,
        hostname: 'sync-batch-test',
      }));
      const env = {
        ...process.env,
        HOME: homeDir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir,
      };
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['sync-batch-test'] = async () => ({
          buckets: Array.from({ length: 101 }, (_, index) => ({
            source: 'sync-batch-test',
            model: 'model-' + index,
            project: 'project',
            bucketStart: '2026-08-15T00:00:00.000Z',
            inputTokens: index + 1,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: index + 1,
          })),
          sessions: [],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;

      await assert.rejects(
        execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
          cwd: process.cwd(),
          env,
        }),
        error => /HTTP 400/.test(`${error.message}\n${error.stderr || ''}`),
      );
      const partialState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(partialState.buckets).length, 100);

      phase = 'retry';
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(),
        env,
      });
      const completeState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(completeState.buckets).length, 101);
    });

    assert.deepEqual(received, [
      { phase: 'first', buckets: 100 },
      { phase: 'first', buckets: 1 },
      { phase: 'retry', buckets: 1 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Re-binding the CLI to another account (init again, `config set apiKey`, or a
// desktop app rewriting config.json) used to be invisible to state.json: the
// incremental diff matched every bucket the *previous* account had uploaded and
// sent nothing, so the new account received no history while sync still printed
// success. The state must be scoped to its upload target.
test('a changed API key re-uploads the whole local history exactly once', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-rebind-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const received = [];
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const body = req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(Buffer.concat(chunks))
            : Buffer.concat(chunks);
          const payload = JSON.parse(body.toString('utf8'));
          received.push(payload.buckets.length);
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({
            ingested: payload.buckets.length,
            sessions: payload.sessions?.length || 0,
          }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      const writeKey = (apiKey) => writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey,
        apiUrl,
        hostname: 'rebind-test',
      }));
      const env = {
        ...process.env,
        HOME: homeDir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir,
      };
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['rebind-test'] = async () => ({
          buckets: Array.from({ length: 3 }, (_, index) => ({
            source: 'rebind-test',
            model: 'model-' + index,
            project: 'project',
            bucketStart: '2026-09-18T00:00:00.000Z',
            inputTokens: index + 1,
            outputTokens: 0,
            cachedInputTokens: 0,
            reasoningOutputTokens: 0,
            totalTokens: index + 1,
          })),
          sessions: [],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true });
      `;
      const sync = () => execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(), env,
      });

      // First account: full upload, state records the target.
      writeKey('vbu_account_a');
      const first = await sync();
      assert.doesNotMatch(first.stdout, /检测到上传账号已更换/);
      const firstState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(firstState.buckets).length, 3);
      assert.equal(firstState.identity.apiUrl, apiUrl);
      assert.equal(firstState.identity.keyFingerprint.length, 16);
      assert.equal(readFileSync(join(stateDir, 'state.json'), 'utf8').includes('vbu_account_a'), false);

      // Re-bind: the same local history must reach the new account in full.
      writeKey('vbu_account_b');
      const second = await sync();
      assert.match(second.stdout, /检测到上传账号已更换，本次全量重传本地历史/);
      const secondState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(secondState.buckets).length, 3);
      assert.notEqual(secondState.identity.keyFingerprint, firstState.identity.keyFingerprint);

      // Steady state on the new account: nothing left to send.
      const third = await sync();
      assert.doesNotMatch(third.stdout, /检测到上传账号已更换/);
      assert.match(third.stdout, /无新增数据。/);
    });

    // 3 buckets for the first account, 3 again for the second, none for the third run.
    assert.deepEqual(received, [3, 3]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Buckets AND sessions of a source the backend soft-drops must both stay
// uncommitted, so the first sync after the server registers that source
// re-sends them instead of losing them permanently.
test('dropped unknown sources leave bucket and session state uncommitted', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-dropped-source-'));
  const configDir = join(root, 'config');
  const stateDir = join(root, 'state');
  const homeDir = join(root, 'home');
  mkdirSync(configDir, { recursive: true });
  mkdirSync(homeDir, { recursive: true });

  const received = [];
  let dropUnknownSource = true;
  try {
    await withServer((req, res) => {
      if (req.method === 'GET' && req.url === '/api/usage/settings') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ uploadProject: true }));
        return;
      }
      if (req.method === 'POST' && req.url === '/api/usage/ingest') {
        const chunks = [];
        req.on('data', chunk => chunks.push(chunk));
        req.on('end', () => {
          const body = req.headers['content-encoding'] === 'gzip'
            ? gunzipSync(Buffer.concat(chunks))
            : Buffer.concat(chunks);
          const payload = JSON.parse(body.toString('utf8'));
          received.push({ buckets: payload.buckets.length, sessions: payload.sessions?.length || 0 });
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify(dropUnknownSource
            ? {
                ingested: 0,
                sessions: 0,
                dropped: {
                  buckets: payload.buckets.length,
                  unknownSources: ['devin'],
                },
              }
            : {
                ingested: payload.buckets.length,
                sessions: payload.sessions?.length || 0,
              }));
        });
        return;
      }
      res.writeHead(404).end();
    }, async apiUrl => {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify({
        apiKey: 'vbu_dropped_source_test',
        apiUrl,
        hostname: 'dropped-source-test',
      }));
      const env = {
        ...process.env,
        HOME: homeDir,
        VIBE_USAGE_DEV: '0',
        VIBE_USAGE_CONFIG_DIR: configDir,
        VIBE_USAGE_STATE_DIR: stateDir,
      };
      const command = `
        import { parsers } from './src/parsers/index.js';
        for (const source of Object.keys(parsers)) delete parsers[source];
        parsers['devin'] = async () => ({
          buckets: [{
            source: 'devin', model: 'swe-2-high', project: 'project',
            bucketStart: '2026-09-16T00:00:00.000Z',
            inputTokens: 1, outputTokens: 2,
            cachedInputTokens: 0, reasoningOutputTokens: 0, totalTokens: 3,
          }],
          sessions: [{
            source: 'devin', project: 'project', sessionHash: 'abc',
            firstMessageAt: '2026-09-16T00:00:00.000Z',
            lastMessageAt: '2026-09-16T00:10:00.000Z',
            durationSeconds: 600, activeSeconds: 100,
            messageCount: 4, userMessageCount: 1,
            userPromptHours: [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
          }],
        });
        const { runSync } = await import('./src/sync.js');
        await runSync({ throws: true, quiet: true });
      `;

      // First sync: the backend drops the unknown source — nothing is
      // committed (state.json may not even exist yet).
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(), env,
      });
      const droppedState = existsSync(join(stateDir, 'state.json'))
        ? JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'))
        : {};
      assert.equal(Object.keys(droppedState.buckets || {}).length, 0);
      assert.equal(Object.keys(droppedState.sessions || {}).length, 0);

      // After the backend learns the source, the next sync re-sends and commits.
      dropUnknownSource = false;
      await execFileAsync(process.execPath, ['--input-type=module', '-e', command], {
        cwd: process.cwd(), env,
      });
      const committedState = JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8'));
      assert.equal(Object.keys(committedState.buckets).length, 1);
      assert.equal(Object.keys(committedState.sessions).length, 1);
    });

    assert.deepEqual(received, [
      { buckets: 1, sessions: 1 },
      { buckets: 1, sessions: 1 },
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
