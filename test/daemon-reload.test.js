import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  RELOAD_EXIT_CODE, createReloadWatcher, newestSourceMtime, supervisorRestartsAfterExit,
} from '../src/daemon-reload.js';

function withTree(files, run) {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-reload-'));
  try {
    for (const [rel, seconds] of Object.entries(files)) {
      const full = join(root, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, '// fixture\n');
      utimesSync(full, seconds, seconds);
    }
    return run(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('newestSourceMtime takes the newest watched source and ignores everything else', () => {
  withTree({
    'bin/vibe-usage.js': 1_000,
    'src/daemon.js': 2_000,
    'src/nested/deep.js': 3_000,
    // Not shipped sources: a change to either must not look like a code change.
    'src/notes.txt': 9_000,
    'package.json': 9_000,
    'test/some.test.js': 9_000,
  }, root => {
    assert.equal(newestSourceMtime(root), 3_000 * 1000);
  });
});

test('newestSourceMtime is null when the watched directories are absent', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-usage-reload-empty-'));
  try {
    assert.equal(newestSourceMtime(root), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('createReloadWatcher stays quiet while the sources predate startup', () => {
  const watcher = createReloadWatcher({
    rootDir: '/unused',
    startedAt: 10_000,
    now: () => 999_999,
    readNewest: () => 9_999,
  });
  assert.equal(watcher.due(), false);
  assert.equal(watcher.due(), false);
});

test('createReloadWatcher is unmoved by sources it cannot read', () => {
  const watcher = createReloadWatcher({
    rootDir: '/unused',
    startedAt: 10_000,
    now: () => 999_999,
    readNewest: () => null,
  });
  assert.equal(watcher.due(), false);
});

test('createReloadWatcher waits for the change to settle, then latches', () => {
  let newest = 20_000;
  let clock = 100_000;
  const watcher = createReloadWatcher({
    rootDir: '/unused',
    startedAt: 10_000,
    settleMs: 5_000,
    now: () => clock,
    readNewest: () => newest,
  });

  // First sighting only starts the settle window: a half-written tree must not
  // trigger the exit.
  assert.equal(watcher.due(), false);
  clock += 4_999;
  assert.equal(watcher.due(), false);
  clock += 1;
  assert.equal(watcher.due(), true);
  // Latched, so a caller that retries cannot be talked out of the decision.
  assert.equal(watcher.due(), true);
});

test('createReloadWatcher restarts the settle window while the tree keeps changing', () => {
  let newest = 20_000;
  let clock = 100_000;
  const watcher = createReloadWatcher({
    rootDir: '/unused',
    startedAt: 10_000,
    settleMs: 5_000,
    now: () => clock,
    readNewest: () => newest,
  });

  assert.equal(watcher.due(), false);
  clock += 4_000;
  assert.equal(watcher.due(), false, 'still inside the first settle window');

  // A second file lands mid-settle (a vendor sync writes many in sequence).
  newest = 20_001;
  assert.equal(watcher.due(), false);
  clock += 4_999;
  assert.equal(watcher.due(), false);
  clock += 1;
  assert.equal(watcher.due(), true);
});

test('the reload exit is non-zero, because systemd only relaunches on failure', () => {
  assert.notEqual(RELOAD_EXIT_CODE, 0);
});

test('only platforms whose service relaunches after an exit may use it', () => {
  assert.equal(supervisorRestartsAfterExit('darwin'), true); // launchd KeepAlive
  assert.equal(supervisorRestartsAfterExit('linux'), true); // systemd Restart=on-failure
  assert.equal(supervisorRestartsAfterExit('win32'), false); // Task Scheduler has none
});
