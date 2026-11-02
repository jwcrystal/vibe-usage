// Shared command-discovery rules for the quota providers.
//
// Two callers need the same answer to "is this tool installed?": the registry's
// presence checks (PATH lookup by name) and the Claude probe's binary search
// (named directories plus a few spelled-out install prefixes). They kept
// separate copies of the Windows rules, and the probe's copy was missing
// PATHEXT — so `claude.cmd`, the form npm installs on Windows, was invisible and
// a Windows machine with a healthy CLI reported as not installed.
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';

// The default Windows executable suffixes, used when PATHEXT is unset (a GUI
// app or a service can start with a minimal environment).
const WINDOWS_DEFAULT_PATHEXT = '.COM;.EXE;.BAT;.CMD';

/**
 * PATH-style delimiter for the platform. `node:path`'s `delimiter` already
 * follows the running platform, but the callers take an explicit `platform`
 * (tests drive win32 on macOS), so the two must not disagree.
 */
export function pathDelimiter(platform = process.platform) {
  return platform === 'win32' ? ';' : delimiter;
}

/**
 * Candidate file names for `name` on this platform: the bare name, plus every
 * PATHEXT suffix in its declared case and lowercase (`claude`, `claude.EXE`,
 * `claude.exe`, …). Only Windows expands; elsewhere the bare name is the rule.
 */
export function executableNames(name, { environment = process.env, platform = process.platform } = {}) {
  if (platform !== 'win32') return [name];
  const extensions = (environment.PATHEXT || WINDOWS_DEFAULT_PATHEXT)
    .split(';')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value => (value.startsWith('.') ? value : `.${value}`));
  const names = [name];
  for (const extension of extensions) {
    names.push(`${name}${extension}`, `${name}${extension.toLowerCase()}`);
  }
  return names;
}

/**
 * Is this exact path a runnable command? Windows has no POSIX execute bits, so
 * file presence plus a PATHEXT suffix is its ordinary rule; elsewhere the
 * execute bit is what makes a file a command.
 */
export function isExecutable(path, platform = process.platform) {
  try {
    accessSync(path, platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** The first candidate name found in `directories`, or null. */
export function findExecutableInDirectories(name, directories, { environment = process.env, platform = process.platform } = {}) {
  const candidates = executableNames(name, { environment, platform });
  for (const directory of directories) {
    for (const candidate of candidates) {
      const path = join(directory, candidate);
      if (isExecutable(path, platform)) return path;
    }
  }
  return null;
}

/** Is `name` on PATH? */
export function executableExists(name, environment = process.env, platform = process.platform) {
  const directories = (environment.PATH || '').split(pathDelimiter(platform)).filter(Boolean);
  return findExecutableInDirectories(name, directories, { environment, platform }) !== null;
}
