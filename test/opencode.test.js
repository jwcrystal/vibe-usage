import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { findActiveDatabase, resolveProject } from '../src/parsers/opencode.js';

test('OpenCode parser selects the most recently modified opencode database', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-opencode-test-'));
  const stale = join(root, 'opencode.db');
  const active = join(root, 'opencode-feature-branch.db');
  try {
    writeFileSync(stale, 'stale');
    writeFileSync(active, 'active');
    writeFileSync(join(root, 'other.db'), 'ignore');
    writeFileSync(join(root, 'opencode.db-wal'), 'ignore');
    mkdirSync(join(root, 'opencode-directory.db'));
    utimesSync(stale, new Date('2026-08-31T08:15:00Z'), new Date('2026-08-31T08:15:00Z'));
    utimesSync(active, new Date('2026-09-03T07:34:00Z'), new Date('2026-09-03T07:34:00Z'));

    assert.equal(findActiveDatabase(root), active);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('OpenCode parser reports no database when no matching database exists', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-opencode-test-'));
  try {
    writeFileSync(join(root, 'other.db'), 'ignore');
    assert.equal(findActiveDatabase(root), undefined);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('resolveProject uses path.root basename when present', () => {
  assert.equal(resolveProject('/Users/me/proj-a', '/Users/me/proj-a/src'), 'proj-a');
});

test('resolveProject falls back to path.cwd when root is null', () => {
  assert.equal(resolveProject(null, '/Users/me/proj-b'), 'proj-b');
});

test('resolveProject falls back to path.cwd when root is "/"', () => {
  assert.equal(resolveProject('/', '/Users/me/proj-c'), 'proj-c');
});

test('resolveProject returns unknown when both root and cwd are missing', () => {
  assert.equal(resolveProject(null, null), 'unknown');
  assert.equal(resolveProject('', undefined), 'unknown');
  assert.equal(resolveProject('/', '/'), 'unknown');
});
