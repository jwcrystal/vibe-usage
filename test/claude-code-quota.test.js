import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  fetchClaudeCodeQuota, findClaudeBinary, parseClaudeOAuthUsage, parseClaudeUsage,
  planLabelFromCredential,
} from '../src/quotas/providers/claude-code.js';

// The OAuth route reads whatever login this machine happens to have, so a test
// that means to exercise the CLI probe must declare a credential-free home and
// an empty Keychain — otherwise it reaches the real Claude account.
function credentialFree(home) {
  return { home, readKeychain: async () => null };
}

function writeCredentialStore(root, credential) {
  mkdirSync(join(root, '.claude'), { recursive: true });
  writeFileSync(join(root, '.claude', '.credentials.json'),
    JSON.stringify({ claudeAiOauth: credential }));
  return join(root, '.claude', '.credentials.json');
}

const oauthPayload = {
  five_hour: { utilization: 42, resets_at: '2026-10-03T00:00:00Z' },
  seven_day: { utilization: 61, resets_at: '2026-10-07T00:00:00Z' },
  seven_day_opus: { utilization: 7, resets_at: '2026-10-07T00:00:00Z' },
  seven_day_sonnet: null,
  extra_usage: { is_enabled: false, monthly_limit: 2000, used_credits: 0, decimal_places: 2 },
};

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

test('extra usage meter carries its dollar pair only when enabled with a cap', () => {
  const result = parseClaudeUsage({
    subscription_type: 'max',
    rate_limits: {
      five_hour: { utilization: 10 },
      extra_usage: { is_enabled: true, used_credits: 12.5, monthly_limit: 35 },
    },
  });
  const extra = result.meters.find((meter) => meter.id === 'extra-usage');
  assert.equal(extra.amountUsed, 12.5);
  assert.equal(extra.amountLimit, 35);

  // Disabled extras stay off the card entirely.
  const off = parseClaudeUsage({
    rate_limits: {
      five_hour: { utilization: 10 },
      extra_usage: { is_enabled: false, used_credits: 1, monthly_limit: 2 },
    },
  });
  assert.equal(off.meters.some((meter) => meter.id === 'extra-usage'), false);
});

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
      ...credentialFree(root),
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
      ...credentialFree(root),
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

test('Claude binary discovery reaches version-manager installs on a minimal PATH', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-discovery-'));
  const minimal = { PATH: '/usr/bin:/bin' };
  const plantBinary = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n');
    chmodSync(path, 0o700);
  };
  try {
    // A launchd daemon has no node bin dir on PATH, so the tree a version
    // manager installs into is the only place left to look.
    const shim = join(root, '.local', 'share', 'mise', 'shims', 'claude');
    plantBinary(shim);
    assert.equal(findClaudeBinary({ environment: minimal, home: root }), shim);

    // No shim: the per-version install is the fallback, newest first.
    const older = join(root, '.nvm', 'versions', 'node', 'v20.9.0', 'bin', 'claude');
    const newer = join(root, '.nvm', 'versions', 'node', 'v22.1.0', 'bin', 'claude');
    rmSync(join(root, '.local'), { recursive: true, force: true });
    plantBinary(older);
    plantBinary(newer);
    assert.equal(findClaudeBinary({ environment: minimal, home: root }), newer);

    // PATH still wins: the CLI the user actually runs is the one to probe.
    const onPath = join(root, 'pathbin', 'claude');
    plantBinary(onPath);
    assert.equal(findClaudeBinary({
      environment: { ...minimal, PATH: `${join(root, 'pathbin')}:${minimal.PATH}` }, home: root,
    }), onPath);

    // An explicit override outranks everything.
    const override = join(root, 'custom', 'claude');
    plantBinary(override);
    assert.equal(findClaudeBinary({
      environment: { ...minimal, VIBE_USAGE_CLAUDE_BIN: override }, home: root,
    }), override);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
test('Claude binary discovery reads the Windows PATHEXT forms npm installs', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-windows-'));
  // npm on Windows installs a `.cmd` shim and no extensionless file, and its
  // presence check is file existence — there are no POSIX execute bits.
  const plantWindowsShim = (path) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '@echo off\r\n');
  };
  try {
    const onPath = join(root, 'npm', 'claude.cmd');
    plantWindowsShim(onPath);
    // Windows filesystems are case-insensitive, so `claude.CMD` (the PATHEXT
    // spelling) and `claude.cmd` (the name on disk) are the same file; the
    // comparison ignores case for the same reason Windows does.
    assert.equal(findClaudeBinary({
      environment: { PATH: join(root, 'npm'), PATHEXT: '.COM;.EXE;.BAT;.CMD' },
      home: root,
      platform: 'win32',
    })?.toLowerCase(), onPath.toLowerCase());

    // An unset PATHEXT (service-style minimal environment) still expands the
    // documented defaults instead of falling back to the bare name only.
    assert.equal(findClaudeBinary({
      environment: { PATH: join(root, 'npm') },
      home: root,
      platform: 'win32',
    })?.toLowerCase(), onPath.toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude binary discovery reaches the Claude Desktop builds on every platform', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-desktop-'));
  const minimal = { PATH: '/usr/bin:/bin' };
  const plant = (path, { executable = true } = {}) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n');
    if (executable) chmodSync(path, 0o700);
    return path;
  };
  const bundle = (version, ...middle) => join('claude.app', ...middle, 'Contents', 'MacOS', 'claude');
  try {
    // macOS keeps Desktop's files under "Application Support", and current
    // builds add a per-build content hash so two builds can coexist. A walk that
    // went straight to <version>/claude.app never reached that second shape: the
    // machine read as "not installed", the probe that refreshes the login never
    // ran, and the card stayed on expired_credentials.
    const macHome = join(root, 'mac');
    const macApps = join(macHome, 'Library', 'Application Support', 'Claude', 'claude-code');
    const macLegacy = plant(join(macApps, '2.0.10', bundle()));
    assert.equal(findClaudeBinary({ environment: minimal, home: macHome, platform: 'darwin' }), macLegacy);
    const macCurrent = plant(join(macApps, '2.1.309', '5af865b9901c', bundle()));
    assert.equal(findClaudeBinary({ environment: minimal, home: macHome, platform: 'darwin' }), macCurrent);

    // Windows keeps them under %APPDATA% and installs a `.exe` leaf — there is
    // no extensionless `claude` and no execute bit to check.
    const winHome = join(root, 'win');
    const appData = join(winHome, 'AppData', 'Roaming');
    const win = plant(join(appData, 'Claude', 'claude-code', '2.1.309', '5af865b9901c', 'claude.exe'),
      { executable: false });
    assert.equal(findClaudeBinary({
      environment: { PATH: 'C:\\Windows', APPDATA: appData }, home: winHome, platform: 'win32',
    }), win);

    // Linux follows XDG_CONFIG_HOME (or ~/.config) and uses the bare name.
    const linuxHome = join(root, 'linux');
    const xdg = join(linuxHome, '.config-custom');
    const linux = plant(join(xdg, 'Claude', 'claude-code', '2.1.309', '5af865b9901c', 'claude'));
    assert.equal(findClaudeBinary({
      environment: { PATH: '/usr/bin:/bin', XDG_CONFIG_HOME: xdg }, home: linuxHome, platform: 'linux',
    }), linux);

    // An explicit override still wins over every discovered build.
    const explicit = plant(join(root, 'override', 'claude'));
    assert.equal(findClaudeBinary({
      environment: { PATH: '/usr/bin:/bin', VIBE_USAGE_CLAUDE_BIN: explicit },
      home: macHome,
      platform: 'darwin',
    }), explicit);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude binary discovery covers the installers\' documented locations', () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-installers-'));
  const minimal = { PATH: '/usr/bin:/bin' };
  const plant = (path, { executable = true } = {}) => {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '#!/bin/sh\n');
    if (executable) chmodSync(path, 0o700);
    return path;
  };
  try {
    // Native installer: everything but the launcher lives under
    // ~/.local/share/claude/versions/<version>/. Replacing ~/.local/bin/claude
    // with a script of your own is explicitly supported, so a missing launcher
    // must not hide an install that is still there.
    const posixHome = join(root, 'posix');
    const native = plant(join(posixHome, '.local', 'share', 'claude', 'versions', '2.1.309', 'claude'));
    assert.equal(findClaudeBinary({ environment: minimal, home: posixHome, platform: 'darwin' }), native);

    // Windows keeps the same tree with a `.exe` leaf. Windows filesystems are
    // case-insensitive and PATHEXT spells `.EXE` in its declared case, so the
    // probe can report `claude.EXE` for a file written as `claude.exe` — the
    // comparison ignores case for the same reason Windows does.
    const winHome = join(root, 'win-native');
    const winNative = plant(
      join(winHome, '.local', 'share', 'claude', 'versions', '2.1.309', 'claude.exe'),
      { executable: false },
    );
    assert.equal(findClaudeBinary({
      environment: { PATH: 'C:\\Windows' }, home: winHome, platform: 'win32',
    })?.toLowerCase(), winNative.toLowerCase());

    // npm's global prefix is not always on a GUI app's PATH, and on Windows it
    // holds a `.cmd` shim rather than a binary.
    const npmHome = join(root, 'win-npm');
    const appData = join(npmHome, 'AppData', 'Roaming');
    const npmShim = plant(join(appData, 'npm', 'claude.cmd'), { executable: false });
    assert.equal(findClaudeBinary({
      environment: { PATH: 'C:\\Windows', APPDATA: appData }, home: npmHome, platform: 'win32',
    })?.toLowerCase(), npmShim.toLowerCase());

    // mise's Windows shims live in %LOCALAPPDATA%\mise\shims, not the POSIX tree.
    const miseHome = join(root, 'win-mise');
    const localAppData = join(miseHome, 'AppData', 'Local');
    const miseShim = plant(join(localAppData, 'mise', 'shims', 'claude.exe'), { executable: false });
    assert.equal(findClaudeBinary({
      environment: { PATH: 'C:\\Windows', LOCALAPPDATA: localAppData }, home: miseHome, platform: 'win32',
    })?.toLowerCase(), miseShim.toLowerCase());
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Claude OAuth parser reads top-level windows and the money unit the payload declares', () => {
  const result = parseClaudeOAuthUsage(oauthPayload,
    { plan: 'Pro', now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(result.status, 'ok');
  assert.equal(result.planLabel, 'Pro');
  assert.deepEqual(result.meters.map(meter => meter.id), ['five-hour', 'weekly', 'weekly-opus']);

  // Minor units: 1250 of a 2000 limit is $12.50 of $20.00, not $1250 of $2000.
  const withExtra = parseClaudeOAuthUsage({
    five_hour: { utilization: 1 },
    extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 2000, decimal_places: 2 },
  }, { now: new Date('2026-10-02T00:00:00Z') });
  const extra = withExtra.meters.find(meter => meter.id === 'extra-usage');
  assert.equal(extra.amountUsed, 12.5);
  assert.equal(extra.amountLimit, 20);

  // An undeclared unit is unknowable, so the block is dropped rather than guessed.
  const undeclared = parseClaudeOAuthUsage({
    five_hour: { utilization: 1 },
    extra_usage: { is_enabled: true, used_credits: 1250, monthly_limit: 2000 },
  }, { now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(undeclared.meters.some(meter => meter.id === 'extra-usage'), false);

  // No window at all is a definitive answer about the account, not a parse failure.
  const windowless = parseClaudeOAuthUsage({ seven_day_sonnet: null },
    { plan: 'Max', now: new Date('2026-10-02T00:00:00Z') });
  assert.equal(windowless.status, 'no_data');
  assert.equal(windowless.emptyReason, 'noWindow');
  assert.equal(windowless.planLabel, 'Max');
  assert.equal(parseClaudeOAuthUsage({ five_hour: { utilization: '42' } }), null);
});

test('Claude plan label prefers the subscription type and names the Max tiers', () => {
  assert.equal(planLabelFromCredential({ subscriptionType: 'max' }), 'Max');
  assert.equal(planLabelFromCredential({
    subscriptionType: 'pro', rateLimitTier: 'default_claude_max_20x',
  }), 'Pro');
  assert.equal(planLabelFromCredential({ rateLimitTier: 'default_claude_max_5x' }), 'Max 5x');
  assert.equal(planLabelFromCredential({ rateLimitTier: 'default_claude_max_20x' }), 'Max 20x');
  assert.equal(planLabelFromCredential({ rateLimitTier: 'default_claude_ai' }), 'Pro');
  assert.equal(planLabelFromCredential({}), undefined);
});

test('Claude quota prefers the OAuth route, spawns nothing, and writes nothing', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-oauth-'));
  try {
    const store = writeCredentialStore(root, {
      accessToken: 'sk-ant-oat01-private-token',
      subscriptionType: 'pro',
      rateLimitTier: 'default_claude_ai',
      expiresAt: Date.parse('2026-10-20T00:00:00Z'),
    });
    const before = readFileSync(store, 'utf8');
    let request;
    let spawned = false;
    const result = await fetchClaudeCodeQuota({
      environment: {},
      home: root,
      now: new Date('2026-10-14T00:00:00Z'),
      readKeychain: async () => null,
      spawnImpl: () => { spawned = true; throw new Error('the CLI must not be spawned'); },
      fetchImpl: async (url, init) => {
        request = { url, init };
        return { ok: true, status: 200, json: async () => oauthPayload };
      },
    });
    assert.equal(spawned, false);
    assert.equal(result.status, 'ok');
    assert.equal(result.planLabel, 'Pro');
    assert.deepEqual(result.meters.map(meter => meter.id), ['five-hour', 'weekly', 'weekly-opus']);
    assert.equal(request.url, 'https://api.anthropic.com/api/oauth/usage');
    assert.equal(request.init.headers.Authorization, 'Bearer sk-ant-oat01-private-token');
    // A quota read is read-only: the credential store is byte-identical after.
    assert.equal(readFileSync(store, 'utf8'), before);
    assert.equal(JSON.stringify(result).includes('sk-ant-oat01-private-token'), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('an expired Claude login is reported instead of refreshed, and the CLI can recover it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-expired-'));
  try {
    writeCredentialStore(root, {
      accessToken: 'sk-ant-oat01-stale-token',
      subscriptionType: 'pro',
      expiresAt: Date.parse('2026-10-01T00:00:00Z'),
    });
    let fetched = false;
    const refused = async () => { fetched = true; return { ok: true, status: 200, json: async () => oauthPayload }; };

    const expired = await fetchClaudeCodeQuota({
      environment: {},
      ...credentialFree(root),
      now: new Date('2026-10-14T00:00:00Z'),
      fetchImpl: refused,
    });
    assert.equal(fetched, false, 'an expired login is never sent to the endpoint');
    assert.equal(expired.status, 'expired_credentials');
    assert.equal(expired.planLabel, 'Pro');

    // Refreshing is the tool's job: a working probe still answers through the
    // login it owns.
    const binary = fakeClaude(root, successProtocol);
    const recovered = await fetchClaudeCodeQuota({
      environment: { ...process.env, VIBE_USAGE_CLAUDE_BIN: binary },
      ...credentialFree(root),
      now: new Date('2026-10-14T00:00:00Z'),
      fetchImpl: refused,
    });
    assert.equal(recovered.status, 'ok');
    assert.equal(recovered.planLabel, 'Max');
    assert.deepEqual(recovered.meters.map(meter => meter.id),
      ['five-hour', 'weekly', 'weekly-opus']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a credential record with no access token reads as a dead login, not a missing install', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-dead-login-'));
  try {
    // Measured on macOS 2026-11-01: a revoked Claude Code login leaves the
    // record, its plan, and an empty token behind in the Keychain. The plan is
    // the whole point — the subscription is still live, so the card must not
    // say nothing is configured here.
    writeCredentialStore(root, {
      accessToken: '', refreshToken: '', expiresAt: 0,
      subscriptionType: 'pro', rateLimitTier: 'default_claude_ai',
    });
    let fetched = false;
    const refused = async () => { fetched = true; return { ok: true, status: 200, json: async () => oauthPayload }; };

    const dead = await fetchClaudeCodeQuota({
      environment: {},
      ...credentialFree(root),
      now: new Date('2026-11-02T00:00:00Z'),
      fetchImpl: refused,
    });
    assert.equal(fetched, false, 'a token-less login is never sent to the endpoint');
    assert.equal(dead.status, 'expired_credentials');
    assert.equal(dead.planLabel, 'Pro');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('a rejected or unreachable Claude usage endpoint keeps an actionable status', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-oauth-error-'));
  try {
    writeCredentialStore(root, {
      accessToken: 'sk-ant-oat01-private-token',
      subscriptionType: 'pro',
      expiresAt: Date.parse('2026-10-20T00:00:00Z'),
    });
    const base = {
      environment: {}, ...credentialFree(root), now: new Date('2026-10-14T00:00:00Z'),
    };

    const rejected = await fetchClaudeCodeQuota({
      ...base, fetchImpl: async () => ({ ok: false, status: 401 }),
    });
    assert.equal(rejected.status, 'unauthorized');
    assert.equal(rejected.planLabel, 'Pro');

    const offline = await fetchClaudeCodeQuota({
      ...base, fetchImpl: async () => { throw new Error('offline'); },
    });
    assert.equal(offline.status, 'retryable_error');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

// Mirrors the measured behaviour of the real binary: with USER unset it answers
// `rate_limits_available: false` for an account that does have plan limits.
const userSensitiveProtocol = `
const NL = String.fromCharCode(10);
let input = '';
process.stdin.on('data', chunk => {
  input += chunk.toString();
  while (input.includes(NL)) {
    const line = input.slice(0, input.indexOf(NL));
    input = input.slice(input.indexOf(NL) + 1);
    const request = JSON.parse(line);
    const requestId = request.request_id;
    const response = requestId === 'vibe-init'
      ? { request_id: requestId, subtype: 'success', response: {} }
      : { request_id: requestId, subtype: 'success', response: process.env.USER
          ? { rate_limits_available: true, subscription_type: 'max',
              rate_limits: { five_hour: { utilization: 5 } } }
          : { rate_limits_available: false } };
    process.stdout.write(JSON.stringify({ type: 'control_response', response }) + NL);
  }
});`;

test('the CLI probe supplies USER when the service environment omits it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'vibe-claude-user-'));
  try {
    const binary = fakeClaude(root, userSensitiveProtocol);
    // A launchd job, a container, or any stripped parent can have no USER; the
    // probe must not silently degrade to "no plan limits" there.
    const stripped = await fetchClaudeCodeQuota({
      ...credentialFree(root),
      environment: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
        VIBE_USAGE_CLAUDE_BIN: binary },
      now: new Date('2026-10-14T00:00:00Z'),
    });
    assert.equal(stripped.status, 'ok');
    assert.equal(stripped.planLabel, 'Max');
    assert.deepEqual(stripped.meters.map(meter => meter.id), ['five-hour']);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
