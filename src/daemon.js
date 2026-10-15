import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './config.js';
import { runSync } from './sync.js';
import { failure, dim } from './output.js';
import {
  RELOAD_POLL_MS, RELOAD_EXIT_CODE, createReloadWatcher, supervisorRestartsAfterExit,
} from './daemon-reload.js';

const INTERVAL = 30 * 60_000; // 30 minutes

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function log(msg) {
  const ts = new Date().toLocaleTimeString('en-US', { hour12: false });
  process.stdout.write(dim(`[${ts}] ${msg}\n`));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// Sleeps the interval in reload-sized slices so an upgrade that lands while we
// idle is noticed within a poll cycle rather than after a whole sync interval.
// Returns true when `isDue` fired before the time was up.
async function idle(ms, isDue) {
  const deadline = Date.now() + ms;
  while (true) {
    if (isDue()) return true;
    const remaining = deadline - Date.now();
    if (remaining <= 0) return false;
    await sleep(Math.min(RELOAD_POLL_MS, remaining));
  }
}

export async function runDaemon({ codexExtraHome } = {}) {
  const config = loadConfig();
  if (!config?.apiKey) {
    console.error(failure('尚未配置，请先运行 `npx @vibe-cafe/vibe-usage`。'));
    process.exit(1);
  }

  log('daemon started (sync every 30m, Ctrl+C to stop)');

  // Code is loaded into memory at startup, so an upgrade written to disk does
  // not reach this process on its own — see daemon-reload.js. Exiting is the
  // hand-off, which only works where the installed service relaunches us.
  const canRelaunch = supervisorRestartsAfterExit();
  const reload = canRelaunch ? createReloadWatcher({ rootDir: PACKAGE_ROOT }) : null;
  const reloadDue = () => reload !== null && reload.due();
  const leaveForReload = () => {
    if (!reloadDue()) return;
    log('sources changed on disk; exiting so the service restarts with the new code.');
    process.exit(RELOAD_EXIT_CODE);
  };
  if (!canRelaunch) {
    log('note: the service here does not restart after an exit — restart it to pick up upgrades.');
  }

  // Why we don't exit on the first 401: launchd KeepAlive / systemd
  // Restart=on-failure relaunch in ~10s, which used to turn a single bad/
  // revoked key into ~360 ingest-401s per hour per machine. Sleeping a full
  // INTERVAL between auth retries collapses that storm to the daemon's normal
  // 30m cadence; only after MAX_AUTH_FAILURES consecutive 401s do we hand
  // off to the supervisor, which by then can't relaunch fast enough to matter.
  const MAX_AUTH_FAILURES = 5;
  let consecutiveAuthFailures = 0;

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      await runSync({ throws: true, quiet: true, surface: 'daemon', codexExtraHome });
      consecutiveAuthFailures = 0;
    } catch (err) {
      if (err.message === 'UNAUTHORIZED') {
        consecutiveAuthFailures++;
        if (consecutiveAuthFailures >= MAX_AUTH_FAILURES) {
          log(`API key invalid for ${MAX_AUTH_FAILURES} consecutive syncs, exiting.`);
          process.exit(1);
        }
        log(`API key invalid (attempt ${consecutiveAuthFailures}/${MAX_AUTH_FAILURES}), retrying in 30m.`);
      } else {
        log(`sync error: ${err.message}`);
      }
    }
    if (await idle(INTERVAL, reloadDue)) leaveForReload();
  }
}
