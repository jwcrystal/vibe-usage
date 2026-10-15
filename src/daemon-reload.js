// Self-reload guard for the background daemon.
//
// The daemon is installed as a supervised service whose unit points at this
// package's files, and Node holds those files in memory from startup. Nothing
// else tells the process that its own code changed, so an upgraded install
// (vendor sync, `git pull`, package update) keeps running the old code for as
// long as the service stays up — days, with `KeepAlive`/`RunAtLoad` units. A
// provider fix can therefore sit unused while the daemon keeps reporting the
// stale result on every interval, with no visible symptom that points at the
// version.
//
// We watch our own sources and, once they change, hand off to the supervisor
// by exiting: relaunching is already the supervisor's job (launchd
// `KeepAlive`, systemd `Restart=on-failure`), and re-execing here instead
// would start a second daemon next to the one the supervisor boots. Windows
// Task Scheduler carries no restart-on-failure policy, so there the exit is
// final and we do not take it (`supervisorRestartsAfterExit`).

import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// Only the shipped sources. The process loaded them, so any on-disk change
// means what it is running is no longer what is installed.
const WATCHED_DIRS = ['bin', 'src'];
const WATCHED_EXTENSION = '.js';

// A change has to stop moving for this long before we act. Vendoring or a
// checkout writes many files in sequence; exiting mid-write would have the
// relaunched process import a half-updated tree and die on the module that has
// not landed yet.
const SETTLE_MS = 5000;

// How often the sources are re-read while the daemon idles. Bounds how long a
// fresh install goes unnoticed to a minute rather than a whole sync interval.
export const RELOAD_POLL_MS = 60_000;

// EX_TEMPFAIL. Non-zero because systemd's Restart=on-failure is what relaunches
// us there; launchd's KeepAlive relaunches on any code.
export const RELOAD_EXIT_CODE = 75;

/**
 * Newest modification time across the daemon's own sources, in epoch
 * milliseconds, or `null` when nothing under them is readable.
 */
export function newestSourceMtime(rootDir) {
  let newest = null;
  const visit = dir => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return; // absent or unreadable: nothing here can be stale
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else if (entry.isFile() && entry.name.endsWith(WATCHED_EXTENSION)) {
        try {
          const { mtimeMs } = statSync(full);
          if (newest === null || mtimeMs > newest) newest = mtimeMs;
        } catch { /* raced with a writer: the next poll sees it */ }
      }
    }
  };
  for (const name of WATCHED_DIRS) visit(join(rootDir, name));
  return newest;
}

/**
 * Reports when the sources on disk have moved past `startedAt` and then
 * settled. `due()` latches: once it is true the caller can retry it freely
 * without the answer flipping back while it decides what to do.
 */
export function createReloadWatcher({
  rootDir,
  startedAt = Date.now(),
  settleMs = SETTLE_MS,
  pollMs = RELOAD_POLL_MS,
  now = Date.now,
  readNewest = newestSourceMtime,
} = {}) {
  let seen = null;
  let settledAt = null;
  let latched = false;
  return {
    pollMs,
    due() {
      if (latched) return true;
      const newest = readNewest(rootDir);
      // Never-reachable, or only files that were already older than startup:
      // this process is running what is installed.
      if (newest === null || newest <= startedAt) return false;
      const at = now();
      if (newest !== seen) {
        // Somebody is writing right now — restart the settle window.
        seen = newest;
        settledAt = at;
        return false;
      }
      if (at - settledAt < settleMs) return false;
      latched = true;
      return true;
    },
  };
}

/**
 * Whether exiting this process gets it relaunched by the installed service.
 * Windows' Task Scheduler XML has no restart-on-failure policy, so an exit
 * there is final until the next logon and must not be used as a hand-off.
 */
export function supervisorRestartsAfterExit(platform = process.platform) {
  return platform !== 'win32';
}
