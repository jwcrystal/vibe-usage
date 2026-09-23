import { accessSync, constants, readdirSync, realpathSync, statSync } from 'node:fs';
import { delimiter, join } from 'node:path';
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

// SQLite wins within each root; JSON is the legacy alternative, not a second
// copy of the same migrated history. A failed SQLite read must protect state.
// Several databases can share one data directory (split stores, rotated or
// channel builds): every readable opencode*.db is its own store. The
// downstream per-message dedup keeps the most complete copy across them.
export function openCodeStores(root) {
  let entries;
  try {
    entries = readdirSync(root, { withFileTypes: true });
  } catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return [];
    throw err;
  }
  const stores = [];
  const names = entries
    .filter(entry => entry.isFile() && /^opencode.*\.db$/.test(entry.name))
    .map(entry => entry.name)
    .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  for (const name of names) {
    const db = join(root, name);
    if (!readable(db, false)) continue;
    stores.push({ kind: 'sqlite', path: db });
  }
  if (stores.length > 0) return stores;
  const messages = join(root, 'storage', 'message');
  if (readable(messages, true)) return [{ kind: 'json', path: messages }];
  return [];
}

export function getOpenCodeStores({ extraRoots = [], onWarning = () => {} } = {}) {
  const override = process.env.VIBE_USAGE_OPENCODE_DIRS?.trim();
  const defaults = override ? override.split(delimiter).map(p => p.trim()).filter(Boolean)
    : [join(homedir(), '.local', 'share', 'opencode')];
  const seen = new Set(), stores = [];
  for (const root of [...defaults, ...extraRoots]) {
    try {
      const found = openCodeStores(root);
      if (found.length === 0 && extraRoots.includes(root)) {
        onWarning(`OpenCode: 额外目录缺少 opencode.db 或 storage/message/: ${root}`);
      }
      for (const store of found) {
        const canonical = realpathSync(store.path);
        if (seen.has(canonical)) continue;
        seen.add(canonical);
        stores.push({ ...store, path: canonical });
      }
    } catch (err) { onWarning(`OpenCode: 无法读取数据目录 ${root}: ${err.message}`); }
  }
  return stores;
}
