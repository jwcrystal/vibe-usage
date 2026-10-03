import { createHash } from 'node:crypto';
import { readFileSync, existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { quotaResult } from '../schema.js';

const PRODUCT_ID = 'codex';
const DEFAULT_BASE_URL = 'https://chatgpt.com/backend-api';
const TIMEOUT_MS = 10_000;
const MAX_ATTEMPTS = 3;

function codexHome(environment = process.env) {
  const configured = environment.CODEX_HOME?.trim();
  return configured
    ? configured.replace(/^~(?=$|[\\/])/, homedir())
    : join(homedir(), '.codex');
}

function readAuth(environment = process.env) {
  try {
    const auth = JSON.parse(readFileSync(join(codexHome(environment), 'auth.json'), 'utf8'));
    const token = auth?.tokens?.access_token;
    if (typeof token !== 'string' || !token) return null;
    const accountId = typeof auth.tokens.account_id === 'string' ? auth.tokens.account_id : null;
    return { token, accountId };
  } catch {
    return null;
  }
}

function configuredBase(environment = process.env) {
  try {
    const text = readFileSync(join(codexHome(environment), 'config.toml'), 'utf8');
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('[')) break;
      const match = /^chatgpt_base_url\s*=\s*"([^"]+)"\s*$/.exec(line);
      if (match) return match[1].trim();
    }
  } catch { /* use official default */ }
  return DEFAULT_BASE_URL;
}

export function codexUsageURL(base = DEFAULT_BASE_URL) {
  let normalized = String(base || DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!normalized) normalized = DEFAULT_BASE_URL;
  if ((normalized.startsWith('https://chatgpt.com')
    || normalized.startsWith('https://chat.openai.com'))
    && !normalized.includes('/backend-api')) {
    normalized += '/backend-api';
  }
  const path = normalized.includes('/backend-api') ? '/wham/usage' : '/api/codex/usage';
  const url = new URL(`${normalized}${path}`);
  if (!['https:', 'http:'].includes(url.protocol)) throw new Error('Unsupported Codex endpoint');
  return url;
}

function number(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function parseWindow(raw, now) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const utilization = number(raw.used_percent);
  const seconds = Number.isInteger(raw.limit_window_seconds) ? raw.limit_window_seconds : null;
  if (utilization === null || seconds === null || seconds <= 0) return null;
  let resetsAt;
  if (number(raw.reset_at) > 0) resetsAt = new Date(raw.reset_at * 1000).toISOString();
  else if (number(raw.reset_after_seconds) >= 0) {
    resetsAt = new Date(now.getTime() + raw.reset_after_seconds * 1000).toISOString();
  }
  return { utilization, seconds, ...(resetsAt ? { resetsAt } : {}) };
}

export function parseCodexUsage(payload, now = new Date()) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)
    || !Object.hasOwn(payload, 'rate_limit')) return null;
  const rawLimit = payload.rate_limit;
  if (rawLimit !== null && (!rawLimit || typeof rawLimit !== 'object' || Array.isArray(rawLimit))) return null;
  const limit = rawLimit || {};
  const windows = [];
  for (const key of ['primary_window', 'secondary_window']) {
    if (!(key in limit) || limit[key] === null) continue;
    const parsed = parseWindow(limit[key], now);
    if (!parsed) return null;
    windows.push(parsed);
  }
  const meters = [];
  for (const window of windows) {
    const weekly = window.seconds >= 2 * 24 * 60 * 60;
    const id = weekly ? 'weekly' : 'five-hour';
    if (meters.some(meter => meter.id === id)) continue;
    meters.push({
      id,
      label: weekly ? '7d' : '5h',
      utilization: window.utilization,
      windowSeconds: window.seconds,
      ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
    });
  }
  // Monthly spend cap (CodexBar-compatible spellings): root `individual_limit`
  // wins, `spend_control.individual_limit` is the fallback. limit/used arrive
  // as numbers or numeric strings; any malformation drops only this meter.
  const spendRaw = payload.individual_limit
    ?? (payload.spend_control && typeof payload.spend_control === 'object'
      && !Array.isArray(payload.spend_control)
      ? payload.spend_control.individual_limit : undefined);
  if (spendRaw && typeof spendRaw === 'object' && !Array.isArray(spendRaw)) {
    const spendLimit = number(spendRaw.limit) ?? numberOrNullString(spendRaw.limit);
    const spendUsed = number(spendRaw.used) ?? numberOrNullString(spendRaw.used);
    if (spendLimit !== null && spendLimit > 0 && spendUsed !== null && spendUsed >= 0
      && !meters.some((meter) => meter.id === 'monthly')) {
      const spendMeter = {
        id: 'monthly',
        label: 'Month',
        utilization: Math.max(0, Math.min(100, spendUsed / spendLimit * 100)),
        amountUsed: spendUsed,
        amountLimit: spendLimit,
      };
      const spendReset = number(spendRaw.reset_at) ?? number(spendRaw.resets_at);
      if (spendReset !== null && spendReset > 0) {
        spendMeter.resetsAt = new Date(spendReset * 1000).toISOString();
      }
      meters.push(spendMeter);
    }
  }
  const reached = limit.limit_reached === true || limit.allowed === false;
  const planLabel = ({ free: 'Free', plus: 'Plus', pro: 'Pro', team: 'Team',
    business: 'Business', enterprise: 'Enterprise' })[
    typeof payload.plan_type === 'string' ? payload.plan_type.toLowerCase() : ''];
  // Same shape as the Mac app: only a positive integer count is a fact; every
  // other spelling is "unknown" and stays off the snapshot.
  const credits = payload.rate_limit_reset_credits;
  const resetCredits = credits && typeof credits === 'object' && !Array.isArray(credits)
    && Number.isInteger(credits.available_count) && credits.available_count > 0
    ? credits.available_count
    : undefined;
  return quotaResult({
    id: PRODUCT_ID,
    status: meters.length ? 'ok' : 'no_data',
    meters,
    planLabel,
    resetCredits,
    creditBalance: extractCreditBalance(payload.credits),
    emptyReason: meters.length ? undefined : reached ? 'limitReached' : 'noWindow',
    fetchedAt: now,
    dataAsOf: now,
  });
}

/**
 * The API-credit balance (`credits.balance`) — a number or numeric string, and
 * only a fact when the account has credits and they are not unlimited.
 */
function extractCreditBalance(credits) {
  if (!credits || typeof credits !== 'object' || Array.isArray(credits)
    || credits.hasCredits !== true || credits.unlimited === true) return undefined;
  const raw = credits.balance;
  const balance = typeof raw === 'number' ? raw
    : typeof raw === 'string' && raw.trim() ? Number(raw) : null;
  return balance !== null && Number.isFinite(balance) && balance >= 0 ? balance : undefined;
}

function numberOrNullString(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function retryable(now, message = 'Codex quota request failed') {
  return quotaResult({ id: PRODUCT_ID, status: 'retryable_error', message, fetchedAt: now });
}

async function send(url, auth, fetchImpl, now) {
  let last = null;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'GET',
        redirect: 'manual',
        signal: AbortSignal.timeout(TIMEOUT_MS),
        headers: {
          authorization: `Bearer ${auth.token}`,
          accept: 'application/json',
          ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
        },
      });
    } catch {
      last = 'Codex quota request timed out or failed';
      if (attempt + 1 < MAX_ATTEMPTS) continue;
      return { error: last };
    }
    if ([408, 425].includes(response.status) || response.status >= 500) {
      last = 'Codex quota service temporarily unavailable';
      if (attempt + 1 < MAX_ATTEMPTS) continue;
      return { error: last };
    }
    if (response.status !== 200) return { status: response.status };
    try {
      const payload = await response.json();
      return { result: parseCodexUsage(payload, now) };
    } catch {
      return { error: 'Codex quota response was invalid' };
    }
  }
  return { error: last || 'Codex quota request failed' };
}

/**
 * Best-effort enrichment: the reset-credit expiry dates live on a dedicated
 * endpoint the usage payload only counts (`available_count`). A failure here
 * never downgrades the main read — the count alone still ships.
 */
async function fetchResetCreditDates(base, auth, fetchImpl) {
  try {
    const response = await fetchImpl(`${base}/wham/rate-limit-reset-credits`, {
      method: 'GET',
      redirect: 'manual',
      signal: AbortSignal.timeout(TIMEOUT_MS),
      headers: {
        authorization: `Bearer ${auth.token}`,
        accept: 'application/json',
        ...(auth.accountId ? { 'ChatGPT-Account-Id': auth.accountId } : {}),
      },
    });
    if (response.status !== 200) return undefined;
    const payload = await response.json();
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || !Array.isArray(payload.credits)) return undefined;
    const dates = payload.credits
      .filter((credit) => credit && typeof credit === 'object' && !Array.isArray(credit)
        && credit.status === 'available'
        && typeof credit.expires_at === 'string'
        && !Number.isNaN(Date.parse(credit.expires_at)))
      .map((credit) => new Date(credit.expires_at).toISOString())
      .sort()
      .slice(0, 8);
    return dates.length ? dates : undefined;
  } catch {
    return undefined;
  }
}

export async function fetchCodexQuota({ environment = process.env, now = new Date(), fetchImpl = fetch } = {}) {
  let auth = readAuth(environment);
  if (!auth) {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials',
      message: 'Codex OAuth credentials are unavailable', fetchedAt: now });
  }
  let url;
  try {
    url = codexUsageURL(configuredBase(environment));
  } catch {
    return retryable(now);
  }
  const makeScope = () => createHash('sha256')
    .update(`${auth.accountId || auth.token}\0${url.origin}${url.pathname}`)
    .digest('hex');
  let scope = makeScope();
  let response = await send(url, auth, fetchImpl, now);
  if (response.status === 401) {
    const fresh = readAuth(environment);
    if (fresh && (fresh.token !== auth.token || fresh.accountId !== auth.accountId)) {
      auth = fresh;
      try {
        url = codexUsageURL(configuredBase(environment));
      } catch {
        return retryable(now);
      }
      scope = makeScope();
      response = await send(url, auth, fetchImpl, now);
    }
  }
  if (response.status === 401) {
    return quotaResult({ id: PRODUCT_ID, status: 'unauthorized',
      message: 'Codex login expired; re-login in Codex', fetchedAt: now });
  }
  if (response.status !== undefined) return retryable(now);
  if (response.error) return retryable(now, response.error);
  if (!response.result) return retryable(now, 'Codex quota response was not recognized');
  // Dates are enrichment only: requested when a count exists, skipped on any
  // failure so the main read's shape is never at risk.
  if (response.result.resetCredits > 0) {
    try {
      const resetBase = url.origin
        + url.pathname.replace(/\/(wham\/usage|api\/codex\/usage)$/, '');
      response.result.resetCreditsAt = await fetchResetCreditDates(resetBase, auth, fetchImpl);
    } catch { /* enrichment is optional */ }
  }
  Object.defineProperty(response.result, 'cacheScope', { value: scope, enumerable: false });
  return response.result;
}

export function codexQuotaDetected(environment = process.env, home = homedir()) {
  const root = environment.CODEX_HOME?.trim()
    ? environment.CODEX_HOME.trim().replace(/^~(?=$|[\\/])/, home)
    : join(home, '.codex');
  return existsSync(join(root, 'auth.json'));
}
