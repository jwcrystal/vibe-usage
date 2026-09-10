import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join, basename } from 'node:path';
import { homedir } from 'node:os';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';

const DATA_DIR = join(homedir(), '.local', 'share', 'opencode');
const MESSAGES_DIR = join(DATA_DIR, 'storage', 'message');

// OpenCode records `path.root` (the git/project root) on most sessions, but for
// sessions outside a git repo — or ones whose root was never written — `root` is
// null or "/". `path.cwd` is always populated and points at the real project dir,
// so fall back to it to avoid collapsing such sessions into "unknown".
export function resolveProject(rootPath, cwdPath) {
  const root = rootPath && rootPath !== '/' ? rootPath : cwdPath;
  const name = root ? basename(root) : '';
  return name || 'unknown';
}

/** Return the most recently modified OpenCode database in the data directory. */
export function findActiveDatabase(dataDir = DATA_DIR) {
  let entries;
  try {
    entries = readdirSync(dataDir, { withFileTypes: true });
  } catch {
    return undefined;
  }

  let active;
  let activeModified = -Infinity;
  for (const entry of entries) {
    if (!entry.isFile() || !/^opencode.*\.db$/.test(entry.name)) continue;
    const dbPath = join(dataDir, entry.name);
    try {
      const modified = statSync(dbPath).mtimeMs;
      if (modified > activeModified) {
        active = dbPath;
        activeModified = modified;
      }
    } catch {
      // A database can disappear while OpenCode rotates its data files.
    }
  }
  return active;
}

/**
 * Parse opencode usage data.
 * Tries SQLite database first (opencode >= v0.2), falls back to legacy JSON files.
 */
export async function parse() {
  const dbPath = findActiveDatabase();
  if (dbPath) {
    try {
      return parseFromSqlite(dbPath);
    } catch (err) {
      process.stderr.write(`warn: opencode sqlite parse failed (${err.message}), trying legacy json...\n`);
    }
  }
  return parseFromJson();
}

function parseFromSqlite(dbPath) {
  const query = `SELECT
    session_id as sessionID,
    json_extract(data, '$.role') as role,
    json_extract(data, '$.time.created') as created,
    json_extract(data, '$.modelID') as modelID,
    json_extract(data, '$.tokens') as tokens,
    json_extract(data, '$.path.root') as rootPath,
    json_extract(data, '$.path.cwd') as cwdPath
    FROM message`;

  let rows;
  try {
    rows = queryDbJson(dbPath, query);
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('OpenCode');
    throw err;
  }
  if (!rows.length) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];
  for (const row of rows) {
    const timestamp = new Date(row.created);
    if (isNaN(timestamp.getTime())) continue;

    const project = resolveProject(row.rootPath, row.cwdPath);
    const sessionId = row.sessionID || 'unknown';

    sessionEvents.push({
      sessionId,
      source: 'opencode',
      project,
      timestamp,
      role: row.role === 'user' ? 'user' : 'assistant',
    });

    if (!row.modelID) continue;
    let tokens;
    try {
      tokens = typeof row.tokens === 'string' ? JSON.parse(row.tokens) : row.tokens;
    } catch {
      continue;
    }
    if (!tokens || (!tokens.input && !tokens.output)) continue;

    entries.push({
      source: 'opencode',
      model: row.modelID || 'unknown',
      project,
      timestamp,
      inputTokens: tokens.input || 0,
      outputTokens: tokens.output || 0,
      cachedInputTokens: tokens.cache?.read || 0,
      reasoningOutputTokens: tokens.reasoning || 0,
    });
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}

function parseFromJson() {
  if (!existsSync(MESSAGES_DIR)) return { buckets: [], sessions: [] };

  const entries = [];
  const sessionEvents = [];
  let sessionDirs;
  try {
    sessionDirs = readdirSync(MESSAGES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && d.name.startsWith('ses_'));
  } catch {
    return { buckets: [], sessions: [] };
  }

  for (const sessionDir of sessionDirs) {
    const sessionPath = join(MESSAGES_DIR, sessionDir.name);
    let msgFiles;
    try {
      msgFiles = readdirSync(sessionPath).filter(f => f.endsWith('.json'));
    } catch {
      continue;
    }

    for (const file of msgFiles) {
      const filePath = join(sessionPath, file);

      let data;
      try {
        data = JSON.parse(readFileSync(filePath, 'utf-8'));
      } catch {
        continue;
      }

      const timestamp = new Date(data.time?.created);
      if (isNaN(timestamp.getTime())) continue;

      const rootPath = data.path?.root;
      const project = resolveProject(rootPath, data.path?.cwd);

      sessionEvents.push({
        sessionId: sessionDir.name,
        source: 'opencode',
        project,
        timestamp,
        role: data.role === 'user' ? 'user' : 'assistant',
      });

      if (!data.modelID) continue;
      const tokens = data.tokens;
      if (!tokens) continue;
      if (!tokens.input && !tokens.output) continue;

      entries.push({
        source: 'opencode',
        model: data.modelID || 'unknown',
        project,
        timestamp,
        inputTokens: tokens.input || 0,
        outputTokens: tokens.output || 0,
        cachedInputTokens: tokens.cache?.read || 0,
        reasoningOutputTokens: tokens.reasoning || 0,
      });
    }
  }

  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(sessionEvents) };
}
