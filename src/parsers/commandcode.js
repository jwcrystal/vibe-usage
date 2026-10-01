import { createReadStream, existsSync, readdirSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { basename, join } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { projectFromCwd, toCount } from './fs-utils.js';
import { getCommandcodeRoots } from '../tools.js';

// Command Code sessions. One append-only JSONL per session:
//   ~/.commandcode/projects/<project-slug>/<session-id>.jsonl
// The first line is a header ({type:"session", version, id, timestamp, cwd});
// every line after it is a message entry — your prompts, the model's replies,
// compaction summaries, model/effort changes. Sidecars share the directory:
// <id>.meta.json, <id>.checkpoints.jsonl, <id>.prompts.jsonl.
//
// Only two record shapes carry anything we need (verified against a real
// store): the header, and `{type:"message", id, parentId, timestamp,
// message:{role, meta:{messageId}}, usage:{...}, model}`. A successful model
// call is the one with `usage`; prompts and replies both carry a stable
// `message.meta.messageId` (an API UUID) we can deduplicate copied transcripts
// on.
//
// Token semantics are OpenAI-style, not Anthropic-style: `inputTokens` is the
// TOTAL prompt count and already contains the cache reads and writes that are
// reported alongside it, so uncached input is `inputTokens - cacheReadTokens -
// cacheWriteTokens`. Verified by reconstructing `costUsd` from the catalog
// rates for every assistant record in a live store (exact to 1e-9). We still
// recompute from tokens — `costUsd` is a funding-path figure and is never used
// (see the cost-accounting invariant).
//
// Cache writes have no TTL split anywhere in the store, so they land in the 5m
// bucket (the cheaper multiplier), matching every parser that cannot tell the
// two apart.
const SOURCE = 'commandcode';
const PROJECTS = 'projects';
const SIDECAR_SUFFIXES = ['.checkpoints.jsonl', '.prompts.jsonl'];

/** Reduce a root's projects/ tree to the transcript files it holds. */
function findTranscripts(root, onWarning, onFatal) {
  const projectsDir = join(root, PROJECTS);
  if (!existsSync(projectsDir)) return [];
  const files = [];
  let projectDirs;
  try {
    projectDirs = readdirSync(projectsDir, { withFileTypes: true });
  } catch (err) {
    onFatal(`commandcode: 无法读取目录 ${projectsDir}: ${err.message}`);
    return files;
  }
  for (const entry of projectDirs) {
    if (!entry.isDirectory()) continue;
    const dir = join(projectsDir, entry.name);
    let children;
    try {
      children = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      onFatal(`commandcode: 无法读取会话目录 ${dir}: ${err.message}`);
      continue;
    }
    for (const child of children) {
      if (!child.isFile() || !child.name.endsWith('.jsonl')) continue;
      if (SIDECAR_SUFFIXES.some(suffix => child.name.endsWith(suffix))) continue;
      files.push(join(dir, child.name));
    }
  }
  return files;
}

function parseTimestamp(obj) {
  const iso = typeof obj?.timestamp === 'string' ? Date.parse(obj.timestamp) : NaN;
  if (Number.isFinite(iso)) return new Date(iso);
  const created = obj?.message?.meta?.createdAt;
  if (Number.isFinite(created)) return new Date(created);
  return null;
}

/** API-call identity, used to collapse retries and copied (fork/clone) records. */
function callIdentity(obj) {
  const messageId = obj?.message?.meta?.messageId;
  if (typeof messageId === 'string' && messageId.trim()) return messageId.trim();
  const ownId = typeof obj?.id === 'string' ? obj.id.trim() : '';
  return ownId || null;
}

/** One usage-bearing assistant message as a Track-1 entry. */
function usageEntry(obj, project, timestamp) {
  const usage = obj?.usage;
  if (!usage || (obj?.message?.role) !== 'assistant') return null;

  const cacheRead = toCount(usage.cacheReadTokens);
  const cacheWrite = toCount(usage.cacheWriteTokens);
  const totalInput = toCount(usage.inputTokens);
  // inputTokens is the total prompt count: remove the cached subsets so the
  // bucket schema's inputTokens stays uncached-only and nothing double counts.
  const inputTokens = Math.max(0, totalInput - cacheRead - cacheWrite);
  const outputTokens = toCount(usage.outputTokens);
  if (!inputTokens && !outputTokens && !cacheRead && !cacheWrite) return null;

  const model = typeof obj.model === 'string' && obj.model.trim() ? obj.model.trim() : 'unknown';
  return {
    dedupeKey: callIdentity(obj),
    usageScore: totalInput + outputTokens,
    entry: {
      source: SOURCE,
      // Command Code model ids are the catalog ids the server prices verbatim
      // (`deepseek/deepseek-v4.1-flash`, `claude-sonnet-4-6`, …); never namespace
      // them — a prefix would stop them matching their own price.
      model,
      project,
      timestamp,
      inputTokens,
      outputTokens,
      cachedInputTokens: cacheRead,
      reasoningOutputTokens: 0,
      cacheCreation5mTokens: cacheWrite,
    },
  };
}

export async function parse() {
  const warnings = [];
  const onWarning = message => warnings.push(message);
  let skipped = false;
  const onFatal = message => {
    skipped = true;
    warnings.push(message);
  };

  const roots = getCommandcodeRoots();
  const files = roots.flatMap(root => findTranscripts(root, onWarning, onFatal)).sort();

  const byKey = new Map();
  const anonymous = [];
  const events = [];
  const seenEvents = new Set();

  for (const file of files) {
    const slug = basename(file, '.jsonl');
    const folder = basename(join(file, '..'));
    // The header carries cwd, but fall back to the slug when a transcript is
    // truncated before its header: last '-' segment of `private-tmp-my-project`.
    const fallbackProject = folder.split('-').filter(Boolean).at(-1) || 'unknown';
    let sessionId = slug;
    let project = fallbackProject;
    let assistantCount = 0;
    let usageCount = 0;
    let stream;
    try {
      stream = createReadStream(file);
      const lines = createInterface({ input: stream, crlfDelay: Infinity });
      for await (const line of lines) {
        if (!line.trim()) continue;
        let obj;
        // Command Code itself skips corrupt lines, so a bad line is expected
        // drift, not a reason to distrust the rest of the file.
        try { obj = JSON.parse(line); } catch { continue; }
        if (!obj || typeof obj !== 'object') continue;

        if (obj.type === 'session') {
          if (typeof obj.id === 'string' && obj.id) sessionId = obj.id;
          const cwdProject = projectFromCwd(obj.cwd);
          if (cwdProject !== 'unknown') project = cwdProject;
          continue;
        }

        if (obj.type !== 'message') continue;
        const role = obj.message?.role;
        if (role !== 'user' && role !== 'assistant') continue;
        const timestamp = parseTimestamp(obj);
        if (!timestamp) continue;

        const identity = callIdentity(obj);
        // A forked/cloned transcript replays the source messages verbatim
        // (same API UUID). Count each call once, attributed to the first file
        // in sorted order, so a copy does not inflate either track.
        const eventKey = identity ? `event:${identity}` : null;
        if (!eventKey || !seenEvents.has(eventKey)) {
          if (eventKey) seenEvents.add(eventKey);
          events.push({ sessionId, source: SOURCE, project, timestamp, role });
        }

        if (role !== 'assistant') continue;
        assistantCount++;
        const parsed = usageEntry(obj, project, timestamp);
        if (!parsed) continue;
        usageCount++;
        if (!parsed.dedupeKey) anonymous.push(parsed.entry);
        else {
          const current = byKey.get(parsed.dedupeKey);
          if (!current || parsed.usageScore > current.usageScore) byKey.set(parsed.dedupeKey, parsed.entry);
        }
      }
    } catch (err) {
      // An unreadable transcript means this source's snapshot is incomplete:
      // skip the source so its previous upload state is not pruned.
      onFatal(`commandcode: 无法读取会话 ${file}: ${err.message}`);
    } finally {
      stream?.close();
    }

    // Format canary: the store moved on and no longer attaches usage to
    // assistant replies (or the fields were renamed). An empty collection is
    // otherwise indistinguishable from an idle machine.
    if (assistantCount > 0 && usageCount === 0) {
      onWarning(`commandcode: 会话 ${file} 有 assistant 回复但无 usage，可能格式已变`);
    }
  }

  const entries = [...anonymous, ...byKey.values()];
  const buckets = aggregateToBuckets(entries);
  const sessions = extractSessions(events);
  return skipped
    ? { buckets: [], sessions: [], skipped: true, warnings }
    : { buckets, sessions, warnings };
}
