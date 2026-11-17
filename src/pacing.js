import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const stateDir = process.env.GEMINI_DRIVER_STATE_DIR
  || path.join(process.env.LOCALAPPDATA || os.homedir(), 'gemini-driver');
const lockPath = path.join(stateDir, 'action.lock');
const statePath = path.join(stateDir, 'state.json');

export const humanize = process.env.GEMINI_DRIVER_HUMANIZE !== '0';
const MIN_GAP_MS = Number(process.env.GEMINI_DRIVER_MIN_GAP_MS || 30000);
const MAX_PER_HOUR = Number(process.env.GEMINI_DRIVER_MAX_PER_HOUR || 20);
const LOCK_STALE_MS = 10 * 60 * 1000;

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function jitter(baseMs, spread = 0.4) {
  const low = baseMs * (1 - spread / 2);
  const high = baseMs * (1 + spread / 2);
  return Math.round(low + Math.random() * (high - low));
}

function ensureDir() {
  fs.mkdirSync(stateDir, { recursive: true });
}

export function loadState() {
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch {
    return { lastPromptAt: 0, prompts: [] };
  }
}

function saveState(state) {
  try {
    ensureDir();
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch {
    // Non-fatal: pacing still works in-process.
  }
}

// One action at a time across CLI and MCP processes. Prevents colliding menu
// toggles (which look like frantic automation) and accidental double sends.
export async function withFileLock(task, { timeoutMs = 15 * 60 * 1000 } = {}) {
  ensureDir();
  const started = Date.now();
  let acquired = false;
  while (Date.now() - started < timeoutMs) {
    try {
      const fd = fs.openSync(lockPath, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      fs.closeSync(fd);
      acquired = true;
      break;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const stat = fs.statSync(lockPath);
        if (Date.now() - stat.mtimeMs > LOCK_STALE_MS) {
          fs.rmSync(lockPath, { force: true });
          continue;
        }
      } catch {
        continue;
      }
      await sleep(jitter(300, 0.8));
    }
  }
  if (!acquired) throw new Error('Gemini driver is busy with another action; try again shortly.');
  try {
    return await task();
  } finally {
    fs.rmSync(lockPath, { force: true });
  }
}

export async function waitForPromptGap(log = () => {}) {
  if (!humanize) return;
  const state = loadState();
  const now = Date.now();
  state.prompts = (state.prompts || []).filter((at) => now - at < 60 * 60 * 1000);
  if (state.prompts.length >= MAX_PER_HOUR) {
    throw new Error(
      `Prompt rate limit reached (${MAX_PER_HOUR}/hour). Wait a bit before sending again; ` +
        'set GEMINI_DRIVER_MAX_PER_HOUR to change it.',
    );
  }
  if (state.lastPromptAt) {
    const elapsed = now - state.lastPromptAt;
    if (elapsed < MIN_GAP_MS) {
      const waitMs = MIN_GAP_MS - elapsed + jitter(1500, 0.6);
      log(`pacing: waiting ${(waitMs / 1000).toFixed(1)}s before the next prompt`);
      await sleep(waitMs);
    }
  }
}

export function recordPrompt() {
  const state = loadState();
  const now = Date.now();
  state.lastPromptAt = now;
  state.prompts = [...(state.prompts || []).filter((at) => now - at < 60 * 60 * 1000), now];
  saveState(state);
}

export function pacingInfo() {
  return { humanize, minGapMs: MIN_GAP_MS, maxPerHour: MAX_PER_HOUR, stateDir };
}
