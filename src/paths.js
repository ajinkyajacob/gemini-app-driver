import fs from 'node:fs';
import path from 'node:path';

export const APP_NAME = 'Gemini';

export function geminiRoot() {
  const localAppData = process.env.LOCALAPPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Local');
  return path.join(localAppData, 'Google', APP_NAME);
}

export function userDataDir() {
  const appData = process.env.APPDATA || path.join(process.env.USERPROFILE || '', 'AppData', 'Roaming');
  return path.join(appData, APP_NAME);
}

function parseVersion(name) {
  return name.split('.').map((part) => Number.parseInt(part, 10));
}

function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const diff = (left[i] || 0) - (right[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

export function findVersionDir(root = geminiRoot()) {
  if (!fs.existsSync(root)) {
    throw new Error(`Gemini desktop app is not installed (missing ${root}).`);
  }
  const versions = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^app-\d+\.\d+\.\d+$/.test(entry.name))
    .map((entry) => ({ name: entry.name, version: entry.name.slice(4), dir: path.join(root, entry.name) }))
    .sort((a, b) => compareVersions(a.version, b.version));

  if (versions.length === 0) {
    throw new Error(`No app-<version> directory found in ${root}.`);
  }
  return versions[versions.length - 1];
}

export function resolveInstall() {
  const root = geminiRoot();
  const versionDir = findVersionDir(root);
  const asarPath = path.join(versionDir.dir, 'resources', 'app.asar');
  if (!fs.existsSync(asarPath)) {
    throw new Error(`app.asar not found at ${asarPath}.`);
  }
  return {
    root,
    version: versionDir.version,
    versionDir: versionDir.dir,
    asarPath,
    launcherExe: path.join(root, 'Gemini.exe'),
    appExe: path.join(versionDir.dir, 'Gemini.exe'),
    userDataDir: userDataDir(),
  };
}
