import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { discoverQuotaProducts, fetchQuotaProducts } from '../src/quotas/registry.js';
import { quotaResult } from '../src/quotas/schema.js';
import {
  commandcodeAuthPath,
  fetchCommandcodeQuota,
  projectCommandcodeQuota,
  readCommandcodeCredential,
} from '../src/quotas/providers/commandcode.js';

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function textResponse(body, status = 200) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain' } });
}

// Mirrors the shape of the real ~/.commandcode/auth.json (verified against a
// live store): a top-level apiKey plus identity fields and a nested `codex`
// OAuth entry that belongs to Command Code's Codex passthrough and must never
// be read by the quota path.
const authFixture = {
  apiKey: 'cc-fixture-key',
  userId: 'user-identity-uuid',
  userName: 'Identity Name',
  keyName: 'fixture-key-name',
  authenticatedAt: '2026-09-01T00:00:00Z',
  codex: {
    type: 'bearer',
    access: 'codex-access-must-not-appear',
    refresh: 'codex-refresh-must-not-appear',
    expires: 1_800_000_000,
  },
};

// Strict endpoint shapes (mirroring command-code's own /usage overlay, as the
// community adapter parses them), each carrying hostile extras that a generic
// recursive walk would have projected.
const whoamiPayload = {
  success: true,
  user: { id: 'user-identity-uuid', name: 'Identity Name', email: 'identity@example.test' },
  org: { id: 'org_12345', name: 'Identity Org' },
  // The old generic-walk shape: an arbitrary `limits` array must never produce
  // a meter again.
  limits: [{ id: 'leak-id', name: 'Identity Name', type: '5H', usedPercent: 99 }],
};

const subscriptionsPayload = {
  success: true,
  data: {
    id: 'sub-must-not-appear',
    status: 'active',
    planId: 'individual-max',
    planName: 'Identity Plan Name',
    currentPeriodStart: '2026-10-01',
    currentPeriodEnd: '2026-11-01',
  },
};

const creditsPayload = {
  success: true,
  windowLimits: {
    limited: true,
    fiveHour: { used: 42, cap: 100, exceeded: false, resetAt: '2026-10-02T15:00:00Z',
      id: 'leak-id', name: 'Identity Name' },
    weekly: { used: 30, cap: 100, exceeded: false, resetAt: '2026-10-05T00:00:00Z' },
    other: { used: 90, cap: 100, name: 'Identity Name' },
  },
  credits: { monthlyCredits: 60, purchasedCredits: 12, name: 'Identity Name' },
};

const usagePayload = {
  success: true,
  totalCount: 7020,
  totalMonthlyCredits: 40,
  summary: [{ name: 'Identity Name', ratio: 0.9, usedPercent: 99 }],
};

function makeAuthHome(prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  mkdirSync(join(root, '.commandcode'), { recursive: true });
  writeFileSync(join(root, '.commandcode', 'auth.json'), JSON.stringify(authFixture));
  return root;
}

function recordingFetch(handler) {
  const calls = [];
  const fetchImpl = async (url, request) => {
    calls.push({ url: String(url), method: request.method, headers: { ...request.headers } });
    const reply = handler(String(url));
    if (!reply) throw new Error(`unexpected request: ${url}`);
    return reply;
  };
  return { calls, fetchImpl };
}

test('quota discovery requires the Command Code auth file and never reads it', () => {
  const absentRoot = mkdtempSync(join(tmpdir(), 'vibe-usage-commandcode-absent-'));
  try {
    const absent = discoverQuotaProducts({ environment: {}, home: absentRoot, platform: 'linux' })
      .products.find(product => product.id === 'commandcode');
    assert.deepEqual(absent, { id: 'commandcode', detected: false, fetchable: true });
  } finally {
    rmSync(absentRoot, { recursive: true, force: true });
  }

  const bareRoot = mkdtempSync(join(tmpdir(), 'vibe-usage-commandcode-baredir-'));
  try {
    // A bare ~/.commandcode directory is not a presence signal.
    mkdirSync(join(bareRoot, '.commandcode'));
    const bare = discoverQuotaProducts({ environment: {}, home: bareRoot, platform: 'linux' })
      .products.find(product => product.id === 'commandcode');
    assert.deepEqual(bare, { id: 'commandcode', detected: false, fetchable: true });
  } finally {
    rmSync(bareRoot, { recursive: true, force: true });
  }

  const authRoot = mkdtempSync(join(tmpdir(), 'vibe-usage-commandcode-authfile-'));
  try {
    mkdirSync(join(authRoot, '.commandcode'));
    const authPath = join(authRoot, '.commandcode', 'auth.json');
    // Content that is not even JSON: detection must not parse it, let alone
    // open it.
    writeFileSync(authPath, '{not-json content must never be read');
    const present = discoverQuotaProducts({ environment: {}, home: authRoot, platform: 'linux' })
      .products.find(product => product.id === 'commandcode');
    assert.deepEqual(present, { id: 'commandcode', detected: true, fetchable: true });

    if (process.platform !== 'win32') {
      // Unreadable content: only path presence may be consulted.
      chmodSync(authPath, 0o000);
      const unreadable = discoverQuotaProducts({ environment: {}, home: authRoot, platform: 'linux' })
        .products.find(product => product.id === 'commandcode');
      assert.deepEqual(unreadable, { id: 'commandcode', detected: true, fetchable: true });
    }
  } finally {
    rmSync(authRoot, { recursive: true, force: true });
  }
});

test('Command Code fetch reads only apiKey, calls the four documented endpoints, projects strict meters', async () => {
  const root = makeAuthHome('vibe-usage-commandcode-fetch-');
  const { calls, fetchImpl } = recordingFetch(url => {
    if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
    if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
    if (url.includes('/alpha/billing/credits')) return jsonResponse(creditsPayload);
    if (url.includes('/alpha/usage/summary')) return jsonResponse(usagePayload);
    return null;
  });
  try {
    const result = await fetchCommandcodeQuota({
      home: root,
      fetchImpl,
      now: new Date('2026-10-02T10:00:00Z'),
    });

    assert.deepEqual(calls.map(call => call.url), [
      'https://api.commandcode.ai/alpha/whoami?limits=1',
      'https://api.commandcode.ai/alpha/billing/subscriptions?orgId=org_12345',
      'https://api.commandcode.ai/alpha/billing/credits?orgId=org_12345',
      'https://api.commandcode.ai/alpha/usage/summary?orgId=org_12345&since=2026-10-01',
    ]);
    for (const call of calls) {
      assert.equal(call.method, 'GET');
      assert.deepEqual(call.headers, {
        Authorization: 'Bearer cc-fixture-key',
        Accept: 'application/json',
      });
    }

    assert.equal(result.status, 'ok');
    assert.equal(result.planLabel, 'Max 10×');
    assert.equal(result.fetchedAt, '2026-10-02T10:00:00.000Z');
    assert.equal(result.dataAsOf, '2026-10-02T10:00:00.000Z');
    assert.deepEqual(result.meters, [
      { id: 'five-hour', label: '5h', utilization: 42,
        windowSeconds: 18_000, resetsAt: '2026-10-02T15:00:00.000Z',
        amountUsed: 42, amountLimit: 100 },
      { id: 'weekly', label: '7d', utilization: 30,
        windowSeconds: 604_800, resetsAt: '2026-10-05T00:00:00.000Z',
        amountUsed: 30, amountLimit: 100 },
      // Monthly: the catalog grant (individual-max = $150) is the cap; the
      // credits response states $60 remaining → $90 spent.
      { id: 'monthly', label: 'Month', utilization: 60,
        resetsAt: '2026-11-01T00:00:00.000Z', amountUsed: 90, amountLimit: 150 },
    ]);

    // No key material, identity, org, or subscription ids reach the result,
    // and no raw response text (planName, hostile `other` window) is echoed.
    const serialized = JSON.stringify(result);
    for (const secret of ['cc-fixture-key', 'codex-access-must-not-appear',
      'codex-refresh-must-not-appear', 'user-identity-uuid', 'Identity Name',
      'identity@example.test', 'org_12345', 'sub-must-not-appear', 'fixture-key-name',
      'Identity Org', 'leak-id', 'Identity Plan Name']) {
      assert.equal(serialized.includes(secret), false, secret);
    }
    assert.equal(result.cacheScope, undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('missing or unusable credentials return missing_credentials with zero requests', async () => {
  let requests = 0;
  const fetchImpl = async () => {
    requests += 1;
    return jsonResponse(whoamiPayload);
  };

  const absentHome = mkdtempSync(join(tmpdir(), 'vibe-usage-commandcode-noauth-'));
  const cases = [];
  try {
    const absent = await fetchCommandcodeQuota({ home: absentHome, fetchImpl });
    cases.push(absent);

    const malformed = makeAuthHome('vibe-usage-commandcode-badjson-');
    try {
      writeFileSync(join(malformed, '.commandcode', 'auth.json'), '{not-json');
      cases.push(await fetchCommandcodeQuota({ home: malformed, fetchImpl }));
    } finally {
      rmSync(malformed, { recursive: true, force: true });
    }

    const empty = makeAuthHome('vibe-usage-commandcode-emptykey-');
    try {
      writeFileSync(join(empty, '.commandcode', 'auth.json'),
        JSON.stringify({ ...authFixture, apiKey: '' }));
      cases.push(await fetchCommandcodeQuota({ home: empty, fetchImpl }));
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }

    const nonString = makeAuthHome('vibe-usage-commandcode-nonstring-');
    try {
      writeFileSync(join(nonString, '.commandcode', 'auth.json'),
        JSON.stringify({ ...authFixture, apiKey: 42 }));
      cases.push(await fetchCommandcodeQuota({ home: nonString, fetchImpl }));
    } finally {
      rmSync(nonString, { recursive: true, force: true });
    }

    const wrongShape = makeAuthHome('vibe-usage-commandcode-array-');
    try {
      writeFileSync(join(wrongShape, '.commandcode', 'auth.json'),
        JSON.stringify(['not', 'an', 'object']));
      cases.push(await fetchCommandcodeQuota({ home: wrongShape, fetchImpl }));
    } finally {
      rmSync(wrongShape, { recursive: true, force: true });
    }
  } finally {
    rmSync(absentHome, { recursive: true, force: true });
  }

  assert.equal(requests, 0);
  assert.equal(cases.length, 5);
  for (const result of cases) {
    assert.equal(result.status, 'missing_credentials');
    assert.equal(result.meters.length, 0);
  }
  assert.equal(commandcodeAuthPath(absentHome),
    join(absentHome, '.commandcode', 'auth.json'));
  assert.equal(readCommandcodeCredential('/nonexistent/commandcode/auth.json'), null);
});

test('401 maps to unauthorized; 403 never does and never exposes the body', async t => {
  await t.test('whoami 401 rejects without further requests', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-401-');
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse({}, 401));
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'unauthorized');
      assert.equal(calls.length, 1);
      assert.equal(JSON.stringify(result).includes('cc-fixture-key'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('subscriptions 401 after whoami accepts', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-sub-401-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      return jsonResponse({}, 401);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'unauthorized');
      assert.equal(calls.length, 2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('whoami 403 stays an explicit retryable failure', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-403-');
    const { calls, fetchImpl } = recordingFetch(() => jsonResponse(
      { error: 'top-secret-response-body' }, 403));
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API returned HTTP 403');
      assert.equal(result.emptyReason, undefined);
      assert.equal(calls.length, 1);
      assert.equal(JSON.stringify(result).includes('top-secret-response-body'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('credits 403 after whoami and subscriptions accept', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-credits-403-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
      return jsonResponse({}, 403);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API returned HTTP 403');
      assert.equal(calls.length, 3);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('malformed responses map to retryable_error and degraded legs are skipped', async t => {
  await t.test('whoami body is not JSON', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-malformed-');
    const { calls, fetchImpl } = recordingFetch(() => textResponse('not-json{'));
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API response was malformed');
      assert.equal(calls.length, 1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('whoami body is JSON null', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-null-');
    const { fetchImpl } = recordingFetch(() => jsonResponse(null));
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API response was malformed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a malformed subscriptions leg drops only the plan and the since pin', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-sub-malformed-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return textResponse('<html>');
      if (url.includes('/alpha/billing/credits')) return jsonResponse(creditsPayload);
      return jsonResponse(usagePayload);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.planLabel, undefined);
      // No currentPeriodStart was recovered, so usage/summary carries no since.
      assert.equal(calls[3].url,
        'https://api.commandcode.ai/alpha/usage/summary?orgId=org_12345');
      assert.deepEqual(result.meters.map(meter => meter.label), ['5h', '7d', 'Month']);
      // Without the subscription period end the monthly meter states no reset.
      assert.equal(result.meters[2].resetsAt, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('transport failures map to retryable_error with a timeout distinction', async t => {
  await t.test('timeout', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-timeout-');
    const timeout = new Error('timed out');
    timeout.name = 'TimeoutError';
    try {
      const result = await fetchCommandcodeQuota({
        home: root,
        fetchImpl: async () => { throw timeout; },
        now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code quota request timed out');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('other transport error', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-offline-');
    try {
      const result = await fetchCommandcodeQuota({
        home: root,
        fetchImpl: async () => { throw new TypeError('fetch failed'); },
        now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code quota request failed');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('Command Code results never touch the quota cache', async () => {
  const root = makeAuthHome('vibe-usage-commandcode-nocache-');
  const cacheRoot = join(root, 'cache');
  const environment = { VIBE_USAGE_QUOTA_CACHE_DIR: cacheRoot };
  const { fetchImpl } = recordingFetch(url => {
    if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
    if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
    if (url.includes('/alpha/billing/credits')) return jsonResponse(creditsPayload);
    return jsonResponse(usagePayload);
  });
  try {
    const live = await fetchQuotaProducts(['commandcode'], {
      home: root,
      environment,
      fetchImpl,
      now: new Date('2026-10-02T10:00:00Z'),
    });
    assert.equal(live.products[0].status, 'ok');
    assert.equal(live.products[0].cacheScope, undefined);
    assert.equal(existsSync(cacheRoot), false);

    const offline = await fetchQuotaProducts(['commandcode'], {
      home: root,
      environment,
      fetchImpl: async () => { throw new Error('offline'); },
      now: new Date('2026-10-02T10:05:00Z'),
    });
    // No cache fallback: the provider opted out, so the error stands.
    assert.equal(offline.products[0].status, 'retryable_error');
    assert.equal(offline.products[0].source, 'live');
    assert.equal(existsSync(cacheRoot), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('projection reads only the documented paths and emits generated identities', () => {
  const { meters, planLabel } = projectCommandcodeQuota({
    whoami: {
      success: true,
      user: { id: 'user-identity-uuid', name: 'Identity Name', email: 'identity@example.test' },
      org: { id: 'org_12345', name: 'Identity Org' },
      // The pre-review recursive-walk bait: arbitrary limits/metadata records
      // with percentages, ratios and identity must all stay unread.
      limits: [{ id: 'leak-id', name: 'Identity Name', type: '5H', usedPercent: 99,
        resetAt: '2026-10-02T15:00:00Z' }],
      metadata: { ratio: 0.9, tokensUsed: 10, dollarLimit: 100 },
    },
    subscriptions: { data: { id: 'sub-must-not-appear', status: 'canceled',
      planId: 'individual-max', planName: 'Identity Plan Name' } },
    credits: {
      windowLimits: {
        limited: true,
        // used without a cap: dropped, never paired with anything else.
        fiveHour: { used: 1, name: 'Identity Name', id: 'leak-id' },
        // The only positively identified rolling window: 1 / 4 = 25%.
        weekly: { used: 1, cap: 4, ratio: 0.5, resetAt: 0 },
        // Unknown window key: never read.
        other: { used: 90, cap: 100, usedPercent: 90, name: 'Identity Name' },
      },
      credits: { monthlyCredits: 1, purchasedCredits: 99, name: 'Identity Name' },
    },
    usage: {
      success: true,
      totalMonthlyCredits: 1,
      summary: [{ name: 'Identity Name', ratio: 0.9, usedPercent: 99 }],
      totalTokens: 123,
    },
  });

  // Canceled subscription: no plan label (never resurrected).
  assert.equal(planLabel, undefined);
  assert.deepEqual(meters, [
    { id: 'weekly', label: '7d', utilization: 25, windowSeconds: 604_800,
      amountUsed: 1, amountLimit: 4 },
    { id: 'monthly', label: 'Month', utilization: 50, amountUsed: 1, amountLimit: 2 },
  ]);
  const serialized = JSON.stringify({ meters, planLabel });
  for (const secret of ['Identity Name', 'identity@example.test', 'org_12345',
    'leak-id', 'Identity Org', 'Identity Plan Name', 'user-identity-uuid']) {
    assert.equal(serialized.includes(secret), false, secret);
  }
});

test('meter dollar amounts travel paired and stay non-negative over a positive cap', () => {
  assert.throws(() => quotaResult({ id: 'commandcode', status: 'ok',
    meters: [{ id: 'monthly', label: 'Month', utilization: 1, amountUsed: -1, amountLimit: 2 }] }));
  assert.throws(() => quotaResult({ id: 'commandcode', status: 'ok',
    meters: [{ id: 'monthly', label: 'Month', utilization: 1, amountUsed: 1, amountLimit: 0 }] }));
  assert.throws(() => quotaResult({ id: 'commandcode', status: 'ok',
    meters: [{ id: 'monthly', label: 'Month', utilization: 1, amountUsed: 1 }] }));
  const ok = quotaResult({ id: 'commandcode', status: 'ok',
    meters: [{ id: 'monthly', label: 'Month', utilization: 1, amountUsed: 0, amountLimit: 70 }] });
  assert.equal(ok.meters[0].amountUsed, 0);
  assert.equal(ok.meters[0].amountLimit, 70);
});

test('monthly cap prefers monthlyCreditsGranted, then the plan catalog, then the spent sum', () => {
  const usage = { success: true, totalMonthlyCredits: 40 };
  const monthlyOf = (sources) => projectCommandcodeQuota(sources)
    .meters.find((meter) => meter.id === 'monthly');

  // The credits response's grant field wins over everything.
  const granted = monthlyOf({
    subscriptions: { success: true, data: { status: 'active', planId: 'individual-goat' } },
    credits: { credits: { monthlyCredits: 20, monthlyCreditsGranted: 70 } },
    usage,
  });
  assert.equal(granted.amountLimit, 70);
  assert.equal(granted.amountUsed, 50);

  // Otherwise the plan catalog's published allowance is the cap.
  const catalog = monthlyOf({
    subscriptions: { success: true, data: { status: 'active', planId: 'individual-goat' } },
    credits: { credits: { monthlyCredits: 20 } },
    usage,
  });
  assert.equal(catalog.amountLimit, 70);
  assert.equal(catalog.amountUsed, 50);

  // Unknown plan: the remaining+spent sum is the last resort.
  const unknown = monthlyOf({
    credits: { credits: { monthlyCredits: 20 } },
    usage,
  });
  assert.equal(unknown.amountLimit, 60);
  assert.equal(unknown.amountUsed, 40);

  // A canceled subscription never gets a catalog cap.
  const canceled = monthlyOf({
    subscriptions: { success: true, data: { status: 'canceled', planId: 'individual-goat' } },
    credits: { credits: { monthlyCredits: 20 } },
    usage,
  });
  assert.equal(canceled.amountLimit, 60);
});

test('plan labels come from the allowlisted planId vocabulary only', () => {
  const cases = [
    ['individual-go', 'Go'],
    ['go', 'Go'],
    ['individual-pro', 'Pro (legacy)'],
    ['individual-pro-v1', 'Pro'],
    ['individual-max', 'Max 10×'],
    ['individual-ultra', 'Max 20×'],
    ['teams-pro', 'Team Pro'],
    ['individual-provider', 'Provider'],
    ['COMMAND-UNKNOWN-SKU', undefined],
    ['', undefined],
  ];
  for (const [planId, expected] of cases) {
    const { planLabel } = projectCommandcodeQuota({
      subscriptions: { success: true, data: { status: 'active', planId } },
    });
    assert.equal(planLabel, expected, planId);
  }

  // Non-plan-bearing statuses never name a plan, whatever the planId says.
  for (const status of ['canceled', 'unpaid', 'paused']) {
    const { planLabel } = projectCommandcodeQuota({
      subscriptions: { data: { status, planId: 'individual-max' } },
    });
    assert.equal(planLabel, undefined, status);
  }
});

test('unknown or incomplete endpoint data stays no_data — never guessed', () => {
  // limited:false is the documented pay-as-you-go answer.
  const payg = projectCommandcodeQuota({
    subscriptions: { success: true, data: { status: 'active', planId: 'individual-go' } },
    credits: { windowLimits: { limited: false,
      fiveHour: { used: 5, cap: 5 }, weekly: { used: 5, cap: 5 } }, credits: {} },
    usage: {},
  });
  assert.deepEqual(payg, { meters: [], planLabel: 'Go' });

  // A single-sided monthly pool is not a pool.
  assert.deepEqual(projectCommandcodeQuota({
    credits: { credits: { monthlyCredits: 60 } },
    usage: { totalMonthlyCredits: undefined },
  }).meters, []);
  assert.deepEqual(projectCommandcodeQuota({
    credits: { credits: { monthlyCredits: -1 } },
    usage: { totalMonthlyCredits: 1 },
  }).meters, []);

  // Malformed numbers (strings, zero caps, negatives) drop the window.
  assert.deepEqual(projectCommandcodeQuota({
    credits: { windowLimits: { limited: true,
      fiveHour: { used: '10', cap: 100 },
      weekly: { used: 10, cap: 0 } } },
  }).meters, []);

  // success:false legs are rejections, not data.
  assert.deepEqual(projectCommandcodeQuota({
    subscriptions: { success: false, data: { status: 'active', planId: 'individual-max' } },
    credits: { success: false, windowLimits: { limited: true,
      fiveHour: { used: 1, cap: 4 } }, credits: { monthlyCredits: 1 } },
    usage: { success: false, totalMonthlyCredits: 1 },
  }), { meters: [], planLabel: undefined });

  // The pre-review shapes with bare ratios / mismatched-unit pairs stay empty.
  assert.deepEqual(projectCommandcodeQuota({
    whoami: { limits: [{ type: '5H', usedPercent: 42 }, { usedRatio: 0.3 }] },
    usage: { metadata: { ratio: 0.9 }, tokensUsed: 5, dollarLimit: 10 },
  }).meters, []);
});

test('orgId and since are optional and unknown payloads stay no_data', async () => {
  const root = makeAuthHome('vibe-usage-commandcode-noorg-');
  const { calls, fetchImpl } = recordingFetch(url => {
    if (url.includes('/alpha/whoami')) return jsonResponse({ success: true, user: { id: 'user-identity-uuid' } });
    if (url.includes('/alpha/billing/subscriptions')) {
      return jsonResponse({ success: true, data: { status: 'active', planId: 'individual-go' } });
    }
    if (url.includes('/alpha/billing/credits')) return jsonResponse({ success: true, credits: {} });
    return jsonResponse({ success: true, summary: [] });
  });
  try {
    const result = await fetchCommandcodeQuota({
      home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
    });
    assert.equal(result.status, 'no_data');
    assert.equal(result.planLabel, 'Go');
    assert.deepEqual(result.meters, []);
    assert.deepEqual(calls.map(call => call.url), [
      'https://api.commandcode.ai/alpha/whoami?limits=1',
      'https://api.commandcode.ai/alpha/billing/subscriptions',
      'https://api.commandcode.ai/alpha/billing/credits',
      'https://api.commandcode.ai/alpha/usage/summary',
    ]);
    assert.equal(JSON.stringify(result).includes('user-identity-uuid'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected whoami answer never scopes the other requests', async () => {
  const root = makeAuthHome('vibe-usage-commandcode-whoami-rejected-');
  const { calls, fetchImpl } = recordingFetch(url => {
    if (url.includes('/alpha/whoami')) {
      return jsonResponse({ success: false, org: { id: 'org-must-not-scope' },
        user: { id: 'user-identity-uuid' } });
    }
    if (url.includes('/alpha/billing/subscriptions')) {
      return jsonResponse({ success: true, data: { status: 'active', planId: 'individual-go' } });
    }
    if (url.includes('/alpha/billing/credits')) return jsonResponse({ success: true, credits: {} });
    return jsonResponse({ success: true, summary: [] });
  });
  try {
    const result = await fetchCommandcodeQuota({
      home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
    });
    assert.equal(result.status, 'no_data');
    assert.deepEqual(calls.map(call => call.url), [
      'https://api.commandcode.ai/alpha/whoami?limits=1',
      'https://api.commandcode.ai/alpha/billing/subscriptions',
      'https://api.commandcode.ai/alpha/billing/credits',
      'https://api.commandcode.ai/alpha/usage/summary',
    ]);
    assert.equal(JSON.stringify(result).includes('org-must-not-scope'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Failure-isolation regression matrix (third attempt, 2026-10-02):
// subscriptions, credits, and summary fail independently; a valid meter
// survives a later failure (partial `ok`); zero meters with any leg failure is
// retryable_error, never no_data; failed/missing subscription context never
// invents a plan label or a renewal timestamp; no response body, error text,
// or credential reaches a result.

function timeoutError() {
  const error = new Error('commandcode fixture timed out');
  error.name = 'TimeoutError';
  return error;
}

test('billing legs fail independently: valid meters survive, failures fail closed', async t => {
  await t.test('subscriptions timeout: later legs still run, meters survive without plan or renewal', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-partial-timeout-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) throw timeoutError();
      if (url.includes('/alpha/billing/credits')) return jsonResponse(creditsPayload);
      return jsonResponse(usagePayload);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.planLabel, undefined);
      assert.deepEqual(result.meters.map(meter => meter.id),
        ['five-hour', 'weekly', 'monthly']);
      // No subscription period end: the monthly meter states no renewal.
      assert.equal(result.meters[2].resetsAt, undefined);
      // The failed leg did not abort the chain, and without a period start
      // the summary request carries no `since` pin.
      assert.equal(calls.length, 4);
      assert.equal(calls[3].url,
        'https://api.commandcode.ai/alpha/usage/summary?orgId=org_12345');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('credits transport error: summary still runs, no monthly meter is invented, result is body-free', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-partial-transport-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
      if (url.includes('/alpha/billing/credits')) {
        throw new TypeError('credits fetch failed for cc-fixture-key');
      }
      return jsonResponse(usagePayload);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code quota request failed');
      assert.equal(result.planLabel, undefined);
      // Remaining is missing, so the summary spend alone cannot form a pool.
      assert.deepEqual(result.meters, []);
      assert.equal(calls.length, 4);
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes('cc-fixture-key'), false);
      assert.equal(serialized.includes('credits fetch failed'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('credits HTTP 500 with valid summary data: retryable, no response body leaks', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-partial-500-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
      if (url.includes('/alpha/billing/credits')) {
        return jsonResponse({ error: 'credits-debug-body-must-not-appear' }, 500);
      }
      return jsonResponse(usagePayload);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API returned HTTP 500');
      assert.deepEqual(result.meters, []);
      assert.equal(calls.length, 4);
      assert.equal(JSON.stringify(result).includes('credits-debug-body-must-not-appear'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('malformed credits body with no surviving meters is retryable, not no_data', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-partial-malformed-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
      if (url.includes('/alpha/billing/credits')) {
        return textResponse('<html>malformed-body-must-not-appear</html>');
      }
      return jsonResponse(usagePayload);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API response was malformed');
      assert.deepEqual(result.meters, []);
      assert.equal(calls.length, 4);
      assert.equal(JSON.stringify(result).includes('malformed-body-must-not-appear'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a timeout on a leg with no meters keeps the timeout message', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-partial-empty-timeout-');
    const { fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse({ success: true });
      if (url.includes('/alpha/billing/credits')) throw timeoutError();
      return jsonResponse({ success: true });
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code quota request timed out');
      assert.deepEqual(result.meters, []);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('summary failure after good credits keeps the rolling meters (partial ok)', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-partial-summary-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
      if (url.includes('/alpha/billing/credits')) return jsonResponse(creditsPayload);
      return jsonResponse({ error: 'summary-debug-body-must-not-appear' }, 503);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.planLabel, 'Max 10×');
      // The missing summary spend no longer drops the monthly pool: the plan
      // catalog grants the cap ($150 for individual-max) and the credits
      // response the remainder.
      assert.deepEqual(result.meters.map(meter => meter.id), ['five-hour', 'weekly', 'monthly']);
      const monthly = result.meters.find((meter) => meter.id === 'monthly');
      assert.equal(monthly.amountLimit, 150);
      assert.equal(monthly.amountUsed, 90);
      assert.equal(calls.length, 4);
      assert.equal(JSON.stringify(result).includes('summary-debug-body-must-not-appear'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('failed credits with valid summary spend never invents a monthly meter', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-failed-credits-');
    const { fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
      if (url.includes('/alpha/billing/credits')) return jsonResponse({}, 502);
      return jsonResponse(usagePayload);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API returned HTTP 502');
      assert.deepEqual(result.meters, []);
      assert.equal(result.planLabel, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a rejected success:false leg fails closed with a body-free message', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-rejected-leg-');
    const { fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) {
        return jsonResponse({ success: true, data: { status: 'active', planId: 'individual-go' } });
      }
      if (url.includes('/alpha/billing/credits')) {
        // A rejection is not an answer: its payload must not supply meters
        // (here a monthly pool would otherwise be formable) or leak identity.
        return jsonResponse({ success: false, reason: 'Identity Name must not appear',
          credits: { monthlyCredits: 99 } });
      }
      return jsonResponse({ success: true, totalMonthlyCredits: 1 });
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API returned an unsuccessful response');
      assert.deepEqual(result.meters, []);
      assert.equal(JSON.stringify(result).includes('Identity Name'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('a rejected subscriptions answer neither scopes the summary nor names a plan', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-rejected-subscriptions-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) {
        return jsonResponse({ success: false, data: { status: 'active',
          planId: 'individual-max', currentPeriodStart: '2026-10-01',
          currentPeriodEnd: '2026-11-01' } });
      }
      if (url.includes('/alpha/billing/credits')) return jsonResponse(creditsPayload);
      return jsonResponse(usagePayload);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'ok');
      assert.equal(result.planLabel, undefined);
      assert.deepEqual(result.meters.map(meter => meter.id),
        ['five-hour', 'weekly', 'monthly']);
      assert.equal(result.meters[2].resetsAt, undefined);
      // The rejected period start did not become a `since` pin.
      assert.equal(calls[3].url,
        'https://api.commandcode.ai/alpha/usage/summary?orgId=org_12345');
      const serialized = JSON.stringify(result);
      assert.equal(serialized.includes('individual-max'), false);
      assert.equal(serialized.includes('2026-11-01'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('healthy but empty answers stay no_data', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-healthy-empty-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse({ success: true });
      if (url.includes('/alpha/billing/subscriptions')) {
        return jsonResponse({ success: true, data: { status: 'active', planId: 'individual-go' } });
      }
      if (url.includes('/alpha/billing/credits')) return jsonResponse({ success: true });
      return jsonResponse({ success: true });
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'no_data');
      assert.equal(result.planLabel, 'Go');
      assert.deepEqual(result.meters, []);
      assert.equal(calls.length, 4);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test('terminal auth responses end the chain even after other legs produced data', async t => {
  await t.test('summary 401 after good credits is unauthorized and carries no meters', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-late-401-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
      if (url.includes('/alpha/billing/credits')) return jsonResponse(creditsPayload);
      return jsonResponse({ error: 'late-401-body-must-not-appear' }, 401);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'unauthorized');
      assert.deepEqual(result.meters, []);
      assert.equal(calls.length, 4);
      assert.equal(JSON.stringify(result).includes('late-401-body-must-not-appear'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test('summary 403 is retryable and carries no response body', async () => {
    const root = makeAuthHome('vibe-usage-commandcode-late-403-');
    const { calls, fetchImpl } = recordingFetch(url => {
      if (url.includes('/alpha/whoami')) return jsonResponse(whoamiPayload);
      if (url.includes('/alpha/billing/subscriptions')) return jsonResponse(subscriptionsPayload);
      if (url.includes('/alpha/billing/credits')) return jsonResponse(creditsPayload);
      return jsonResponse({ error: 'late-403-body-must-not-appear' }, 403);
    });
    try {
      const result = await fetchCommandcodeQuota({
        home: root, fetchImpl, now: new Date('2026-10-02T10:00:00Z'),
      });
      assert.equal(result.status, 'retryable_error');
      assert.equal(result.message, 'Command Code API returned HTTP 403');
      assert.deepEqual(result.meters, []);
      assert.equal(calls.length, 4);
      assert.equal(JSON.stringify(result).includes('late-403-body-must-not-appear'), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
