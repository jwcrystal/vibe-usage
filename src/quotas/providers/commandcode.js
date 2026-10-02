import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { quotaResult } from '../schema.js';

const PRODUCT_ID = 'commandcode';
const DEFAULT_API_BASE = 'https://api.commandcode.ai';

// Command Code subscription quota (phase 1, approved 2026-10-02).
//
// Credential: the CLI's own `~/.commandcode/auth.json` carries a top-level
// `apiKey` alongside identity fields and a nested `codex` OAuth entry for its
// Codex passthrough. Only `apiKey` is read; identity fields and the `codex`
// entry are never inspected, projected, or logged. The key is sent as a
// Bearer header only, never in a URL.
//
// Network: exactly four documented GET endpoints under the one host, in the
// order the official CLI's /usage overlay uses them — whoami first (its
// `org.id` alone supplies the optional orgId the other endpoints accept), then
// billing subscriptions (its `data.planId` supplies the plan label and
// `data.currentPeriodStart` the usage window's `since`), credits, and the
// period usage summary.
//
// Parsing is endpoint-path-specific, never a recursive walk. Each payload is
// read at the one documented location for the quota facts it owns:
//
//   whoami          { success?, org?: { id } }                -> org scope only
//   subscriptions   { success?, data?: { status, planId,
//                      currentPeriodStart, currentPeriodEnd } }
//   credits         { success?, windowLimits?: { limited,
//                      fiveHour?: { used, cap, resetAt },
//                      weekly?:   { used, cap, resetAt } },
//                     credits?: { monthlyCredits, purchasedCredits } }
//   usage/summary   { success?, totalMonthlyCredits }          -> cycle spend
//
// Meters are emitted only for positively identified windows: the rolling 5h
// and weekly windows when credits states both `used` and a positive dollar
// `cap`, and the monthly credit pool when both live sides (`monthlyCredits`
// remaining + `totalMonthlyCredits` spent) are stated. Purchased extra credits
// carry no cap and therefore no percentage, so they are dropped. Unknown
// fields, nested arbitrary records, bare ratios, mismatched units, identity
// fields (`name`, `id`, `email`, …) and raw response text never reach a
// result; meter ids and labels are generated from the fixed window vocabulary
// below. Plan identity is the subscriptions `planId` normalized through the
// documented alias table, status-gated so a canceled plan never resurfaces.
//
// Failure semantics: whoami gates the read — 401 is unauthorized, 403 and
// every other transport/non-2xx/malformed failure is a body-free
// retryable_error. The three billing legs then fail independently: a
// transport error, non-2xx status, malformed body, or rejected
// (`success: false`) answer is recorded and the remaining requests still run,
// so valid meters survive a later failure. Classification follows what
// survived: any meter is `ok` (partial ok means only that some known windows
// were valid), zero meters with at least one failed leg is `retryable_error`,
// and zero meters with every leg answered is `no_data`. A 401 on any leg
// still ends the read as unauthorized and a 403 as retryable; no response
// text, error message, header, or credential ever reaches a result.
//
// This provider deliberately opts out of the quota cache (no
// attachCacheScope): the registry saves/loads only results that carry a
// cache scope, so Command Code results are never written to or read from
// ~/.vibe-usage/quota-cache.json.

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, Math.round(value * 100) / 100));
}

/**
 * A reset epoch or period date as a Date. Epoch milliseconds pass through;
 * a positive number below 1e12 is read as seconds (the CLI's rate-limit
 * envelopes use seconds); ISO date strings parse through Date. `0`, negative
 * numbers and unparseable values mean no stated time.
 */
function dateFrom(value) {
  if (typeof value === 'string' && value.trim()) {
    const parsed = new Date(value.trim());
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const epoch = finiteNumber(value);
  if (epoch === null || epoch <= 0) return null;
  const millis = epoch >= 1e12 ? epoch : epoch >= 1e9 ? epoch * 1000 : null;
  if (millis === null) return null;
  const parsed = new Date(millis);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function commandcodeAuthPath(home = homedir()) {
  return join(home, '.commandcode', 'auth.json');
}

/** Reads only the top-level `apiKey`; every other entry stays uninspected. */
export function readCommandcodeCredential(path) {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf8'));
    const apiKey = parsed?.apiKey;
    if (typeof apiKey !== 'string' || !apiKey.trim()) return null;
    return { apiKey: apiKey.trim() };
  } catch {
    return null;
  }
}

// --- plan identity ---------------------------------------------------------

// Mirrors the official CLI's billing client: only these statuses still
// identify a plan, so a canceled/unpaid subscription never renames the card.
const PLAN_BEARING_STATUSES = new Set(['active', 'trialing', 'past_due']);

// The documented subscription `planId` vocabulary (Command Code API/CLI plan
// ids and aliases) mapped to fixed display labels. Unknown ids are omitted —
// never echoed raw.
const PLAN_LABELS = new Map([
  ['go', 'Go'],
  ['individual-go', 'Go'],
  ['goat', 'GOAT'],
  ['individual-goat', 'GOAT'],
  ['pro', 'Pro'],
  ['individual-pro-v1', 'Pro'],
  ['prolegacy', 'Pro (legacy)'],
  ['pro-legacy', 'Pro (legacy)'],
  ['individual-pro', 'Pro (legacy)'],
  ['max', 'Max 10×'],
  ['max10', 'Max 10×'],
  ['max-10x', 'Max 10×'],
  ['individual-max', 'Max 10×'],
  ['max20', 'Max 20×'],
  ['max-20x', 'Max 20×'],
  ['individual-ultra', 'Max 20×'],
  ['ultra', 'Max 20×'],
  ['teampro', 'Team Pro'],
  ['team-pro', 'Team Pro'],
  ['teams-pro', 'Team Pro'],
  ['provider', 'Provider'],
  ['individual-provider', 'Provider'],
]);

function planLabelFromSubscription(data) {
  if (!isRecord(data)) return undefined;
  const status = typeof data.status === 'string' ? data.status.trim().toLowerCase() : '';
  if (!PLAN_BEARING_STATUSES.has(status)) return undefined;
  const planId = typeof data.planId === 'string' ? data.planId.trim().toLowerCase() : '';
  return PLAN_LABELS.get(planId);
}

// --- projection ------------------------------------------------------------

const FIVE_HOUR_SECONDS = 5 * 3600;
const WEEK_SECONDS = 7 * 86_400;

/** A payload only counts as an answer when it is a record and not rejected. */
function answered(payload) {
  return isRecord(payload) && payload.success !== false;
}

/**
 * One rolling window: `used` against the live dollar `cap` the credits
 * endpoint states. Both must be positively identified numbers, the cap must
 * be positive, and `used` must not be negative; anything else drops the
 * window rather than guessing a rate or limit. The window duration is the
 * endpoint's own fixed 5h/weekly window, and `resetAt` is attached only when
 * stated (`0` means idle).
 */
function windowMeter(id, label, raw, windowSeconds) {
  if (!isRecord(raw)) return null;
  const used = finiteNumber(raw.used);
  const cap = finiteNumber(raw.cap);
  if (used === null || used < 0 || cap === null || cap <= 0) return null;
  const meter = {
    id,
    label,
    utilization: clampPercent(used / cap * 100),
    windowSeconds,
  };
  const resetsAt = dateFrom(raw.resetAt);
  if (resetsAt) meter.resetsAt = resetsAt.toISOString();
  return meter;
}

/**
 * The monthly pool: the credits endpoint's `monthlyCredits` (remaining) plus
 * the summary's `totalMonthlyCredits` (spent this cycle) are the two live
 * sides that add up to the granted pool. Both are required; neither a cap nor
 * a rate is invented when one is missing. The cycle renewal comes from the
 * subscription record's `currentPeriodEnd` (`0`/absent stays absent, and a
 * calendar month carries no fixed window duration).
 */
function monthlyMeter(credits, summary, periodEnd) {
  const remaining = isRecord(credits) ? finiteNumber(credits.monthlyCredits) : null;
  const spent = isRecord(summary) ? finiteNumber(summary.totalMonthlyCredits) : null;
  if (remaining === null || remaining < 0 || spent === null || spent < 0) return null;
  const cap = remaining + spent;
  if (!(cap > 0)) return null;
  const meter = {
    id: 'monthly',
    label: 'Month',
    utilization: clampPercent(spent / cap * 100),
  };
  if (periodEnd) meter.resetsAt = periodEnd.toISOString();
  return meter;
}

/**
 * Strict projection over the four endpoint payloads. Only the documented
 * paths above are read; the response's arbitrary nested objects, identity
 * fields and unknown keys are never inspected or emitted. Meters keep their
 * fixed vocabulary identities, so duplicate windows cannot occur and display
 * labels never carry response text.
 */
export function projectCommandcodeQuota(sources = {}) {
  const meters = [];

  const subscriptions = answered(sources.subscriptions) ? sources.subscriptions : undefined;
  const subscriptionData = subscriptions && isRecord(subscriptions.data)
    ? subscriptions.data : undefined;
  const planLabel = planLabelFromSubscription(subscriptionData);
  const periodEnd = subscriptionData ? dateFrom(subscriptionData.currentPeriodEnd) : null;

  const creditsPayload = answered(sources.credits) ? sources.credits : undefined;
  const windowLimits = creditsPayload && isRecord(creditsPayload.windowLimits)
    ? creditsPayload.windowLimits : undefined;
  const creditsRecord = creditsPayload && isRecord(creditsPayload.credits)
    ? creditsPayload.credits : undefined;
  // `limited: false` is the documented pay-as-you-go answer: the rolling
  // subscription windows do not exist on that account.
  if (windowLimits && windowLimits.limited !== false) {
    const fiveHour = windowMeter('five-hour', '5h', windowLimits.fiveHour, FIVE_HOUR_SECONDS);
    if (fiveHour) meters.push(fiveHour);
    const weekly = windowMeter('weekly', '7d', windowLimits.weekly, WEEK_SECONDS);
    if (weekly) meters.push(weekly);
  }

  const usage = answered(sources.usage) ? sources.usage : undefined;
  const monthly = monthlyMeter(creditsRecord, usage, periodEnd);
  if (monthly) meters.push(monthly);

  return { meters, planLabel };
}

// --- fetch -----------------------------------------------------------------

function orgIdFromWhoami(payload) {
  const org = isRecord(payload) && isRecord(payload.org) ? payload.org : undefined;
  if (!org || typeof org.id !== 'string' || !org.id.trim()) return undefined;
  return org.id.trim();
}

function periodStartFrom(subscriptions) {
  const data = isRecord(subscriptions) && isRecord(subscriptions.data)
    ? subscriptions.data : undefined;
  if (!data) return undefined;
  const value = data.currentPeriodStart;
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (finiteNumber(value) !== null && value > 0) return String(value);
  return undefined;
}

async function requestJSON(url, token, fetchImpl, timeoutMs) {
  const response = await fetchImpl(url, {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(timeoutMs),
  });
  let payload;
  try {
    payload = await response.json();
  } catch {
    payload = undefined;
  }
  return { status: response.status, ok: response.ok, payload };
}

function retryableResult(message, now) {
  return quotaResult({ id: PRODUCT_ID, status: 'retryable_error',
    message, fetchedAt: now });
}

/**
 * A failure with the response body and error text already discarded. The
 * classification is all that survives: an HTTP status, a timeout, any other
 * transport error, a malformed body, or a rejected (`success: false`) answer.
 * Messages are fixed strings plus the status number, so nothing a server or
 * runtime said can reach a result.
 */
function failureResult(failure, now) {
  if (failure.kind === 'http') {
    return retryableResult(`Command Code API returned HTTP ${failure.status}`, now);
  }
  if (failure.kind === 'timeout') {
    return retryableResult('Command Code quota request timed out', now);
  }
  if (failure.kind === 'transport') {
    return retryableResult('Command Code quota request failed', now);
  }
  if (failure.kind === 'malformed') {
    return retryableResult('Command Code API response was malformed', now);
  }
  return retryableResult('Command Code API returned an unsuccessful response', now);
}

/**
 * One billing leg after whoami. A leg is `answered` only when the endpoint
 * returned a JSON record that is not a rejection; 401/403 stay terminal for
 * the caller, and every other outcome is a recorded, body-free failure the
 * chain continues past so the remaining legs can still answer.
 */
async function fetchLeg(get, path, params) {
  let response;
  try {
    response = await get(path, params);
  } catch (error) {
    return { outcome: 'failure',
      kind: error?.name === 'TimeoutError' ? 'timeout' : 'transport' };
  }
  if (response.status === 401) return { outcome: 'unauthorized' };
  if (response.status === 403) return { outcome: 'forbidden' };
  if (!response.ok) return { outcome: 'failure', kind: 'http', status: response.status };
  if (!isRecord(response.payload)) return { outcome: 'failure', kind: 'malformed' };
  if (response.payload.success === false) return { outcome: 'failure', kind: 'rejected' };
  return { outcome: 'answered', payload: response.payload };
}

function recordLegFailure(failures, failure) {
  if (failure.kind === 'http') {
    if (failures.http === null) failures.http = failure.status;
  } else {
    failures[failure.kind] = true;
  }
}

/** The first recorded failure in a fixed priority order, or null. */
function firstLegFailure(failures) {
  if (failures.http !== null) return { kind: 'http', status: failures.http };
  if (failures.timeout) return { kind: 'timeout' };
  if (failures.transport) return { kind: 'transport' };
  if (failures.malformed) return { kind: 'malformed' };
  if (failures.rejected) return { kind: 'rejected' };
  return null;
}

export async function fetchCommandcodeQuota({
  home = homedir(),
  fetchImpl = globalThis.fetch,
  apiBase = DEFAULT_API_BASE,
  now = new Date(),
  timeoutMs = 10_000,
} = {}) {
  const credential = readCommandcodeCredential(commandcodeAuthPath(home));
  if (!credential) {
    return quotaResult({ id: PRODUCT_ID, status: 'missing_credentials',
      message: 'Command Code login not found', fetchedAt: now });
  }
  const base = String(apiBase).trim().replace(/\/+$/, '');
  const get = (path, params) => {
    const search = new URLSearchParams(params).toString();
    return requestJSON(`${base}${path}${search ? `?${search}` : ''}`,
      credential.apiKey, fetchImpl, timeoutMs);
  };
  const rejected = () => quotaResult({ id: PRODUCT_ID, status: 'unauthorized',
    message: 'Command Code rejected the saved key', fetchedAt: now });
  // A 403 has no documented entitlement shape in this API, so it is never
  // treated as unauthorized (or as "not entitled"): it stays an explicit,
  // body-free failure the user can retry.
  const forbidden = () => failureResult({ kind: 'http', status: 403 }, now);
  try {
    // whoami is the gate: it is the only terminal leg. 401 and 403 end the
    // read as unauthorized and body-free retryable_error; every other
    // failure (transport, non-2xx, malformed body) is retryable and names
    // no scope.
    let whoami;
    try {
      whoami = await get('/alpha/whoami', [['limits', '1']]);
    } catch (error) {
      return failureResult({
        kind: error?.name === 'TimeoutError' ? 'timeout' : 'transport',
      }, now);
    }
    if (whoami.status === 401) return rejected();
    if (whoami.status === 403) return forbidden();
    if (!whoami.ok) return failureResult({ kind: 'http', status: whoami.status }, now);
    if (!isRecord(whoami.payload)) return failureResult({ kind: 'malformed' }, now);

    // A rejected whoami answer carries no scope; the chain continues
    // unscoped exactly as it does when no org is named.
    const orgId = whoami.payload.success === false
      ? undefined : orgIdFromWhoami(whoami.payload);
    const orgParams = orgId ? [['orgId', orgId]] : [];

    // The billing legs are independent reads. 401/403 stay terminal; every
    // other failure is recorded and the remaining requests still run, so a
    // leg that answered can keep feeding the projection.
    const failures = { http: null, timeout: false, transport: false,
      malformed: false, rejected: false };
    const sources = {};
    for (const [name, path] of [['subscriptions', '/alpha/billing/subscriptions'],
      ['credits', '/alpha/billing/credits']]) {
      const leg = await fetchLeg(get, path, orgParams);
      if (leg.outcome === 'unauthorized') return rejected();
      if (leg.outcome === 'forbidden') return forbidden();
      if (leg.outcome === 'answered') sources[name] = leg.payload;
      else recordLegFailure(failures, leg);
    }

    const since = periodStartFrom(sources.subscriptions);
    const usageParams = [...orgParams];
    if (since) usageParams.push(['since', since]);
    const usage = await fetchLeg(get, '/alpha/usage/summary', usageParams);
    if (usage.outcome === 'unauthorized') return rejected();
    if (usage.outcome === 'forbidden') return forbidden();
    if (usage.outcome === 'answered') sources.usage = usage.payload;
    else recordLegFailure(failures, usage);

    const { meters, planLabel } = projectCommandcodeQuota(sources);
    if (meters.length) {
      // Partial success is still success: meters that survived their own leg
      // are shown even when another leg failed.
      return quotaResult({ id: PRODUCT_ID, status: 'ok', meters, planLabel,
        fetchedAt: now, dataAsOf: now });
    }
    const failure = firstLegFailure(failures);
    if (failure) return failureResult(failure, now);
    return quotaResult({ id: PRODUCT_ID, status: 'no_data', planLabel,
      fetchedAt: now, dataAsOf: now });
  } catch (error) {
    return failureResult({
      kind: error?.name === 'TimeoutError' ? 'timeout' : 'transport',
    }, now);
  }
}
