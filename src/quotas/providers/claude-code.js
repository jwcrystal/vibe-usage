import { execFile, spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, accessSync, constants } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { delimiter, join } from 'node:path';
import { quotaResult } from '../schema.js';

const PRODUCT_ID = 'claude-code';
const DEADLINE_MS = 25_000;
const TERM_GRACE_MS = 1_000;
const MAX_STDOUT_BYTES = 1024 * 1024;
const PROCESS_ARGUMENTS = [
  '--print', '--safe-mode', '--no-session-persistence', '--strict-mcp-config',
  '--mcp-config', '{"mcpServers":{}}', '--tools', '',
  '--output-format', 'stream-json', '--input-format', 'stream-json', '--verbose',
  '--settings', '{"env":{"CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC":""}}',
];
// The OAuth route is the preferred one: a single GET against the endpoint
// Claude Code's own login already authorises. It spawns nothing, writes nothing
// into ~/.claude, and cannot consume the window it reports. The CLI probe stays
// as the fallback for logins only the tool can reach.
const OAUTH_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';
const OAUTH_BETA = 'oauth-2025-04-20';
const OAUTH_TIMEOUT_MS = 10_000;
const KEYCHAIN_SERVICE = 'Claude Code-credentials';
const KEYCHAIN_TIMEOUT_MS = 2_000;
const WINDOW_DEFINITIONS = [
  ['five_hour', 'five-hour', '5h', 5 * 3600],
  ['seven_day', 'weekly', '7d', 7 * 86400],
  ['seven_day_opus', 'weekly-opus', '7d Opus', 7 * 86400],
  ['seven_day_sonnet', 'weekly-sonnet', '7d Sonnet', 7 * 86400],
];

function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function isoDate(value) {
  if (typeof value !== 'string' || !value) return undefined;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

function planLabel(value) {
  if (typeof value !== 'string') return undefined;
  const plans = { pro: 'Pro', max: 'Max', team: 'Team', enterprise: 'Enterprise', free: 'Free' };
  return plans[value.toLowerCase()];
}

// The fallback when a credential omits `subscriptionType`. The Max tiers carry
// a usage multiplier that the plain subscription type hides, so they are
// labelled explicitly (the same "Max 5x" / "Max 20x" shape CodexBar prints).
const RATE_LIMIT_TIERS = {
  default_claude_max_5x: 'Max 5x',
  default_claude_max_20x: 'Max 20x',
  default_claude_max: 'Max',
  default_claude_pro: 'Pro',
  default_claude_ai: 'Pro',
  default_claude_team: 'Team',
  default_claude_enterprise: 'Enterprise',
};

export function planLabelFromCredential(credential) {
  if (!record(credential)) return undefined;
  const fromSubscription = planLabel(credential.subscriptionType);
  if (fromSubscription) return fromSubscription;
  const tier = typeof credential.rateLimitTier === 'string'
    ? credential.rateLimitTier.trim().toLowerCase() : '';
  return RATE_LIMIT_TIERS[tier];
}

// Both routes report the same four windows; only the container differs (the CLI
// nests them under `rate_limits`, the OAuth payload does not). null means a
// window was present but malformed, which rejects the whole payload rather than
// publishing a half-read one.
function windowMeters(container, now) {
  const meters = [];
  for (const [key, id, label, windowSeconds] of WINDOW_DEFINITIONS) {
    const raw = container[key];
    if (raw === undefined || raw === null) continue;
    if (!record(raw)) return null;
    const utilization = number(raw.utilization);
    if (utilization === null || utilization < 0 || utilization > 100) return null;
    const resetsAt = isoDate(raw.resets_at);
    meters.push({ id, label, utilization,
      ...(resetsAt ? { resetsAt } : {}),
      ...(resetsAt && new Date(resetsAt) > now ? { windowSeconds } : {}),
    });
  }
  return meters;
}

function malformedExtraUsage(raw) {
  return raw !== undefined && raw !== null
    && (!record(raw) || typeof raw.is_enabled !== 'boolean');
}

// `scale` converts the payload's own money unit into the dollars the card
// renders: the CLI payload is already in dollars, the OAuth payload is in minor
// units.
function extraUsageMeter(raw, scale = 1) {
  if (!record(raw) || raw.is_enabled !== true) return null;
  const used = number(raw.used_credits);
  const limit = number(raw.monthly_limit);
  if (used === null || limit === null || limit <= 0) return null;
  const amountUsed = used / scale;
  const amountLimit = limit / scale;
  return { id: 'extra-usage', label: 'Extra',
    utilization: Math.max(0, Math.min(100, amountUsed / amountLimit * 100)),
    amountUsed, amountLimit };
}

export function parseClaudeUsage(payload, now = new Date()) {
  if (!record(payload)) return null;
  if (payload.rate_limits_available === false) {
    return quotaResult({ id: PRODUCT_ID, status: 'no_data', meters: [],
      emptyReason: 'sessionWithoutPlanLimits', planLabel: planLabel(payload.subscription_type),
      fetchedAt: now, dataAsOf: now });
  }
  if (!record(payload.rate_limits)) return null;
  const limits = payload.rate_limits;
  const meters = windowMeters(limits, now);
  if (!meters) return null;
  if (malformedExtraUsage(limits.extra_usage)) return null;
  const extra = extraUsageMeter(limits.extra_usage);
  if (extra) meters.push(extra);
  if (!meters.some(meter => meter.id === 'five-hour' || meter.id === 'weekly')) return null;
  return quotaResult({ id: PRODUCT_ID, status: 'ok', meters,
    planLabel: planLabel(payload.subscription_type), fetchedAt: now, dataAsOf: now });
}

// The OAuth payload carries the same windows at its top level and, unlike the
// CLI's answer, no subscription type at all: the plan can only come from the
// credential that authorised the read.
export function parseClaudeOAuthUsage(payload, { plan, now = new Date() } = {}) {
  if (!record(payload)) return null;
  const meters = windowMeters(payload, now);
  if (!meters) return null;
  const extraRaw = payload.extra_usage;
  if (malformedExtraUsage(extraRaw)) return null;
  if (extraRaw !== undefined && extraRaw !== null) {
    // Money here is minor units and the payload declares its own exponent
    // (`decimal_places`, 2 => cents). An undeclared unit is unknowable, and a
    // wrong dollar figure is worse than none, so such a block is dropped whole.
    const places = number(extraRaw.decimal_places);
    const extra = places === null ? null : extraUsageMeter(extraRaw, 10 ** places);
    if (extra) meters.push(extra);
  }
  if (!meters.some(meter => meter.id === 'five-hour' || meter.id === 'weekly')) {
    return quotaResult({ id: PRODUCT_ID, status: 'no_data', meters: [],
      emptyReason: 'noWindow', planLabel: plan, fetchedAt: now, dataAsOf: now });
  }
  return quotaResult({ id: PRODUCT_ID, status: 'ok', meters,
    planLabel: plan, fetchedAt: now, dataAsOf: now });
}

function systemUserName() {
  try {
    return userInfo().username || undefined;
  } catch {
    return undefined;
  }
}

function childEnvironment(environment = process.env) {
  const result = { ...environment };
  for (const key of [
    'CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT',
    'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION', 'CLAUDE_PID',
  ]) delete result[key];
  const path = result.PATH || '';
  const extra = ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin'];
  result.PATH = [...new Set([...path.split(delimiter).filter(Boolean), ...extra])].join(delimiter);
  // Measured: with USER unset, the probe answers `rate_limits_available: false`
  // for an account that has plan limits, so a stripped service environment
  // reports "no plan limits" instead of the quota. Supply the name rather than
  // propagate the gap.
  if (!result.USER) result.USER = systemUserName();
  return result;
}

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

// Node CLIs installed by a version manager live under that manager's own tree,
// never in a system prefix, and a GUI app or launchd daemon starts with a
// minimal PATH. Probing PATH alone therefore reported "Claude Code CLI is not
// installed" on a machine where the tool sat in ~/.nvm or ~/.local/share/mise.
// Shims first (they resolve the active version), then each installed version.
function versionManagerCandidates(home) {
  const paths = [
    join(home, '.local', 'share', 'mise', 'shims', 'claude'),
    join(home, '.volta', 'bin', 'claude'),
    join(home, '.asdf', 'shims', 'claude'),
    join(home, '.bun', 'bin', 'claude'),
    join(home, '.local', 'share', 'fnm', 'aliases', 'default', 'bin', 'claude'),
  ];
  for (const root of [
    join(home, '.nvm', 'versions', 'node'),
    join(home, '.local', 'share', 'mise', 'installs', 'node'),
  ]) {
    let versions;
    try { versions = readdirSync(root); } catch { continue; }
    for (const version of versions.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))) {
      paths.push(join(root, version, 'bin', 'claude'));
    }
  }
  return paths;
}

export function findClaudeBinary({ environment = process.env, home = homedir() } = {}) {
  const explicit = environment.VIBE_USAGE_CLAUDE_BIN?.trim();
  const candidates = [
    explicit,
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    ...((environment.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'claude'))),
    ...versionManagerCandidates(home),
    // The two standard install prefixes, spelled out: neither is on a launchd
    // daemon's PATH.
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ].filter(Boolean);
  const installed = candidates.find(path => existsSync(path) && executable(path));
  if (installed) return installed;

  const desktopVersions = join(home, 'Library', 'Application Support', 'Claude', 'claude-code');
  try {
    const versions = readdirSync(desktopVersions)
      .filter(version => /^\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(version))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const version of versions) {
      const path = join(desktopVersions, version, 'claude.app', 'Contents', 'MacOS', 'claude');
      if (existsSync(path) && executable(path)) return path;
    }
  } catch { /* Desktop is an optional final fallback */ }
  return null;
}

function sendControl(child, id, subtype) {
  child.stdin.write(`${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype } })}\n`);
}

function killProcess(child, signal) {
  if (!child.pid) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, signal); return; } catch { /* use direct child */ }
  }
  try { child.kill(signal); } catch { /* process already exited */ }
}

function requestUsage(binary, {
  environment = process.env,
  spawnImpl = spawn,
  deadlineMs = DEADLINE_MS,
  termGraceMs = TERM_GRACE_MS,
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(binary, PROCESS_ARGUMENTS, {
        cwd: homedir(), env: childEnvironment(environment),
        stdio: ['pipe', 'pipe', 'ignore'], detached: process.platform !== 'win32',
      });
    } catch {
      reject(new Error('Claude Code quota probe failed'));
      return;
    }
    let settled = false;
    let stopping = false;
    let requestedUsage = false;
    let payload;
    let stdoutBytes = 0;
    let buffer = '';
    let killTimer;
    const deadline = setTimeout(() => stop('Claude Code quota probe timed out'), deadlineMs);
    const cleanup = () => {
      clearTimeout(deadline);
      clearTimeout(killTimer);
      child.stdout?.removeAllListeners('data');
    };
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (error) reject(error); else resolve(result);
    };
    const stop = message => {
      if (settled || stopping) return;
      stopping = true;
      killProcess(child, 'SIGTERM');
      killTimer = setTimeout(() => {
        killProcess(child, 'SIGKILL');
        finish(new Error(message));
      }, termGraceMs);
    };
    const parseLine = line => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (message?.type !== 'control_response' || !record(message.response)) return;
      const response = message.response;
      if (response.request_id === 'vibe-init' && !requestedUsage) {
        requestedUsage = true;
        try { sendControl(child, 'vibe-usage', 'get_usage'); }
        catch { stop('Claude Code quota probe failed'); }
      } else if (response.request_id === 'vibe-usage') {
        if (response.subtype !== 'success' || !record(response.response)) {
          stop('Claude Code quota probe returned no data');
          return;
        }
        payload = response.response;
        child.stdin.end();
      }
    };
    child.on('error', () => finish(new Error('Claude Code quota probe failed')));
    // A binary that exits before reading stdin makes the pending write fail
    // with EPIPE; without this listener the stream's 'error' event would be
    // unhandled and crash the CLI. The close handler reports the failure.
    child.stdin.on('error', () => {});
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        stop('Claude Code quota response exceeded the output limit');
        return;
      }
      buffer += chunk.toString('utf8');
      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        parseLine(line);
      }
    });
    child.on('close', code => {
      if (payload && code === 0) finish(null, payload);
      else finish(new Error('Claude Code quota probe failed'));
    });
    try { sendControl(child, 'vibe-init', 'initialize'); }
    catch { stop('Claude Code quota probe failed'); }
  });
}

// --- OAuth route (preferred) ----------------------------------------------
// Everything here is read-only. Claude Code owns the refresh token; writing a
// rotated one back into its credential store is how a usage reader logs the
// user out, so this provider never refreshes, never rewrites, and never deletes
// a credential. An expired login is reported as such, and running Claude Code
// once — or the CLI probe below — is what refreshes it.

function credentialPath({ environment = process.env, home = homedir() } = {}) {
  const configured = environment.CLAUDE_CONFIG_DIR?.trim();
  const dir = configured ? configured.replace(/^~(?=$|[\\/])/, home) : join(home, '.claude');
  return join(dir, '.credentials.json');
}

function credentialRecord(text) {
  try {
    const parsed = JSON.parse(text);
    return record(parsed?.claudeAiOauth) ? parsed.claudeAiOauth : null;
  } catch {
    return null;
  }
}

function readKeychainCredential() {
  // macOS keeps the login in the Keychain and `security` is the only reader a
  // zero-dependency CLI has. Claude Code recreates that item and can drop the
  // ACL entry that let another binary read it, in which case macOS raises a GUI
  // prompt — fatal for a background sync. The timeout bounds that: a prompt or a
  // locked Keychain ends as "no credential here" and the CLI probe takes over.
  if (process.platform !== 'darwin') return Promise.resolve(null);
  return new Promise(resolve => {
    execFile('/usr/bin/security',
      ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'],
      { timeout: KEYCHAIN_TIMEOUT_MS, maxBuffer: 64 * 1024, encoding: 'utf8' },
      (error, stdout) => { resolve(error ? null : credentialRecord(stdout)); });
  });
}

export function claudeCredentialsPresent({ environment = process.env, home = homedir() } = {}) {
  if (environment.VIBE_USAGE_CLAUDE_OAUTH_TOKEN?.trim()) return true;
  return existsSync(credentialPath({ environment, home }));
}

export async function readClaudeCredentials({
  environment = process.env,
  home = homedir(),
  readKeychain = readKeychainCredential,
} = {}) {
  const override = environment.VIBE_USAGE_CLAUDE_OAUTH_TOKEN?.trim();
  if (override) return { accessToken: override };
  try {
    const fromFile = credentialRecord(readFileSync(credentialPath({ environment, home }), 'utf8'));
    if (fromFile) return fromFile;
  } catch { /* no credential file: the Keychain is the macOS home for it */ }
  return (await readKeychain()) || null;
}

async function fetchClaudeOAuthQuota({ environment, home, now, fetchImpl, readKeychain }) {
  const credential = await readClaudeCredentials({ environment, home, readKeychain });
  // No local login to read: nothing here can speak for the account, so the CLI
  // probe answers instead (it also covers API-key and cloud-provider logins).
  if (!credential) return null;
  const plan = planLabelFromCredential(credential);
  const token = typeof credential.accessToken === 'string' ? credential.accessToken.trim() : '';
  if (!token) {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials', meters: [],
      planLabel: plan, fetchedAt: now, dataAsOf: now });
  }
  const expiresAt = number(credential.expiresAt);
  if (expiresAt !== null && expiresAt <= now.getTime()) {
    return quotaResult({ id: PRODUCT_ID, status: 'expired_credentials', meters: [],
      planLabel: plan, fetchedAt: now, dataAsOf: now });
  }
  try {
    const response = await fetchImpl(OAUTH_USAGE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        'anthropic-beta': OAUTH_BETA,
        Accept: 'application/json',
      },
      signal: AbortSignal.timeout(OAUTH_TIMEOUT_MS),
    });
    if (response.status === 401 || response.status === 403) {
      return quotaResult({ id: PRODUCT_ID, status: 'unauthorized', meters: [],
        planLabel: plan, fetchedAt: now, dataAsOf: now });
    }
    if (!response.ok) {
      return quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
        message: `Claude usage request failed (${response.status})`, fetchedAt: now });
    }
    const result = parseClaudeOAuthUsage(await response.json(), { plan, now });
    if (result) return result;
    return quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
      message: 'Claude usage response was not understood', fetchedAt: now });
  } catch {
    // Network faults, timeouts and unreadable bodies are transient: the caller
    // keeps the last captured snapshot instead of blanking the card.
    return quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
      message: 'Claude usage request failed', fetchedAt: now });
  }
}

async function fetchClaudeCliQuota({
  environment, home, now, spawnImpl, deadlineMs, termGraceMs,
}) {
  const binary = findClaudeBinary({ environment, home });
  if (!binary) {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials',
      message: 'Claude Code CLI is not installed', fetchedAt: now });
  }
  try {
    const payload = await requestUsage(binary, { environment, spawnImpl, deadlineMs, termGraceMs });
    const result = parseClaudeUsage(payload, now);
    if (result) return result;
    if (payload.rate_limits_available === false) {
      return quotaResult({ id: PRODUCT_ID, status: 'no_data', meters: [],
        emptyReason: 'sessionWithoutPlanLimits', fetchedAt: now, dataAsOf: now });
    }
  } catch { /* do not expose subprocess output or errors */ }
  return quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
    message: 'Claude Code quota probe failed or returned an unknown response', fetchedAt: now });
}

export async function fetchClaudeCodeQuota({
  environment = process.env,
  home = homedir(),
  now = new Date(),
  spawnImpl = spawn,
  deadlineMs = DEADLINE_MS,
  termGraceMs = TERM_GRACE_MS,
  fetchImpl = globalThis.fetch,
  readKeychain = readKeychainCredential,
} = {}) {
  const oauth = await fetchClaudeOAuthQuota({ environment, home, now, fetchImpl, readKeychain });
  if (oauth?.status === 'ok') return oauth;

  const clim = await fetchClaudeCliQuota({ environment, home, now, spawnImpl, deadlineMs, termGraceMs });
  if (clim.status === 'ok') return clim;

  // Neither route produced windows. When OAuth had a login to read, its verdict
  // is the actionable one — it is the answer that speaks for the account (an
  // expired or rejected login, or a window-less plan); a transient OAuth
  // failure is also the honest answer, and the caller serves its cached
  // snapshot for it. Without a local login, the CLI's answer is all we have.
  return oauth || clim;
}
