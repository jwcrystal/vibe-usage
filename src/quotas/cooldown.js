import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

// A 429 names the wait, and honouring it is what keeps a background reader from
// turning a short pause into a longer block. The pause outlives one process on
// purpose: the daemon and a one-shot `quota fetch` share it, so neither undoes
// the other's back-off by starting fresh.
const VERSION = 1;
export const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

function cooldownPath({ environment = process.env, home = homedir() } = {}) {
  const root = environment.VIBE_USAGE_QUOTA_CACHE_DIR?.trim() || join(home, '.vibe-usage');
  return join(root, 'quota-cooldown.json');
}

// The key is the provider plus a hash of the credential: a pause belongs to one
// login, and a raw token has no business in a file.
export function cooldownKey(id, secret) {
  return `${id}:${createHash('sha256').update(String(secret)).digest('hex')}`;
}

function load(path, now) {
  let parsed;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); } catch { return {}; }
  if (!parsed || typeof parsed !== 'object' || parsed.version !== VERSION
    || !parsed.entries || typeof parsed.entries !== 'object') return {};
  const entries = {};
  for (const [key, value] of Object.entries(parsed.entries)) {
    // An expired pause is dropped on the way in: it must not keep the route
    // switched off after the provider has forgiven the caller.
    if (typeof value === 'number' && Number.isFinite(value) && value > now.getTime()) {
      entries[key] = value;
    }
  }
  return entries;
}

function save(path, entries) {
  try {
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.tmp`;
    writeFileSync(tmp, JSON.stringify({ version: VERSION, entries }, null, 2) + '\n',
      { encoding: 'utf8', mode: 0o600 });
    renameSync(tmp, path);
  } catch { /* a pause that cannot be written must not fail the quota read */ }
}

export function blockedUntil(key, options = {}) {
  const now = options.now || new Date();
  const until = load(cooldownPath(options), now)[key];
  return typeof until === 'number' ? new Date(until) : null;
}

export function recordRateLimit(key, retryAfter, options = {}) {
  const now = options.now || new Date();
  const path = cooldownPath(options);
  const entries = load(path, now);
  const candidate = retryAfter instanceof Date && retryAfter.getTime() > now.getTime()
    ? retryAfter.getTime()
    : now.getTime() + DEFAULT_COOLDOWN_MS;
  // A shorter answer than the one already stored must not shorten the pause.
  entries[key] = Math.max(entries[key] || 0, candidate);
  save(path, entries);
}

export function recordSuccess(key, options = {}) {
  const now = options.now || new Date();
  const path = cooldownPath(options);
  const entries = load(path, now);
  if (!(key in entries)) return;
  delete entries[key];
  save(path, entries);
}
