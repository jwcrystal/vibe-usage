export const QUOTA_SCHEMA_VERSION = 1;

export const QUOTA_PRODUCT_IDS = Object.freeze([
  'codex',
  'kimi-code',
  'zcode',
  'grok',
  'opencode-go',
  'commandcode',
  'claude-code',
  'cursor',
]);

export const FETCHABLE_QUOTA_PRODUCT_IDS = Object.freeze([
  'codex',
  'kimi-code',
  'zcode',
  'grok',
  'opencode-go',
  'commandcode',
  'claude-code',
]);

export const QUOTA_SYNC_PRODUCT_IDS = Object.freeze([
  'codex', 'commandcode', 'claude-code', 'opencode-go',
]);

/**
 * Machine-readable "why there was no window" values, shared with the desktop
 * clients' `EmptyReason` (macOS `RateLimit.swift`) and additive within schema
 * v1: a client that does not know the field ignores it, and a client that does
 * can render the reason instead of a neutral empty state.
 */
export const QUOTA_EMPTY_REASONS = Object.freeze([
  'limitReached',
  'noWindow',
  'notEntitled',
  'sessionWithoutPlanLimits',
]);

const FETCH_STATUSES = new Set([
  'ok',
  'no_data',
  'missing_credentials',
  'expired_credentials',
  'unauthorized',
  'retryable_error',
  'unsupported',
]);

function finiteNumber(value, name) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError(`${name} must be a finite number`);
  }
  return value;
}

function optionalISODate(value, name) {
  if (value === undefined || value === null) return undefined;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new TypeError(`${name} must be an ISO date string`);
  }
  return date.toISOString();
}

export function normalizeMeter(raw, index = 0) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new TypeError(`meters[${index}] must be an object`);
  }
  const id = String(raw.id || '').trim();
  const label = String(raw.label || '').trim();
  if (!id || !label) throw new TypeError(`meters[${index}] needs id and label`);

  const utilization = Math.max(0, Math.min(100,
    finiteNumber(raw.utilization, `meters[${index}].utilization`)));
  const meter = { id, label, utilization };
  const resetsAt = optionalISODate(raw.resetsAt, `meters[${index}].resetsAt`);
  if (resetsAt) meter.resetsAt = resetsAt;
  if (raw.windowSeconds !== undefined && raw.windowSeconds !== null) {
    const seconds = finiteNumber(raw.windowSeconds, `meters[${index}].windowSeconds`);
    if (seconds > 0) meter.windowSeconds = seconds;
  }
  // Optional dollar amount pair (USD, e.g. Command Code's window cap and
  // monthly credit pool). The two sides only travel together: a used without
  // a limit would invite the UI to invent one.
  if (raw.amountUsed !== undefined || raw.amountLimit !== undefined) {
    const amountUsed = finiteNumber(raw.amountUsed, `meters[${index}].amountUsed`);
    const amountLimit = finiteNumber(raw.amountLimit, `meters[${index}].amountLimit`);
    if (amountUsed < 0) throw new TypeError(`meters[${index}].amountUsed must be non-negative`);
    if (amountLimit <= 0) throw new TypeError(`meters[${index}].amountLimit must be positive`);
    meter.amountUsed = amountUsed;
    meter.amountLimit = amountLimit;
  }
  return meter;
}

const PERIOD_LABELS = new Map([
  ['daily', { label: '1d', seconds: 24 * 60 * 60, exact: true }],
  ['day', { label: '1d', seconds: 24 * 60 * 60, exact: true }],
  ['weekly', { label: '7d', seconds: 7 * 24 * 60 * 60, exact: true }],
  ['week', { label: '7d', seconds: 7 * 24 * 60 * 60, exact: true }],
  ['monthly', { label: 'Month', seconds: 30 * 24 * 60 * 60, exact: false }],
  ['month', { label: 'Month', seconds: 30 * 24 * 60 * 60, exact: false }],
]);

function periodPresentation(meter) {
  const compact = meter.label.trim().toLowerCase().replace(/\s+/g, '');
  const alias = PERIOD_LABELS.get(compact);
  if (alias) {
    return {
      label: alias.label,
      seconds: meter.windowSeconds || alias.seconds,
      inferredWindowSeconds: alias.exact ? alias.seconds : undefined,
    };
  }

  const match = /^(\d+(?:\.\d+)?)(m|h|d|w)$/.exec(compact);
  if (!match) return null;
  const multipliers = { m: 60, h: 3600, d: 86400, w: 7 * 86400 };
  const seconds = meter.windowSeconds || Number(match[1]) * multipliers[match[2]];
  const label = compact === '1w' ? '7d' : compact;
  return { label, seconds, inferredWindowSeconds: seconds };
}

/**
 * Keep the compact desktop cards predictable across providers: generic time
 * windows come first from shortest to longest, followed by model-specific and
 * feature meters in their provider-defined order. The original index is the
 * final comparison key so the sort remains deterministic on every JS runtime.
 */
export function canonicalizeMeters(rawMeters) {
  return rawMeters
    .map((raw, index) => {
      const meter = normalizeMeter(raw, index);
      const period = periodPresentation(meter);
      if (period) {
        meter.label = period.label;
        if (!meter.windowSeconds && period.inferredWindowSeconds) {
          meter.windowSeconds = period.inferredWindowSeconds;
        }
      }
      return { meter, periodSeconds: period?.seconds, index };
    })
    .sort((left, right) => {
      const leftIsPeriod = left.periodSeconds !== undefined;
      const rightIsPeriod = right.periodSeconds !== undefined;
      if (leftIsPeriod !== rightIsPeriod) return leftIsPeriod ? -1 : 1;
      if (leftIsPeriod && left.periodSeconds !== right.periodSeconds) {
        return left.periodSeconds - right.periodSeconds;
      }
      return left.index - right.index;
    })
    .map(item => item.meter);
}

export function quotaResult({
  id,
  status,
  meters = [],
  planLabel,
  resetCredits,
  resetCreditsAt,
  creditBalance,
  fetchedAt = new Date(),
  dataAsOf = fetchedAt,
  message,
  source = 'live',
  emptyReason,
}) {
  if (!FETCHABLE_QUOTA_PRODUCT_IDS.includes(id)) {
    throw new TypeError(`unsupported quota product: ${id}`);
  }
  if (!FETCH_STATUSES.has(status)) {
    throw new TypeError(`invalid quota status: ${status}`);
  }
  const result = {
    id,
    status,
    meters: canonicalizeMeters(meters),
    fetchedAt: new Date(fetchedAt).toISOString(),
    source,
  };
  const normalizedDataAsOf = optionalISODate(dataAsOf, 'dataAsOf');
  if (normalizedDataAsOf) result.dataAsOf = normalizedDataAsOf;
  if (resetCredits !== undefined && resetCredits !== null) {
    if (!Number.isInteger(resetCredits) || resetCredits < 0 || resetCredits > 1_000_000) {
      throw new TypeError('resetCredits must be a non-negative integer');
    }
    result.resetCredits = resetCredits;
  }
  if (resetCreditsAt !== undefined && resetCreditsAt !== null) {
    if (!Array.isArray(resetCreditsAt) || resetCreditsAt.length > 8
      || resetCreditsAt.some((item) => typeof item !== 'string')) {
      throw new TypeError('resetCreditsAt must be ISO date strings');
    }
    const dates = resetCreditsAt
      .map((item) => optionalISODate(item, 'resetCreditsAt'))
      .filter((item) => item !== undefined);
    if (dates.length) result.resetCreditsAt = dates;
  }
  if (creditBalance !== undefined && creditBalance !== null) {
    if (typeof creditBalance !== 'number' || !Number.isFinite(creditBalance)
      || creditBalance < 0 || creditBalance > 1e9) {
      throw new TypeError('creditBalance must be a non-negative finite number');
    }
    result.creditBalance = creditBalance;
  }
  if (typeof planLabel === 'string' && planLabel.trim()) result.planLabel = planLabel.trim();
  if (typeof message === 'string' && message.trim()) result.message = message.trim();
  if (emptyReason !== undefined && emptyReason !== null) {
    if (!QUOTA_EMPTY_REASONS.includes(emptyReason)) {
      throw new TypeError(`invalid quota emptyReason: ${emptyReason}`);
    }
    result.emptyReason = emptyReason;
  }
  return result;
}

export function quotaEnvelope(products) {
  return { schemaVersion: QUOTA_SCHEMA_VERSION, products };
}
