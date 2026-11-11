import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_COOLDOWN_MS, blockedUntil, cooldownKey, recordRateLimit, recordSuccess,
} from '../src/quotas/cooldown.js';

function isolated() {
  const home = mkdtempSync(join(tmpdir(), 'vibe-cooldown-'));
  return { options: { environment: {}, home }, home };
}

test('a rate limit pauses one credential and nothing else', () => {
  const { options, home } = isolated();
  try {
    const now = new Date('2026-11-11T00:00:00Z');
    const key = cooldownKey('claude-code', 'first-token');
    assert.equal(blockedUntil(key, { ...options, now }), null);

    // The provider named its wait; the file carries the pause, not the token.
    recordRateLimit(key, new Date('2026-11-11T00:02:00Z'), { ...options, now });
    assert.equal(blockedUntil(key, { ...options, now }).toISOString(),
      '2026-11-11T00:02:00.000Z');
    assert.equal(blockedUntil(key, {
      ...options, now: new Date('2026-11-11T00:03:00Z'),
    }), null);
    assert.equal(blockedUntil(cooldownKey('claude-code', 'second-token'), { ...options, now }), null);
    const stored = readFileSync(join(home, '.vibe-usage', 'quota-cooldown.json'), 'utf8');
    assert.equal(stored.includes('first-token'), false);

    // A second answer cannot shorten the wait already stored, only extend it.
    recordRateLimit(key, new Date('2026-11-11T00:01:00Z'), { ...options, now });
    assert.equal(blockedUntil(key, { ...options, now }).toISOString(),
      '2026-11-11T00:02:00.000Z');
    recordRateLimit(key, null, { ...options, now });
    assert.equal(blockedUntil(key, { ...options, now }).toISOString(),
      new Date(now.getTime() + DEFAULT_COOLDOWN_MS).toISOString());

    // A successful read is the provider forgiving the caller.
    recordSuccess(key, { ...options, now });
    assert.equal(blockedUntil(key, { ...options, now }), null);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a cooldown file that cannot be read or written never fails the read', () => {
  const home = join(tmpdir(), 'vibe-cooldown-missing', 'nested');
  const options = { environment: {}, home };
  const key = cooldownKey('claude-code', 'token');
  assert.equal(blockedUntil(key, options), null);
  recordSuccess(key, options);
  assert.equal(blockedUntil(key, options), null);
});
