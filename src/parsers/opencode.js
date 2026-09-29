import { readdirSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { aggregateToBuckets, extractSessions } from './aggregate.js';
import { queryDbJson, sqliteUnavailableError, isSqliteUnavailableError } from './sqlite.js';
import { getOpenCodeStores } from '../opencode-roots.js';

function readSqlite(path) {
  // Select only accounting/timing metadata, never message text or tool inputs.
  // Keep the existing top-level model/project precedence for old uploads.
  try {
    const tables = new Set(queryDbJson(path,
      "SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
    const rows = [];
    if (tables.has('message')) {
      const query = `SELECT id, session_id AS sessionID,
        json_extract(data, '$.role') AS role,
        json_extract(data, '$.time.created') AS created,
        coalesce(json_extract(data, '$.modelID'), json_extract(data, '$.model.modelID')) AS modelID,
        json_extract(data, '$.tokens') AS tokens,
        json_extract(data, '$.path.root') AS rootPath
        FROM message ORDER BY id`;
      rows.push(...queryDbJson(path, query));
    }
    if (tables.has('session_message')) {
      if (!tables.has('session_v2')) throw new Error('V2 session_v2 table is missing');
      const query = `SELECT m.id, m.session_id AS sessionID, m.type AS role,
        m.time_created AS created,
        coalesce(json_extract(m.data, '$.model.id'), json_extract(m.data, '$.model.modelID')) AS modelID,
        json_extract(m.data, '$.tokens') AS tokens,
        coalesce(json_extract(m.data, '$.path.root'), s.directory) AS rootPath,
        1 AS v2
        FROM session_message AS m
        LEFT JOIN session_v2 AS s ON s.id = m.session_id
        WHERE m.type IN ('user', 'assistant')
        ORDER BY m.time_created, m.seq`;
      rows.push(...queryDbJson(path, query));
    }
    if (rows.length === 0 && !tables.has('message') && !tables.has('session_message')) {
      throw new Error('找不到支援的資料表 (message/session_message)');
    }
    return rows;
  } catch (err) {
    if (isSqliteUnavailableError(err)) throw sqliteUnavailableError('OpenCode');
    throw err;
  }
}

function readJson(path) {
  const rows = [];
  for (const dir of readdirSync(path, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith('ses_')) continue;
    const sessionPath = join(path, dir.name);
    for (const file of readdirSync(sessionPath).sort()) {
      if (!file.endsWith('.json')) continue;
      const data = JSON.parse(readFileSync(join(sessionPath, file), 'utf8'));
      rows.push({ id: data.id || basename(file, '.json'), sessionID: dir.name,
        role: data.role, created: data.time?.created,
        modelID: data.modelID || data.model?.modelID,
        tokens: data.tokens, rootPath: data.path?.root });
    }
  }
  return rows;
}

function tokenSize(row) {
  const t = row.tokens;
  return ['input', 'output', 'reasoning'].reduce((n, key) => n + (Number(t?.[key]) || 0), 0)
    + (Number(t?.cache?.read) || 0) + (Number(t?.cache?.write) || 0);
}

export async function parse({ extraRoots = [] } = {}) {
  const warnings = [];
  const stores = getOpenCodeStores({ extraRoots, onWarning: message => warnings.push(message) });
  const records = new Map();
  for (const store of stores) {
    try {
      const rows = store.kind === 'sqlite' ? readSqlite(store.path) : readJson(store.path);
      for (const [index, row] of rows.entries()) {
        const timestamp = new Date(row.created);
        if (!Number.isFinite(timestamp.getTime())) continue;
        if (typeof row.tokens === 'string') row.tokens = JSON.parse(row.tokens);
        const sessionId = row.sessionID || 'unknown';
        // Message ids are unique within an OpenCode session. Across stores,
        // keep the most complete copy; never dedup unrelated equal-sized calls.
        // Missing ids cannot prove that two stores hold the same record.
        const key = JSON.stringify([sessionId, row.id || `${store.path}:${index}`]);
        const old = records.get(key);
        const rowSize = tokenSize(row);
        const oldSize = old ? tokenSize(old) : -1;
        const preferRow = !old || rowSize > oldSize || (rowSize === oldSize && row.v2 && !old.v2);
        if (old && (row.v2 !== old.v2)) {
          const v1 = row.v2 ? old : row;
          const v2 = row.v2 ? row : old;
          const v1Root = v1.rootPath && basename(v1.rootPath) ? v1.rootPath : undefined;
          const rootPath = v1Root || v2.rootPath || v1.rootPath;
          const modelID = v1.modelID || v2.modelID;
          if (preferRow) records.set(key, { ...row, modelID, rootPath, timestamp, sessionId });
          else if (rootPath !== old.rootPath || modelID !== old.modelID) {
            records.set(key, { ...old, modelID, rootPath, timestamp, sessionId });
          }
        } else if (preferRow) records.set(key, { ...row, timestamp, sessionId });
      }
    } catch (err) { warnings.push(`OpenCode: 無法讀取 ${store.path}: ${err.message}`); }
  }
  if (warnings.length) return { buckets: [], sessions: [], skipped: true, warnings };

  const entries = [], events = [];
  for (const row of records.values()) {
    // Keep the existing project derivation and token semantics. Additional roots
    // must not rename previously uploaded projects/models or alter their counts.
    const project = row.rootPath ? basename(row.rootPath) : 'unknown';
    const base = { source: 'opencode', project, timestamp: row.timestamp };
    events.push({ ...base, sessionId: row.sessionId, role: row.role === 'user' ? 'user' : 'assistant' });
    const tokens = row.tokens;
    if (!row.modelID || !tokens || (!tokens.input && !tokens.output && !tokens.reasoning && !tokens.cache?.write)) continue;
    entries.push({ ...base, model: row.modelID,
      inputTokens: tokens.input || 0, outputTokens: tokens.output || 0,
      cachedInputTokens: tokens.cache?.read || 0, reasoningOutputTokens: tokens.reasoning || 0,
      cacheCreation5mTokens: tokens.cache?.write || 0 });
  }
  return { buckets: aggregateToBuckets(entries), sessions: extractSessions(events) };
}
