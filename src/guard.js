import fs from 'node:fs';
import { resolveInstall } from './paths.js';

// The desktop app refuses to start when a debugging switch such as
// --remote-debugging-port is present on the command line. This is a single
// boolean check in the bundled main process:
//
//   var X = guard(h.app.isPackaged && ENV!=="dev", process.argv, process.execArgv);
//   X ? (log + app.exit(1)) : start()
//
// Names change between releases (1.18 used wg/P, 1.19 uses zm/k), so match the
// stable shape instead of exact identifiers. We flip the condition to false with
// a byte-for-byte, same-length replacement so the archive header and its
// integrity hashes stay intact.
const GUARD_PATTERN = /h\.app\.isPackaged&&[A-Za-z_$][\w$]*!=="dev"/g;
const PATCHED_PATTERN = /!1 {2,},process\.argv,process\.execArgv\)/;

function readAsar(file) {
  return fs.readFileSync(file);
}

export function guardStatus(install = resolveInstall()) {
  const text = readAsar(install.asarPath).toString('latin1');
  PATCHED_PATTERN.lastIndex = 0;
  if (PATCHED_PATTERN.test(text)) return { state: 'patched', ...install };
  GUARD_PATTERN.lastIndex = 0;
  if (GUARD_PATTERN.test(text)) return { state: 'unpatched', ...install };
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
  GUARD_PATTERN.lastIndex = 0;
  const matches = [...buf.toString('latin1').matchAll(GUARD_PATTERN)];
  if (matches.length === 0) throw new Error('Guard signature disappeared while patching.');
  if (matches.length > 1) throw new Error('Guard signature is not unique; refusing to patch.');

  const { index, 0: signature } = matches[0];
  const replacement = `!1${' '.repeat(signature.length - 2)}`;

  const backupPath = `${install.asarPath}.driver-backup`;
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(install.asarPath, backupPath);
  }

  const patched = Buffer.from(buf);
  patched.write(replacement, index, 'latin1');
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

  return { changed: true, state: 'patched', offset: index, backupPath, ...install };
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
