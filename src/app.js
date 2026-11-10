import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { applyGuard, guardStatus, restoreGuard } from './guard.js';
import { resolveInstall } from './paths.js';

const execFileAsync = promisify(execFile);

export const DEFAULT_PORT = Number(process.env.GEMINI_DRIVER_PORT || 9333);
const CDP_HOST = '127.0.0.1';

export function cdpUrl(port, pathname = '/json/version') {
  return `http://${CDP_HOST}:${port}${pathname}`;
}

export async function fetchJson(url, timeoutMs = 1500) {
  const response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw new Error(`HTTP ${response.status} for ${url}`);
  return response.json();
}

export async function listTargets(port) {
  return fetchJson(cdpUrl(port, '/json/list'), 3000);
}

export async function findGeminiTarget(port) {
  const targets = await listTargets(port);
  return targets.find((target) => target.type === 'page' && target.url.startsWith('https://gemini.google.com')) || null;
}

export async function isCdpAlive(port) {
  try {
    const version = await fetchJson(cdpUrl(port), 1500);
    if (!version?.webSocketDebuggerUrl) return false;
    return Boolean(await findGeminiTarget(port));
  } catch {
    return false;
  }
}

async function portOwner(port) {
  try {
    const version = await fetchJson(cdpUrl(port), 1000);
    return version?.Browser || 'another debugger';
  } catch {
    return null;
  }
}

async function assertPortAvailable(port) {
  const owner = await portOwner(port);
  if (!owner) return;
  throw new Error(
    `Port ${port} is already in use by ${owner}. Set GEMINI_DRIVER_PORT to a free port and retry.`,
  );
}

export async function isRunning() {
  try {
    const { stdout } = await execFileAsync('tasklist', ['/FI', 'IMAGENAME eq Gemini.exe', '/FO', 'CSV', '/NH'], {
      windowsHide: true,
    });
    return stdout.toLowerCase().includes('gemini.exe');
  } catch {
    return false;
  }
}

async function taskkill(args) {
  try {
    await execFileAsync('taskkill', args, { windowsHide: true });
  } catch {
    // Already gone or not permitted; the running check below decides.
  }
}

export async function quitApp({ timeoutMs = 15000 } = {}) {
  if (!(await isRunning())) return { stopped: true, forced: false };

  await taskkill(['/IM', 'Gemini.exe', '/T']);
  const started = Date.now();
  while (Date.now() - started < 4000) {
    if (!(await isRunning())) return { stopped: true, forced: false };
    await sleep(250);
  }

  await taskkill(['/IM', 'Gemini.exe', '/T', '/F']);
  const forceStart = Date.now();
  while (Date.now() - forceStart < timeoutMs) {
    if (!(await isRunning())) return { stopped: true, forced: true };
    await sleep(200);
  }
  throw new Error('Gemini did not exit. Close it manually and retry.');
}

export function launch(port = DEFAULT_PORT, install = resolveInstall()) {
  const child = spawn(install.launcherExe, [`--remote-debugging-port=${port}`], {
    cwd: install.root,
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
  });
  child.unref();
  return child.pid;
}

export async function waitForCdp(port, { timeoutMs = 45000 } = {}) {
  const started = Date.now();
  let lastError = null;
  while (Date.now() - started < timeoutMs) {
    try {
      const version = await fetchJson(cdpUrl(port), 1500);
      if (version?.webSocketDebuggerUrl) {
        const target = await findGeminiTarget(port);
        if (target) return { version, target };
        lastError = new Error('Gemini page target not ready yet.');
      }
    } catch (error) {
      lastError = error;
    }
    await sleep(400);
  }
  throw new Error(
    `Timed out waiting for Gemini's DevTools endpoint on port ${port}. ${lastError ? lastError.message : ''}`.trim(),
  );
}

export async function ensureCdp({ port = DEFAULT_PORT, restart = true, log = () => {} } = {}) {
  const install = resolveInstall();
  if (await isCdpAlive(port)) {
    return { port, restarted: false, install, guard: guardStatus(install) };
  }

  if (!restart) {
    throw new Error('Gemini is not exposing a DevTools endpoint. Run "setup" to restart it in debug mode.');
  }

  await assertPortAvailable(port);

  const wasRunning = await isRunning();
  if (wasRunning) {
    log('restarting Gemini with remote debugging enabled');
    await quitApp();
  } else {
    log('starting Gemini with remote debugging enabled');
  }

  // The archive can only be replaced while the app is not holding it open.
  const guard = applyGuard(install);
  if (guard.changed) log(`patched app.asar for v${install.version}`);

  launch(port, install);
  await waitForCdp(port);
  return { port, restarted: true, install, guard: guardStatus(install) };
}

export async function setup({ port = DEFAULT_PORT, log = () => {} } = {}) {
  const install = resolveInstall();
  if (!(await isCdpAlive(port))) await assertPortAvailable(port);
  await quitApp();
  const guard = applyGuard(install);
  launch(port, install);
  await waitForCdp(port);
  return { port, install, guard };
}

export async function restore({ port = DEFAULT_PORT, restart = true, log = () => {} } = {}) {
  const install = resolveInstall();
  await quitApp();
  const result = restoreGuard(install);
  if (restart) {
    spawn(install.launcherExe, [], { cwd: install.root, detached: true, stdio: 'ignore' }).unref();
    log('restored original app.asar and restarted Gemini normally');
  }
  return { ...result, port };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
