import fs from 'node:fs';
import path from 'node:path';
import { CdpClient } from './cdp.js';
import { classifyTargets, getAuthState, listTargets, sleep } from './app.js';
import { AuthRequiredError, SIGN_IN_HINT } from './auth.js';

const GEMINI_URL = 'https://gemini.google.com/app';

const SNAPSHOT_JS = `(() => {
  const SKIP = /(cdk-visually-hidden|screen-reader|visually-hidden|sr-only)/;
  const BLOCK = /^(P|DIV|LI|UL|OL|H[1-6]|PRE|BLOCKQUOTE|TR|TABLE|SECTION|ARTICLE|HEADER|FOOTER|CODE|BR|HR)$/;
  const textOf = (root) => {
    if (!root) return '';
    const parts = [];
    const visit = (node) => {
      if (node.nodeType === 3) { parts.push(node.nodeValue || ''); return; }
      if (node.nodeType !== 1) return;
      const tag = node.tagName;
      if (tag === 'SCRIPT' || tag === 'STYLE') return;
      const cls = typeof node.className === 'string' ? node.className : '';
      if (cls && SKIP.test(cls)) return;
      if (node.getAttribute && node.getAttribute('aria-hidden') === 'true') return;
      const isBlock = BLOCK.test(tag);
      if (isBlock) parts.push('\\n');
      for (const child of node.childNodes) visit(child);
      if (isBlock) parts.push('\\n');
    };
    visit(root);
    return parts.join('')
      .replace(/\\u00a0/g, ' ')
      .replace(/[ \\t]+\\n/g, '\\n')
      .replace(/\\n{3,}/g, '\\n\\n')
      .trim();
  };
  const editor = document.querySelector('rich-textarea .ql-editor')
    || document.querySelector('div[contenteditable="true"]');
  const nodes = [...document.querySelectorAll('user-query, model-response')];
  const messages = nodes.map((el) => {
    if (el.tagName === 'USER-QUERY') {
      const lines = [...el.querySelectorAll('.query-text-line')].map((p) => textOf(p));
      if (lines.length > 0) return { role: 'user', text: lines.join('\\n') };
      return { role: 'user', text: textOf(el.querySelector('.query-text') || el).replace(/^You said\\s+/, '') };
    }
    const content = el.querySelector('.markdown') || el.querySelector('message-content') || el.querySelector('model-response-content') || el;
    const images = content.querySelectorAll('img').length;
    return { role: 'model', text: textOf(content), images };
  });
  const stop = [...document.querySelectorAll('button')]
    .find((b) => /stop (response|generating)/i.test(b.getAttribute('aria-label') || ''));
  const conversation = (location.pathname.match(/^\\/app\\/([0-9a-f]+)/) || [])[1] || null;
  const mode = document.querySelector('bard-mode-switcher');
  const modeRows = [...document.querySelectorAll('gem-segmented-button-row')];
  const modeRow = modeRows.find((row) => /chat/i.test(row.innerText || '') && /task/i.test(row.innerText || ''));
  const selected = modeRow ? modeRow.querySelector('.gem-segmented-button-selected') : null;
  const modeOptions = modeRow
    ? [...modeRow.querySelectorAll('gem-segmented-button')].map((s) => (s.innerText || '').trim().toLowerCase())
    : [];
  const accountEl = document.querySelector('[aria-label^="Google Account:"]');
  const accountLabel = accountEl ? accountEl.getAttribute('aria-label') || '' : '';
  const accountStart = accountLabel.indexOf('(');
  const accountEnd = accountLabel.indexOf(')', accountStart + 1);
  const account = accountStart >= 0 && accountEnd > accountStart
    ? accountLabel.slice(accountStart + 1, accountEnd)
    : null;
  const picker = document.querySelector('button[aria-label^="Open mode picker"]');
  const pickerLabel = picker ? picker.getAttribute('aria-label') || '' : '';
  const pickerIndex = pickerLabel.toLowerCase().indexOf('currently ');
  const modelName = pickerIndex >= 0 ? pickerLabel.slice(pickerIndex + 'currently '.length).trim() : null;
  return {
    url: location.href,
    conversationId: conversation,
    editorText: editor ? editor.innerText : null,
    editorEmpty: editor ? editor.innerText.trim().length === 0 : null,
    editorPlaceholder: editor ? editor.getAttribute('data-placeholder') : null,
    streaming: Boolean(stop),
    messages,
    model: modelName,
    mode: selected ? (selected.innerText || '').trim().toLowerCase() : null,
    modeOptions,
    account,
  };
})()`;

function normalizeText(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

export class GeminiApp {
  constructor({ port, log = () => {} } = {}) {
    this.port = port;
    this.log = log;
    this.client = null;
    this.queue = Promise.resolve();
  }

  serialize(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async connect({ force = false } = {}) {
    if (!force && this.client && !this.client.closed) return this.client;
    if (this.client) this.client.close();
    this.client = await CdpClient.connect(this.port);
    await this.client.send('Runtime.enable');
    await this.client.send('Page.enable').catch(() => {});
    await this.client.send('DOM.enable').catch(() => {});
    // The app window is often backgrounded or minimized, which freezes CSS
    // animations and leaves streamed answers hidden. Treat the page as focused
    // and active so it renders normally without stealing OS focus.
    await this.client.send('Emulation.setFocusEmulationEnabled', { enabled: true }).catch(() => {});
    await this.client.send('Page.setWebLifecycleState', { state: 'active' }).catch(() => {});
    return this.client;
  }

  async withClient(task) {
    let client;
    try {
      client = await this.connect();
      return await task(client);
    } catch (error) {
      if (client && client.closed) {
        client = await this.connect({ force: true });
        return task(client);
      }
      throw error;
    }
  }

  async evaluate(expression, options) {
    return this.withClient((client) => client.evaluate(expression, options));
  }

  async snapshot() {
    return this.evaluate(SNAPSHOT_JS);
  }

  async ready({ timeoutMs = 25000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    while (Date.now() < deadline) {
      const snap = await this.snapshot().catch((error) => {
        last = error;
        return null;
      });
      if (snap) {
        if (/accounts\.google\.com|\/sign_in\//.test(snap.url)) {
          throw new AuthRequiredError(`Gemini is asking for a Google sign-in (${snap.url}). ${SIGN_IN_HINT}`, {
            url: snap.url,
          });
        }
        if (snap.editorText !== null) return snap;
        last = new Error(`Gemini page not ready (url: ${snap.url}).`);
      }
      await sleep(400);
    }
    throw new Error(`Gemini composer did not appear. ${last ? last.message : ''}`.trim());
  }

  async authStatusImpl() {
    const state = await getAuthState(this.port);
    const base = {
      state: state.state,
      url: state.url,
      targets: state.targets,
    };
    if (state.state !== 'signed-in') {
      return { ...base, account: null, composerReady: false, hint: state.state === 'sign-in-required' ? SIGN_IN_HINT : null };
    }
    try {
      const snap = await this.snapshot();
      return {
        ...base,
        url: snap.url,
        account: snap.account,
        conversationId: snap.conversationId,
        composerReady: snap.editorText !== null,
        hint: null,
      };
    } catch (error) {
      return { ...base, account: null, composerReady: false, hint: error?.message || null };
    }
  }

  authStatus() {
    return this.serialize(() => this.authStatusImpl());
  }

  async bringToFrontImpl() {
    const classified = classifyTargets(await listTargets(this.port));
    const target = classified.gemini || classified.signIn || classified.accounts || classified.appPage;
    if (!target) return false;
    const client = await CdpClient.connectTarget(target);
    try {
      await client.send('Page.bringToFront').catch(() => {});
    } finally {
      client.close();
    }
    return true;
  }

  async loginImpl({ timeoutMs = 300000 } = {}) {
    await this.bringToFrontImpl();
    const deadline = Date.now() + timeoutMs;
    let last = await getAuthState(this.port);

    while (Date.now() < deadline) {
      last = await getAuthState(this.port);
      if (last.state === 'signed-in') {
        try {
          const snap = await this.ready({ timeoutMs: 30000 });
          return { signedIn: true, url: snap.url, account: snap.account, hint: null };
        } catch (error) {
          if (!(error instanceof AuthRequiredError)) throw error;
          last = { state: 'sign-in-required', url: error.url || last.url };
        }
      }
      await sleep(1500);
    }

    return {
      signedIn: false,
      state: last.state,
      url: last.url,
      hint: last.state === 'sign-in-required' ? SIGN_IN_HINT : 'Gemini page did not become usable in time.',
    };
  }

  login(options) {
    return this.serialize(() => this.loginImpl(options));
  }

  async focusEditor() {
    await this.evaluate(`(() => {
      const editor = document.querySelector('rich-textarea .ql-editor') || document.querySelector('div[contenteditable="true"]');
      if (!editor) return false;
      editor.focus();
      const selection = getSelection();
      selection.selectAllChildren(editor);
      selection.collapseToEnd();
      return true;
    })()`);
  }

  async key(methodArgs) {
    await this.withClient((client) => client.send('Input.dispatchKeyEvent', methodArgs));
  }

  async pressEnter() {
    await this.key({ type: 'rawKeyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
    await this.key({ type: 'char', key: 'Enter', text: '\r', unmodifiedText: '\r', windowsVirtualKeyCode: 13 });
    await this.key({ type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  }

  async clearComposer() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await this.focusEditor();
      await this.key({ type: 'rawKeyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await this.key({ type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: 2 });
      await this.key({ type: 'rawKeyDown', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      await this.key({ type: 'keyUp', key: 'Backspace', code: 'Backspace', windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 });
      await sleep(150);
      const snap = await this.snapshot();
      if (snap.editorEmpty) return;
    }
    throw new Error('Could not clear the Gemini composer before typing.');
  }

  async typePrompt(prompt) {
    await this.focusEditor();
    const lines = String(prompt).split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      if (lines[i].length > 0) {
        await this.withClient((client) => client.send('Input.insertText', { text: lines[i] }));
      }
      if (i < lines.length - 1) {
        await this.key({
          type: 'rawKeyDown',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          modifiers: 8,
        });
        await this.key({
          type: 'keyUp',
          key: 'Enter',
          code: 'Enter',
          windowsVirtualKeyCode: 13,
          nativeVirtualKeyCode: 13,
          modifiers: 8,
        });
      }
    }
    await sleep(250);
    const snap = await this.snapshot();
    if (normalizeText(snap.editorText) !== normalizeText(prompt)) {
      throw new Error(`Composer did not accept the full prompt (got: "${normalizeText(snap.editorText).slice(0, 120)}").`);
    }
  }

  async clickSendButton() {
    const clicked = await this.evaluate(`(() => {
      const host = document.querySelector('gem-icon-button.send-button, .send-button');
      if (!host) return false;
      host.click();
      return true;
    })()`);
    return Boolean(clicked);
  }

  async mouseClickSendButton() {
    const rect = await this.evaluate(`(() => {
      const host = document.querySelector('gem-icon-button.send-button, .send-button');
      if (!host) return null;
      const button = host.querySelector('button') || host;
      const r = button.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!rect) return false;
    const client = await this.connect();
    await client.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: rect.x, y: rect.y, buttons: 0 });
    await client.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: rect.x, y: rect.y, button: 'left', buttons: 1, clickCount: 1 });
    await client.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: rect.x, y: rect.y, button: 'left', buttons: 0, clickCount: 1 });
    return true;
  }

  async waitForSent(baselineMessages, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const snap = await this.snapshot();
      if (snap.messages.length > baselineMessages) return true;
      await sleep(250);
    }
    return false;
  }

  async waitForAnswer(baselineMessages, { timeoutMs = 180000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let lastText = null;
    let stableSince = 0;
    let stoppedSince = null;
    let snapshot = null;

    while (Date.now() < deadline) {
      await sleep(700);
      snapshot = await this.snapshot();
      const last = snapshot.messages[snapshot.messages.length - 1];
      const hasModelMessage = snapshot.messages.length >= baselineMessages + 2 && last?.role === 'model';
      const hasContent = Boolean(last?.text) || Boolean(last?.images);
      if (!hasModelMessage || !hasContent) {
        // A generation can be stopped (or fail) without producing text; do not
        // sit on the full timeout. The grace period lets streaming start.
        if (!snapshot.streaming && snapshot.messages.length > baselineMessages) {
          stoppedSince ??= Date.now();
          if (Date.now() - stoppedSince >= 6000) {
            return {
              text: hasModelMessage ? last.text : '',
              images: hasModelMessage ? last.images || 0 : 0,
              timedOut: false,
              stopped: true,
              url: snapshot.url,
              conversationId: snapshot.conversationId,
              streaming: false,
            };
          }
        } else {
          stoppedSince = null;
        }
        continue;
      }
      stoppedSince = null;
      if (last.text !== lastText) {
        lastText = last.text;
        stableSince = Date.now();
      }
      if (!snapshot.streaming && Date.now() - stableSince >= 1200) {
        return {
          text: last.text,
          images: last.images || 0,
          timedOut: false,
          url: snapshot.url,
          conversationId: snapshot.conversationId,
          streaming: false,
        };
      }
    }

    const last = snapshot?.messages[snapshot.messages.length - 1];
    if (last?.role === 'model' && (last.text || last.images)) {
      return {
        text: last.text,
        images: last.images || 0,
        timedOut: true,
        url: snapshot.url,
        conversationId: snapshot.conversationId,
        streaming: snapshot.streaming,
      };
    }
    throw new Error(`Gemini did not return an answer within ${Math.round(timeoutMs / 1000)}s.`);
  }

  async askImpl(prompt, { timeoutMs = 180000, newChat = false, mode, attachments, tools, thinking } = {}) {
    if (newChat) await this.newChatImpl();
    await this.ready();
    if (mode) await this.setModeImpl(mode);
    if (thinking) await this.setThinkingImpl(thinking);
    if (tools && tools.length > 0) {
      for (const tool of tools) await this.setToolImpl(tool, true);
    }
    if (attachments && attachments.length > 0) await this.attachImpl(attachments);
    const before = await this.snapshot();
    await this.clearComposer();
    await this.typePrompt(prompt);

    let sent = false;
    for (let attempt = 0; attempt < 3 && !sent; attempt += 1) {
      if (attempt === 0) await this.clickSendButton();
      else if (attempt === 1) await this.pressEnter();
      else await this.mouseClickSendButton();
      sent = await this.waitForSent(before.messages.length, 8000);
    }
    if (!sent) {
      throw new Error('Gemini did not accept the prompt (no new user message appeared). The composer text was left in place.');
    }
    const answer = await this.waitForAnswer(before.messages.length, { timeoutMs });
    return { ...answer, prompt };
  }

  ask(prompt, options) {
    return this.serialize(() => this.askImpl(prompt, options));
  }

  async newChatImpl({ mode } = {}) {
    await this.connect();
    await this.withClient((client) => client.navigate(GEMINI_URL));
    const snap = await this.ready();
    if (mode) await this.setModeImpl(mode);
    return { url: snap.url, conversationId: snap.conversationId, mode: mode ? String(mode).toLowerCase() : null };
  }

  newChat(options) {
    return this.serialize(() => this.newChatImpl(options));
  }

  async setModeImpl(mode) {
    const wanted = String(mode ?? '').trim().toLowerCase();
    if (!['chat', 'task'].includes(wanted)) throw new Error('mode must be "chat" or "task"');

    const attempt = () => this.evaluate(`(() => {
      const rows = [...document.querySelectorAll('gem-segmented-button-row')];
      const row = rows.find((r) => /chat/i.test(r.innerText || '') && /task/i.test(r.innerText || ''));
      if (!row) return { ok: false, reason: 'unavailable' };
      const wanted = ${JSON.stringify(wanted)};
      const segment = [...row.querySelectorAll('gem-segmented-button')]
        .find((s) => (s.innerText || '').trim().toLowerCase() === wanted);
      if (!segment) return { ok: false, reason: 'unknown-mode' };
      if (segment.classList.contains('gem-segmented-button-selected')) return { ok: true, changed: false };
      (segment.querySelector('button') || segment).click();
      return { ok: true, changed: true };
    })()`);

    let result = await attempt();
    if (!result?.ok && result?.reason === 'unavailable') {
      const snap = await this.snapshot();
      if (/^\/app\/[0-9a-f]+/.test(new URL(snap.url).pathname)) {
        throw new Error('Chat/Task mode can only be chosen in a new chat. Start a new chat first.');
      }
      // The mode row renders just after the composer; give it a moment.
      const deadline = Date.now() + 6000;
      while (!result?.ok && result?.reason === 'unavailable' && Date.now() < deadline) {
        await sleep(300);
        result = await attempt();
      }
    }

    if (!result?.ok) {
      if (result?.reason === 'unavailable') {
        throw new Error('Chat/Task mode can only be chosen in a new chat. Start a new chat first.');
      }
      throw new Error(`Unknown mode "${mode}".`);
    }
    await sleep(700);
    const snap = await this.snapshot();
    if (snap.mode !== wanted) throw new Error(`Gemini did not switch to ${wanted} mode.`);
    return { mode: snap.mode, options: snap.modeOptions, placeholder: snap.editorPlaceholder };
  }

  setMode(mode) {
    return this.serialize(() => this.setModeImpl(mode));
  }

  async waitForToolbar(timeoutMs = 10000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const ready = await this.evaluate(`(() => {
        const labels = [...document.querySelectorAll('button')].map((b) => b.getAttribute('aria-label') || '');
        return labels.some((l) => /upload and tools/i.test(l)) && labels.some((l) => /open mode picker/i.test(l));
      })()`);
      if (ready) return true;
      await sleep(300);
    }
    return false;
  }

  async openMenuKind() {
    return this.evaluate(`(() => {
      const panes = [...document.querySelectorAll('.cdk-overlay-pane')].filter((p) => p.getClientRects().length);
      for (const pane of panes) {
        if (pane.querySelector('[role="menuitemradio"][data-mode-id]')) return 'model';
        const labels = [...pane.querySelectorAll('button')].map((b) => ((b.innerText || '').trim().split('\\n')[0] || '').trim());
        if (labels.includes('Upload files')) return 'tools';
      }
      return null;
    })()`);
  }

  async closeOverlays() {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const kind = await this.openMenuKind();
      if (!kind) return;
      const toggleRegex = kind === 'model' ? 'open mode picker' : 'upload and tools';
      await this.evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((b) => new RegExp(${JSON.stringify(toggleRegex)}, 'i').test(b.getAttribute('aria-label') || ''));
        if (button) button.click();
        return Boolean(button);
      })()`);
      await sleep(400);
    }
  }

  async isMenuOpen() {
    return Boolean(await this.openMenuKind());
  }

  async isModelPickerOpen() {
    return this.evaluate(`[...document.querySelectorAll('.cdk-overlay-pane')].some((pane) => (
      pane.getClientRects().length > 0 && pane.querySelector('[role="menuitemradio"][data-mode-id]')
    ))`);
  }

  async openModelPicker() {
    if (await this.isModelPickerOpen()) return true;
    await this.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((b) => /open mode picker/i.test(b.getAttribute('aria-label') || ''));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await sleep(800);
    return this.isModelPickerOpen();
  }

  async isToolsMenuOpen() {
    return this.evaluate(`[...document.querySelectorAll('.cdk-overlay-pane')].some((pane) => (
      pane.getClientRects().length > 0 && [...pane.querySelectorAll('button, [role="menuitem"]')].some((el) => (
        ((el.innerText || '').trim().split('\\n')[0] || '').trim() === 'Upload files'
      ))
    ))`);
  }

  async openToolbarMenu() {
    if (await this.isToolsMenuOpen()) return true;
    await this.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((b) => /upload and tools/i.test(b.getAttribute('aria-label') || ''));
      if (!button) return false;
      button.click();
      return true;
    })()`);
    await sleep(800);
    return this.isToolsMenuOpen();
  }

  async readMenuItems() {
    return this.evaluate(`(() => {
      const panes = [...document.querySelectorAll('.cdk-overlay-pane')].filter((p) => p.getClientRects().length);
      const seen = new Set();
      const items = [];
      for (const pane of panes) {
        const nodes = [...pane.querySelectorAll(
          'button, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"]'
        )];
        for (const node of nodes) {
          if (!node.getClientRects().length) continue;
          const name = ((node.innerText || '').trim().split('\\n')[0] || node.getAttribute('aria-label') || '').trim();
          if (!name || seen.has(name)) continue;
          seen.add(name);
          items.push({
            name,
            role: node.getAttribute('role') || 'button',
            checked: node.getAttribute('aria-checked'),
            disabled: node.getAttribute('aria-disabled'),
          });
        }
      }
      return items;
    })()`);
  }

  async clickMenuItem(name) {
    return this.evaluate(`(() => {
      const panes = [...document.querySelectorAll('.cdk-overlay-pane')].filter((p) => p.getClientRects().length);
      const wanted = ${JSON.stringify(String(name))}.toLowerCase();
      const firstLine = (e) => ((e.innerText || '').trim().split('\\n')[0] || '').trim().toLowerCase();
      const candidates = [];
      for (const pane of panes) {
        for (const node of pane.querySelectorAll(
          'button, [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="switch"]'
        )) {
          if (node.getClientRects().length) candidates.push(node);
        }
      }
      const target = candidates.find((e) => firstLine(e) === wanted)
        || candidates.find((e) => firstLine(e).includes(wanted));
      if (!target) return false;
      (target.querySelector('button') || target).click();
      return true;
    })()`);
  }

  async modelsImpl() {
    await this.waitForToolbar();
    if (!(await this.openModelPicker())) throw new Error('Gemini model picker was not found on the page.');
    const pill = await this.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((b) => /open mode picker/i.test(b.getAttribute('aria-label') || ''));
      const match = (button?.getAttribute('aria-label') || '').match(/currently (.+)$/i);
      return match ? match[1].trim() : null;
    })()`);
    const models = await this.evaluate(`(() => {
      const panes = [...document.querySelectorAll('.cdk-overlay-pane')].filter((p) => p.getClientRects().length);
      const isModelLine = (line) => ['flash', 'pro', 'argon', 'ultra'].some((word) => line.toLowerCase().includes(word));
      const seen = new Set();
      const out = [];
      for (const pane of panes) {
        for (const node of pane.querySelectorAll('[role="menuitemradio"]')) {
          if (!node.getClientRects().length) continue;
          const lines = (node.innerText || '').split('\\n').map((line) => line.trim()).filter(Boolean);
          if (lines.length === 0) continue;
          const name = lines.find(isModelLine) || lines[0];
          const description = lines.find((line) => line !== name) || '';
          if (!name || seen.has(name)) continue;
          seen.add(name);
          out.push({
            name,
            description,
            id: node.getAttribute('data-mode-id'),
            selected: node.getAttribute('aria-checked') === 'true',
          });
        }
      }
      return out;
    })()`);

    let items = await this.readMenuItems();
    if (!items.some((item) => ['low', 'medium', 'high'].includes(item.name.toLowerCase()))) {
      if (await this.clickMenuItem('Thinking level')) {
        await sleep(700);
        items = await this.readMenuItems();
      }
    }
    const levels = items.filter((item) => ['low', 'medium', 'high'].includes(item.name.toLowerCase()));
    const thinking = {
      level: levels.find((item) => item.checked === 'true')?.name.toLowerCase() || null,
      options: levels.map((item) => item.name.toLowerCase()),
    };
    await this.closeOverlays();
    const selected = models.find((model) => model.selected);
    return { current: selected ? selected.name : pill, pill, models, thinking };
  }

  models() {
    return this.serialize(() => this.modelsImpl());
  }

  async thinkingImpl() {
    await this.waitForToolbar();
    if (!(await this.openModelPicker())) throw new Error('Gemini model picker was not found on the page.');
    let items = await this.readMenuItems();
    if (!items.some((item) => ['low', 'medium', 'high'].includes(item.name.toLowerCase()))) {
      if (await this.clickMenuItem('Thinking level')) {
        await sleep(700);
        items = await this.readMenuItems();
      }
    }
    const levels = items.filter((item) => ['low', 'medium', 'high'].includes(item.name.toLowerCase()));
    const result = {
      level: levels.find((item) => item.checked === 'true')?.name.toLowerCase() || null,
      options: levels.map((item) => item.name.toLowerCase()),
    };
    await this.closeOverlays();
    return result;
  }

  thinking() {
    return this.serialize(() => this.thinkingImpl());
  }

  async setThinkingImpl(level) {
    const wanted = String(level ?? '').trim().toLowerCase();
    if (!['low', 'medium', 'high'].includes(wanted)) {
      throw new Error('thinking level must be "low", "medium" or "high"');
    }
    await this.waitForToolbar();
    if (!(await this.openModelPicker())) throw new Error('Gemini model picker was not found on the page.');
    let items = await this.readMenuItems();
    if (!items.some((item) => item.name.toLowerCase() === wanted)) {
      if (await this.clickMenuItem('Thinking level')) {
        await sleep(700);
        items = await this.readMenuItems();
      }
    }
    const clicked = await this.clickMenuItem(wanted);
    await sleep(700);
    await this.closeOverlays();
    if (!clicked) throw new Error(`Unknown thinking level "${level}".`);
    const state = await this.thinkingImpl();
    if (state.level !== wanted) throw new Error(`Gemini did not switch thinking level to ${wanted}.`);
    return state;
  }

  setThinking(level) {
    return this.serialize(() => this.setThinkingImpl(level));
  }

  async setModelImpl(name) {
    const wanted = String(name ?? '').trim();
    if (!wanted) throw new Error('model name is required');
    await this.waitForToolbar();
    if (!(await this.openModelPicker())) throw new Error('Gemini model picker was not found on the page.');
    const clicked = await this.evaluate(`(() => {
      const panes = [...document.querySelectorAll('.cdk-overlay-pane')].filter((p) => p.getClientRects().length);
      const wanted = ${JSON.stringify(wanted)}.toLowerCase();
      const linesOf = (node) => (node.innerText || '')
        .split('\\n').map((line) => line.trim().toLowerCase()).filter(Boolean);
      const candidates = [];
      for (const pane of panes) {
        for (const node of pane.querySelectorAll('[role="menuitemradio"]')) {
          if (node.getClientRects().length) candidates.push(node);
        }
      }
      const target = candidates.find((node) => linesOf(node).some((line) => line === wanted))
        || candidates.find((node) => linesOf(node).some((line) => line.includes(wanted) || wanted.includes(line)));
      if (!target) return false;
      (target.querySelector('button') || target).click();
      return true;
    })()`);
    await sleep(1000);
    await this.closeOverlays();
    if (!clicked) {
      const { models } = await this.modelsImpl();
      throw new Error(`Unknown model "${wanted}". Available: ${models.map((m) => m.name).join(', ')}`);
    }
    const state = await this.modelsImpl();
    const current = state.current;
    const ok = current
      && (current.toLowerCase().includes(wanted.toLowerCase()) || wanted.toLowerCase().includes(current.toLowerCase()));
    if (!ok) {
      throw new Error(`Gemini did not switch to "${wanted}" (current: ${current || 'unknown'}).`);
    }
    return { model: current, requested: wanted };
  }

  setModel(name) {
    return this.serialize(() => this.setModelImpl(name));
  }

  async toolsImpl() {
    await this.waitForToolbar();
    if (!(await this.openToolbarMenu())) throw new Error('Gemini tools menu (+ button) was not found.');
    await sleep(800);
    const tools = await this.readMenuItems();
    let moreTools = [];
    if (tools.some((item) => item.name.toLowerCase() === 'more tools')) {
      if (await this.clickMenuItem('More tools')) {
        await sleep(800);
        moreTools = (await this.readMenuItems()).filter(
          (item) => !tools.some((existing) => existing.name === item.name),
        );
      }
    }
    await this.closeOverlays();
    return { tools, moreTools };
  }

  tools() {
    return this.serialize(() => this.toolsImpl());
  }

  async setToolImpl(name, enabled = true) {
    const wanted = String(name ?? '').trim();
    if (!wanted) throw new Error('tool name is required');
    await this.waitForToolbar();
    if (!(await this.openToolbarMenu())) throw new Error('Gemini tools menu (+ button) was not found.');
    await sleep(800);

    let items = await this.readMenuItems();
    const find = () => items.find((item) => item.name.toLowerCase() === wanted.toLowerCase())
      || items.find((item) => item.name.toLowerCase().includes(wanted.toLowerCase()));

    if (!find() && items.some((item) => item.name.toLowerCase() === 'more tools')) {
      if (await this.clickMenuItem('More tools')) {
        await sleep(800);
        items = await this.readMenuItems();
      }
    }

    const item = find();
    if (!item) {
      const names = items.filter((i) => i.role !== null).map((i) => i.name);
      await this.closeOverlays();
      throw new Error(`Unknown tool "${wanted}". Available: ${names.join(', ')}`);
    }
    if (item.role !== 'menuitemcheckbox' && item.role !== 'switch') {
      await this.closeOverlays();
      throw new Error(`"${item.name}" is not a toggle (role: ${item.role || 'none'}).`);
    }

    const currentlyOn = item.checked === 'true';
    if (currentlyOn !== Boolean(enabled)) {
      await this.clickMenuItem(item.name);
      await sleep(700);
      items = await this.readMenuItems();
    }
    const updated = items.find((i) => i.name.toLowerCase() === item.name.toLowerCase());
    await this.closeOverlays();
    return { tool: item.name, enabled: updated ? updated.checked === 'true' : Boolean(enabled) };
  }

  setTool(name, enabled) {
    return this.serialize(() => this.setToolImpl(name, enabled));
  }

  async attachImpl(paths) {
    const files = (Array.isArray(paths) ? paths : [paths]).filter(Boolean).map((file) => path.resolve(String(file)));
    if (files.length === 0) throw new Error('No files to attach.');
    for (const file of files) {
      if (!fs.existsSync(file)) throw new Error(`File not found: ${file}`);
    }

    if (!(await this.waitForToolbar())) {
      throw new Error('Gemini composer toolbar did not appear.');
    }
    if (!(await this.openToolbarMenu())) throw new Error('Gemini tools menu (+ button) was not found.');
    await sleep(700);

    const descriptors = await this.evaluate(`[...document.querySelectorAll('input[type=file]')]
      .map((input) => ({ accept: input.accept || '', multiple: input.multiple }))`);
    if (descriptors.length === 0) {
      await this.closeOverlays();
      throw new Error('Gemini did not expose a file input.');
    }

    const isMedia = (file) => /\.(png|jpe?g|gif|webp|bmp|tiff?|heic|heif|avif|mp4|mov|webm|avi|mkv|m4v)$/i.test(file);
    const media = files.filter(isMedia);
    const documents = files.filter((file) => !isMedia(file));

    const client = await this.connect();
    const setFiles = async (files, acceptPattern) => {
      const expression = `(() => {
        const inputs = [...document.querySelectorAll('input[type=file]')];
        return inputs.find((input) => ${acceptPattern}.test(input.accept || '')) || null;
      })()`;
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const evaluated = await client.send('Runtime.evaluate', { expression, returnByValue: false });
        if (evaluated.exceptionDetails) {
          lastError = new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
          await sleep(400);
          continue;
        }
        const objectId = evaluated.result?.objectId;
        if (!objectId) {
          lastError = new Error('Gemini file input disappeared.');
          await sleep(400);
          continue;
        }
        try {
          await client.send('DOM.setFileInputFiles', { files, objectId });
          return true;
        } catch (error) {
          lastError = error;
          await sleep(400);
        }
      }
      throw new Error(`Could not set files on the Gemini input (${lastError?.message || 'unknown error'}).`);
    };

    const groups = [];
    const upload = async (kind, files, acceptPattern) => {
      if (!(await this.openToolbarMenu())) throw new Error('Gemini tools menu (+ button) was not found.');
      await sleep(400);
      await setFiles(files, acceptPattern);
      groups.push({ kind, files });
      await sleep(600);
    };

    if (documents.length > 0) await upload('documents', documents, /\.pdf|document/i);
    if (media.length > 0) await upload('media', media, /image/i);

    let attachments = 0;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      await sleep(500);
      attachments = await this.evaluate(`(() => {
        const area = document.querySelector('input-area-v2') || document.querySelector('input-container');
        if (!area) return 0;
        return [...area.querySelectorAll('.file-preview-chip, uploader-file-preview, uploader-file-preview-container')]
          .filter((e) => e.getClientRects().length).length;
      })()`);
      if (attachments >= files.length) break;
    }

    await this.closeOverlays();
    return { uploaded: files.length, media: media.length, documents: documents.length, attachments, groups };
  }

  attach(paths) {
    return this.serialize(() => this.attachImpl(paths));
  }

  async transcriptImpl() {
    const snap = await this.ready();
    return {
      url: snap.url,
      conversationId: snap.conversationId,
      model: snap.model,
      streaming: snap.streaming,
      messages: snap.messages,
    };
  }

  transcript() {
    return this.serialize(() => this.transcriptImpl());
  }

  async conversationsImpl({ limit = 50 } = {}) {
    await this.ready();
    const items = await this.evaluate(`(() => {
      const anchors = [...document.querySelectorAll(
        'conversations-list a[href*="/app/"], side-navigation-v2 a[href*="/app/"], a[href^="/app/"]'
      )];
      const seen = new Set();
      const out = [];
      for (const a of anchors) {
        const href = a.getAttribute('href') || '';
        const match = href.match(/^\\/app\\/([0-9a-f]+)/);
        if (!match || seen.has(match[1])) continue;
        seen.add(match[1]);
        const title = (a.innerText || '').trim();
        if (!title) continue;
        out.push({ id: match[1], title, href });
      }
      return out;
    })()`);
    return { conversations: items.slice(0, limit) };
  }

  conversations(options) {
    return this.serialize(() => this.conversationsImpl(options));
  }

  async openConversationImpl(query) {
    const { conversations } = await this.conversationsImpl();
    const needle = String(query || '').trim().toLowerCase();
    const found =
      conversations.find((c) => c.id === needle) ||
      conversations.find((c) => c.title.toLowerCase() === needle) ||
      conversations.find((c) => c.title.toLowerCase().includes(needle));
    if (!found) {
      const sample = conversations.slice(0, 10).map((c) => `- ${c.title} (${c.id})`).join('\n');
      throw new Error(`No conversation matched "${query}". Some available conversations:\n${sample}`);
    }
    await this.connect();
    await this.withClient((client) => client.navigate(`https://gemini.google.com${found.href}`));
    await this.ready();
    const deadline = Date.now() + 15000;
    let snap = await this.snapshot();
    while (Date.now() < deadline && snap.messages.length === 0) {
      await sleep(500);
      snap = await this.snapshot();
    }
    return { conversation: found, messages: snap.messages, url: snap.url };
  }

  openConversation(query) {
    return this.serialize(() => this.openConversationImpl(query));
  }

  async stopImpl() {
    const clicked = await this.evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((b) => /stop (response|generating)/i.test(b.getAttribute('aria-label') || ''));
      if (!button) return false;
      const host = button.closest('gem-icon-button') || button;
      host.click();
      return true;
    })()`);
    if (!clicked) return { stopped: false };
    const deadline = Date.now() + 8000;
    let snap = await this.snapshot();
    while (Date.now() < deadline && snap.streaming) {
      await sleep(300);
      snap = await this.snapshot();
    }
    return { stopped: !snap.streaming, streaming: snap.streaming };
  }

  stop() {
    return this.serialize(() => this.stopImpl());
  }

  async screenshotBuffer() {
    return this.withClient((client) => client.screenshot());
  }

  async screenshotTo(filePath) {
    const buffer = await this.screenshotBuffer();
    const target = path.resolve(filePath);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, buffer);
    return { path: target, bytes: buffer.length };
  }

  dispose() {
    if (this.client) this.client.close();
    this.client = null;
  }
}
