import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchCodexQuota, parseCodexUsage } from '../src/quotas/providers/codex.js';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'vibe-codex-quota-'));
  const codex = join(root, '.codex');
  mkdirSync(codex);
  const authPath = join(codex, 'auth.json');
  const setAuth = (token, accountId) => writeFileSync(authPath, JSON.stringify({
    tokens: { access_token: token, account_id: accountId },
  }));
  setAuth('fixture-token-one', 'account-one');
  return { root, codex, authPath, setAuth, environment: { ...process.env, CODEX_HOME: codex } };
}

const response = () => ({
  rate_limit: {
    primary_window: { used_percent: 42, limit_window_seconds: 18_000,
      reset_after_seconds: 3_600 },
    secondary_window: { used_percent: 18.5, limit_window_seconds: 604_800,
      reset_at: 1_800_000_000 },
  },
  rate_limit_reset_credits: { available_count: 4 },
  plan_type: 'plus',
  account_id: 'must-never-project-this-identity',
});

test('Codex quota parser recognizes only documented window shapes', () => {
  const now = new Date('2026-01-01T00:00:00Z');
  const parsed = parseCodexUsage(response(), now);
  assert.equal(parsed.id, 'codex');
  assert.equal(parsed.status, 'ok');
  assert.equal(parsed.planLabel, 'Plus');
  assert.equal(parsed.resetCredits, 4);
  assert.deepEqual(parsed.meters.map(({ id, label, utilization, windowSeconds }) => (
    { id, label, utilization, windowSeconds }
  )), [
    { id: 'five-hour', label: '5h', utilization: 42, windowSeconds: 18_000 },
    { id: 'weekly', label: '7d', utilization: 18.5, windowSeconds: 604_800 },
  ]);
  assert.equal(JSON.stringify(parsed).includes('must-never-project-this-identity'), false);
  assert.equal(parseCodexUsage({}), null);
  assert.equal(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 12 } } }), null);
});

test('explicit null Codex rate_limit is authoritative no_data', () => {
  const parsed = parseCodexUsage({ rate_limit: null, plan_type: 'free' });
  assert.equal(parsed.status, 'no_data');
  assert.equal(parsed.emptyReason, 'noWindow');
  assert.deepEqual(parsed.meters, []);
});

test('Codex reset credits are kept only when a positive integer', () => {
  const base = { rate_limit: null, plan_type: 'free' };
  assert.equal(parseCodexUsage(base).resetCredits, undefined);
  assert.equal(parseCodexUsage({ ...base, rate_limit_reset_credits: { available_count: '4' } }).resetCredits, undefined);
  assert.equal(parseCodexUsage({ ...base, rate_limit_reset_credits: { available_count: 0 } }).resetCredits, undefined);
  assert.equal(parseCodexUsage({ ...base, rate_limit_reset_credits: { available_count: 2.5 } }).resetCredits, undefined);
  assert.equal(parseCodexUsage({ ...base, rate_limit_reset_credits: { available_count: 3 } }).resetCredits, 3);
});

test('Codex quota reads auth only for request, retries changed auth once, and never projects it', async () => {
  const f = fixture();
  try {
    let calls = 0;
    const result = await fetchCodexQuota({ environment: f.environment, fetchImpl: async (_url, options) => {
      calls += 1;
      if (calls === 1) {
        assert.equal(options.headers.authorization, 'Bearer fixture-token-one');
        f.setAuth('fixture-token-two', 'account-two');
        return new Response('', { status: 401 });
      }
      assert.equal(options.headers.authorization, 'Bearer fixture-token-two');
      assert.equal(options.headers['ChatGPT-Account-Id'], 'account-two');
      return new Response(JSON.stringify(response()), { status: 200 });
    } });
    assert.equal(calls, 2);
    assert.equal(result.status, 'ok');
    assert.equal(JSON.stringify(result).includes('fixture-token'), false);
    assert.equal(JSON.stringify(result).includes('account-two'), false);
    assert.equal(JSON.stringify(result).includes('cacheScope'), false);
    assert.match(readFileSync(f.authPath, 'utf8'), /fixture-token-two/);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});

test('Codex 401 does not expose response bodies or tokens', async () => {
  const f = fixture();
  try {
    const result = await fetchCodexQuota({ environment: f.environment, fetchImpl: async () => (
      new Response('secret-response-body', { status: 401 })
    ) });
    assert.equal(result.status, 'unauthorized');
    assert.equal(JSON.stringify(result).includes('secret-response-body'), false);
    assert.equal(JSON.stringify(result).includes('fixture-token-one'), false);
  } finally {
    rmSync(f.root, { recursive: true, force: true });
  }
});
