import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { encodeIngestBody, fetchAccount, fetchSettings, retryDelayMs } from '../src/api.js';

async function withServer(handler, run) {
  const server = createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  const url = `http://127.0.0.1:${address.port}`;
  try {
    return await run(url);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
}

test('ingest encodes client metadata in the gzipped JSON body', () => {
  const client = {
    collectorVersion: '0.10.2',
    surface: 'windows-app',
    surfaceVersion: '0.5.10',
    syncId: '00000000-0000-4000-8000-000000000000',
    batchIndex: 0,
    batchCount: 1,
  };

  const { body, useGzip } = encodeIngestBody([{ source: 'codex' }], { client });
  const received = JSON.parse(gunzipSync(body).toString('utf-8'));

  assert.equal(useGzip, true);
  assert.deepEqual(received.client, client);
  assert.deepEqual(received.buckets, [{ source: 'codex' }]);
});

test('ingest includes optional quota snapshots without affecting legacy payloads', () => {
  const quota = {
    id: 'codex', status: 'ok', meters: [{ id: 'five-hour', label: '5h', utilization: 41 }],
    fetchedAt: '2026-10-01T00:00:00.000Z', dataAsOf: '2026-10-01T00:00:00.000Z',
  };
  const decode = encoded => (encoded.useGzip ? gunzipSync(encoded.body) : encoded.body).toString('utf8');
  const encoded = encodeIngestBody([], { quotas: [quota] });
  assert.deepEqual(JSON.parse(decode(encoded)), { buckets: [], quotas: [quota] });

  const legacy = encodeIngestBody([], {});
  assert.deepEqual(JSON.parse(decode(legacy)), { buckets: [] });
});

test('retry delay uses equal jitter instead of synchronized fixed boundaries', () => {
  assert.equal(retryDelayMs(0, () => 0), 500);
  assert.equal(retryDelayMs(0, () => 1), 1000);
  assert.equal(retryDelayMs(1, () => 0), 1000);
  assert.equal(retryDelayMs(1, () => 1), 2000);
});

test('fetchSettings retries transient failures and preserves explicit false', async () => {
  let requests = 0;
  const delays = [];
  await withServer((_req, res) => {
    requests++;
    if (requests < 3) {
      res.writeHead(500).end('temporary');
    } else {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ uploadProject: false }));
    }
  }, async url => {
    const result = await fetchSettings(url, 'vbu_test', {
      sleep: async ms => { delays.push(ms); },
      random: () => 0,
    });
    assert.deepEqual(result, { uploadProject: false });
  });
  assert.equal(requests, 3);
  assert.deepEqual(delays, [500, 1000]);
});

test('fetchSettings returns null only after transient retries are exhausted', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    res.writeHead(500).end('temporary');
  }, async url => {
    const result = await fetchSettings(url, 'vbu_test', {
      sleep: async () => {},
      random: () => 0,
    });
    assert.equal(result, null);
  });
  assert.equal(requests, 3);
});

test('fetchSettings does not retry an invalid API key', async () => {
  let requests = 0;
  await withServer((_req, res) => {
    requests++;
    res.writeHead(401).end('nope');
  }, async url => {
    await assert.rejects(
      fetchSettings(url, 'vbu_bad', { sleep: async () => {} }),
      /UNAUTHORIZED/,
    );
  });
  assert.equal(requests, 1);
});

test('fetchAccount names the account a key is bound to', async () => {
  let seenPath = null;
  const account = await withServer((req, res) => {
    seenPath = req.url;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ account: { handle: 'milky2018', name: '布丁大魔王' }, buckets: [] }));
  }, url => fetchAccount(url, 'vbu_test'));

  assert.deepEqual(account, { handle: 'milky2018', name: '布丁大魔王' });
  // Cheapest shape of the call: one day, aggregate only.
  assert.equal(seenPath, '/api/usage?days=1&bucketsOnly=true');
});

test('fetchAccount stays null against an older backend or a transient failure', async () => {
  const missingField = await withServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ buckets: [] }));
  }, url => fetchAccount(url, 'vbu_test'));
  assert.equal(missingField, null);

  const serverError = await withServer((_req, res) => {
    res.writeHead(500).end('boom');
  }, url => fetchAccount(url, 'vbu_test'));
  assert.equal(serverError, null);
});

test('fetchAccount still surfaces an invalid key', async () => {
  await withServer((_req, res) => {
    res.writeHead(401).end('nope');
  }, async url => {
    await assert.rejects(() => fetchAccount(url, 'vbu_bad'), /UNAUTHORIZED/);
  });
});
