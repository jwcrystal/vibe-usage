import { accessSync, constants, realpathSync, statSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { homedir } from 'node:os';

function readable(path, directory) {
  try {
    const stat = statSync(path);
    if (directory ? !stat.isDirectory() : !stat.isFile()) throw new Error(`格式不正确: ${path}`);
    accessSync(path, constants.R_OK);
    return true;
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return false;
    throw err;
  }
}

// SQLite wins within each store; JSON is the legacy alternative, not a second
// copy of the same migrated history. A failed SQLite read must protect state.
export function openCodeStore(root) {
  const db = join(root, 'opencode.db');
  if (readable(db, false)) return { kind: 'sqlite', path: db };
  const messages = join(root, 'storage', 'message');
  if (readable(messages, true)) return { kind: 'json', path: messages };
  return null;
}

export function getOpenCodeStores({ extraRoots = [], onWarning = () => {} } = {}) {
  const override = process.env.VIBE_USAGE_OPENCODE_DIRS?.trim();
  const databaseOverride = process.env.OPENCODE_DB?.trim();
  // OpenCode uses xdg-basedir on every OS, including Windows. Do not substitute
  // APPDATA: its data root is XDG_DATA_HOME or <home>/.local/share.
  const defaults = override ? override.split(delimiter).map(p => p.trim()).filter(Boolean)
    : [join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'opencode')];
  const seen = new Set(), stores = [];
  // OPENCODE_DB points at one authoritative database (e.g. a rotated or
  // relocated opencode database outside the default roots). While it is set,
  // default roots are not scanned, and a broken override leaves the store
  // list empty so the parser skips the source and protects previously
  // uploaded state instead of syncing stale stores.
  let activeDatabase;
  if (databaseOverride) {
    try {
      if (!readable(databaseOverride, false)) throw new Error(`資料庫不存在: ${databaseOverride}`);
      activeDatabase = realpathSync(databaseOverride);
    } catch (err) { onWarning(`OpenCode: 無法讀取資料庫 ${databaseOverride}: ${err.message}`); }
  }
  const roots = databaseOverride ? extraRoots : [...defaults, ...extraRoots];
  for (const root of roots) {
    try {
      const store = openCodeStore(root);
      if (!store) {
        if (extraRoots.includes(root)) onWarning(`OpenCode: 额外目录缺少 opencode.db 或 storage/message/: ${root}`);
        continue;
      }
      const canonical = realpathSync(store.path);
      // The active database supersedes a legacy JSON store in its directory:
      // that JSON copy is the pre-migration history of the same database.
      if (store.kind === 'json' && activeDatabase
        && realpathSync(dirname(dirname(store.path))) === dirname(activeDatabase)) continue;
      if (seen.has(canonical)) continue;
      seen.add(canonical);
      stores.push({ ...store, path: canonical });
    } catch (err) { onWarning(`OpenCode: 无法读取数据目录 ${root}: ${err.message}`); }
  }
  if (activeDatabase && !seen.has(activeDatabase)) {
    seen.add(activeDatabase);
    stores.push({ kind: 'sqlite', path: activeDatabase });
  }
  return stores;
}
