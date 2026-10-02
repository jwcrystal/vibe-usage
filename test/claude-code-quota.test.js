import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fetchClaudeCodeQuota, parseClaudeUsage } from '../src/quotas/providers/claude-code.js';

function fakeClaude(root, script) {
  const binary = join(root, 'claude');
  writeFileSync(binary, `#!/usr/bin/env node\n${script}\n`);
  chmodSync(binary, 0o700);
  return binary;
}

const successProtocol = `
let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString();
  while (input.includes('\\n')) {
    const end = input.indexOf('\\n');
    const line = input.slice(0, end); input = input.slice(end + 1);
    const request = JSON.parse(line);
    const requestId = request.request_id;
    const response = requestId === 'vibe-init'
      ? { request_id: requestId, subtype: 'success', response: {} }
      : { request_id: requestId, subtype: 'success', response: {
          rate_limits_available: true, subscription_type: 'max',
          rate_limits: {
            five_hour: { utilization: 34.5, resets_at: '2026-10-03T00:00:00Z' },
            seven_day: { utilization: 18, resets_at: '2026-10-07T00:00:00Z' },
            seven_day_opus: { utilization: 8, resets_at: '2026-10-07T00:00:00Z' }
          }
        } };
    process.stdout.write(JSON.stringify({ type: 'control_response', response }) + '\\n');
  }
});`;

test('Claude quota parser emits only allowlisted plan meters', () => {
  const result = parseClaudeUsage({
    subscription_type: 'max',
    account_email: 'private@example.invalid',
    rate_limits: {
      five_hour: { utilization: 20, resets_at: '2026-10-03T00:00:00Z' },
      seven_day: { utilization: 30, resets_at: '2026-10-07T00:00:00Z' },
      seven_day_opus: { utilization: 12 },
    },
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.planLabel, 'Max');
  assert.deepEqual(result.meters.map(meter => meter.id), ['five-hour', 'weekly', 'weekly-opus']);
  assert.equal(JSON.stringify(result).includes('private@example.invalid'), false);
  assert.equal(parseClaudeUsage({ rate_limits_available: false }).emptyReason, 'sessionWithoutPlanLimits');
  assert.equal(parseClaudeUsage({ rate_limits: null }), null);
  assert.equal(parseClaudeUsage({ rate_limits: { five_hour: { utilization: '20' } } }), null);
});

test('Claude quota probe uses inert stdio protocol and discards nonessential output', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-quota-'));
  try {
    const binary = fakeClaude(root, successProtocol);
    const result = await fetchClaudeCodeQuota({
      environment: { ...process.env, VIBE_USAGE_CLAUDE_BIN: binary,
        CLAUDECODE: 'nested-session', CLAUDE_CODE_SESSION_ID: 'private-session' },
    });
    assert.equal(result.status, 'ok');
    assert.equal(result.planLabel, 'Max');
    assert.deepEqual(result.meters.map(meter => meter.id), ['five-hour', 'weekly', 'weekly-opus']);
    assert.equal(JSON.stringify(result).includes('private-session'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude quota probe kills a child that ignores SIGTERM and returns a generic error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-quota-timeout-'));
  try {
    const binary = fakeClaude(root, `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);`);
    const started = Date.now();
    const result = await fetchClaudeCodeQuota({
      environment: { ...process.env, VIBE_USAGE_CLAUDE_BIN: binary },
      deadlineMs: 40,
      termGraceMs: 60,
    });
    assert.equal(result.status, 'retryable_error');
    assert.ok(Date.now() - started < 2_000);
    assert.doesNotMatch(JSON.stringify(result), /SIGTERM|timeout-quota/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
