import fs from 'node:fs';
import { resolveInstall } from './paths.js';

// The desktop app refuses to start when a debugging switch such as
// --remote-debugging-port is present on the command line. This is a single
// boolean check in the bundled main process:
//
//   var Pg = wg(h.app.isPackaged && P!=="dev", process.argv, process.execArgv);
//   Pg ? (log + app.exit(1)) : start()
//
// We flip the first argument to false with a byte-for-byte replacement of the
// same length, so the archive header (and its integrity hashes) stay intact.
const NEEDLE = 'wg(h.app.isPackaged&&P!=="dev",process.argv,process.execArgv)';
const COMMA = NEEDLE.indexOf(',');
const PATCHED = `wg(!1${' '.repeat(COMMA - 5)}${NEEDLE.slice(COMMA)}`;

function readAsar(file) {
  return fs.readFileSync(file);
}

export function guardStatus(install = resolveInstall()) {
  const buf = readAsar(install.asarPath);
  const text = buf.toString('latin1');
  if (text.includes(PATCHED)) return { state: 'patched', ...install };
  if (text.includes(NEEDLE)) return { state: 'unpatched', ...install };
  return { state: 'unknown', ...install };
}

export function applyGuard(install = resolveInstall()) {
  const status = guardStatus(install);
  if (status.state === 'patched') return { changed: false, ...status };
  if (status.state === 'unknown') {
    throw new Error(
      `Unsupported Gemini build ${install.version}: the debug-switch guard signature was not found in app.asar. ` +
        'Update gemini-app-driver for this version.',
    );
  }

  const buf = readAsar(install.asarPath);
  const offset = buf.indexOf(NEEDLE, 0, 'latin1');
  if (offset === -1) throw new Error('Guard signature disappeared while patching.');
  if (buf.indexOf(NEEDLE, offset + 1, 'latin1') !== -1) {
    throw new Error('Guard signature is not unique; refusing to patch.');
  }

  const backupPath = `${install.asarPath}.driver-backup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(install.asarPath, backupPath);
  }

  const patched = Buffer.from(buf);
  patched.write(PATCHED, offset, 'latin1');
  const tmp = `${install.asarPath}.driver-tmp`;
  try {
    fs.writeFileSync(tmp, patched);
    fs.renameSync(tmp, install.asarPath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new Error(
      `Could not patch app.asar (${error.message}). Close Gemini completely and retry.`,
    );
  }

  return { changed: true, state: 'patched', offset, backupPath, ...install };
}

export function restoreGuard(install = resolveInstall()) {
  const backupPath = `${install.asarPath}.driver-backup`;
  if (!fs.existsSync(backupPath)) {
    return { changed: false, state: guardStatus(install).state, ...install };
  }
  const tmp = `${install.asarPath}.driver-tmp`;
  try {
    fs.copyFileSync(backupPath, tmp);
    fs.renameSync(tmp, install.asarPath);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw new Error(
      `Could not restore app.asar (${error.message}). Close Gemini completely and retry.`,
    );
  }
  fs.rmSync(backupPath, { force: true });
  return { changed: true, state: 'unpatched', ...install };
}
