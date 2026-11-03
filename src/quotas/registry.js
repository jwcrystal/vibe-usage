import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { loadCachedQuota, saveCachedQuota } from './cache.js';
import { executableExists } from './executables.js';
import { codexQuotaDetected, fetchCodexQuota } from './providers/codex.js';
import { claudeCredentialsPresent, fetchClaudeCodeQuota, findClaudeBinary } from './providers/claude-code.js';
import { fetchCommandcodeQuota } from './providers/commandcode.js';
import { fetchGrokQuota } from './providers/grok.js';
import { fetchKimiCodeQuota } from './providers/kimi-code.js';
import { fetchOpenCodeGoQuota } from './providers/opencode-go.js';
import { fetchZaiQuota } from './providers/zai.js';
import { FETCHABLE_QUOTA_PRODUCT_IDS, quotaEnvelope, quotaResult } from './schema.js';

const providers = new Map([
  ['codex', fetchCodexQuota],
  ['kimi-code', fetchKimiCodeQuota],
  ['zcode', fetchZaiQuota],
  ['grok', fetchGrokQuota],
  ['opencode-go', fetchOpenCodeGoQuota],
  ['commandcode', fetchCommandcodeQuota],
  ['claude-code', fetchClaudeCodeQuota],
]);

export function discoverQuotaProducts({
  environment = process.env,
  home = homedir(),
  platform = process.platform,
} = {}) {
  const applications = platform === 'darwin'
    ? ['/Applications', join(home, 'Applications')] : [];
  const existsAny = paths => paths.some(path => existsSync(path));
  const configuredGrokHome = environment.GROK_HOME?.trim();
  const grokHome = configuredGrokHome
    ? configuredGrokHome.replace(/^~(?=$|[\\/])/, home)
    : join(home, '.grok');
  return quotaEnvelope([
    {
      id: 'codex',
      detected: codexQuotaDetected(environment, home),
      fetchable: true,
    },
    {
      id: 'kimi-code',
      detected: existsAny([join(home, '.kimi'), join(home, '.kimi-code')])
        || executableExists('kimi', environment, platform),
      fetchable: true,
    },
    {
      id: 'zcode',
      detected: existsAny([join(home, '.zcode'), join(home, '.config', 'zcode'),
        ...applications.map(path => join(path, 'ZCode.app'))])
        || executableExists('zcode', environment, platform),
      fetchable: true,
    },
    {
      id: 'grok',
      detected: existsAny([grokHome]) || executableExists('grok', environment, platform),
      fetchable: true,
    },
    {
      id: 'opencode-go',
      detected: existsAny([join(home, '.local', 'share', 'opencode')])
        || executableExists('opencode', environment, platform),
      fetchable: true,
    },
    {
      // File-existence only: discovery checks for CommandCode's own auth file
      // and never opens or reads it (a bare `~/.commandcode` directory is not
      // a presence signal); the fetch path checks the key.
      id: 'commandcode',
      detected: existsSync(join(home, '.commandcode', 'auth.json')),
      fetchable: true,
    },
    {
      id: 'claude-code',
      // Either a binary (whose probe can also refresh the login) or a readable
      // login is enough: the OAuth route needs no CLI. Presence includes the
      // macOS Keychain, where Claude Code keeps the login on that platform —
      // its metadata is readable without an ACL prompt, so a Keychain-only
      // machine is detected instead of reporting 未偵測到.
      detected: findClaudeBinary({ environment, home }) !== null
        || claudeCredentialsPresent({ environment, home }),
      fetchable: true,
    },
    {
      id: 'cursor',
      detected: existsAny([join(home, '.cursor'),
        ...applications.map(path => join(path, 'Cursor.app'))])
        || executableExists('cursor', environment, platform),
      fetchable: false,
    },
  ]);
}

export async function fetchQuotaProducts(ids, options = {}) {
  const unique = [...new Set(ids)];
  const invalid = unique.filter(id => !FETCHABLE_QUOTA_PRODUCT_IDS.includes(id));
  if (invalid.length) throw new Error(`Unsupported quota product: ${invalid.join(', ')}`);

  const fetched = await Promise.all(unique.map(async id => {
    try {
      return await providers.get(id)(options);
    } catch {
      return quotaResult({ id, status: 'retryable_error', message: 'Provider failed unexpectedly' });
    }
  }));
  const results = fetched.map(result => {
    if (result.status === 'ok') {
      saveCachedQuota(result, result.cacheScope, options.environment);
      return result;
    }
    if (result.status === 'retryable_error') {
      return loadCachedQuota(
        result.id,
        result.cacheScope,
        options.environment,
        options.now || new Date()
      ) || result;
    }
    return result;
  });
  return quotaEnvelope(results);
}
