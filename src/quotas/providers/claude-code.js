import { spawn } from 'node:child_process';
import { existsSync, readdirSync, accessSync, constants } from 'node:fs';
import { homedir } from 'node:os';
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

export function parseClaudeUsage(payload, now = new Date()) {
  if (!record(payload)) return null;
  if (payload.rate_limits_available === false) {
    return quotaResult({ id: PRODUCT_ID, status: 'no_data', meters: [],
      emptyReason: 'sessionWithoutPlanLimits', planLabel: planLabel(payload.subscription_type),
      fetchedAt: now, dataAsOf: now });
  }
  if (!record(payload.rate_limits)) return null;
  const limits = payload.rate_limits;
  const meters = [];
  const definitions = [
    ['five_hour', 'five-hour', '5h', 5 * 3600],
    ['seven_day', 'weekly', '7d', 7 * 86400],
    ['seven_day_opus', 'weekly-opus', '7d Opus', 7 * 86400],
    ['seven_day_sonnet', 'weekly-sonnet', '7d Sonnet', 7 * 86400],
  ];
  for (const [key, id, label, windowSeconds] of definitions) {
    const raw = limits[key];
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
  const extra = limits.extra_usage;
  if (extra !== undefined && extra !== null) {
    if (!record(extra) || typeof extra.is_enabled !== 'boolean') return null;
    const used = number(extra.used_credits);
    const limit = number(extra.monthly_limit);
    if (extra.is_enabled && used !== null && limit !== null && limit > 0) {
      meters.push({ id: 'extra-usage', label: 'Extra',
        utilization: Math.max(0, Math.min(100, used / limit * 100)) });
    }
  }
  if (!meters.some(meter => meter.id === 'five-hour' || meter.id === 'weekly')) return null;
  return quotaResult({ id: PRODUCT_ID, status: 'ok', meters,
    planLabel: planLabel(payload.subscription_type), fetchedAt: now, dataAsOf: now });
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
  return result;
}

function executable(path) {
  try { accessSync(path, constants.X_OK); return true; } catch { return false; }
}

export function findClaudeBinary({ environment = process.env, home = homedir() } = {}) {
  const explicit = environment.VIBE_USAGE_CLAUDE_BIN?.trim();
  const candidates = [
    explicit,
    join(home, '.local', 'bin', 'claude'),
    join(home, '.claude', 'local', 'claude'),
    ...((environment.PATH || '').split(delimiter).filter(Boolean).map(dir => join(dir, 'claude'))),
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

export async function fetchClaudeCodeQuota({
  environment = process.env,
  now = new Date(),
  spawnImpl = spawn,
  deadlineMs = DEADLINE_MS,
  termGraceMs = TERM_GRACE_MS,
} = {}) {
  const binary = findClaudeBinary({ environment });
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
