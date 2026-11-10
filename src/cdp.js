import { classifyTargets, listTargets } from './app.js';
import { AuthRequiredError, SIGN_IN_HINT } from './auth.js';

export class CdpClient {
  constructor(webSocketUrl, { defaultTimeoutMs = 30000 } = {}) {
    this.webSocketUrl = webSocketUrl;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.nextId = 0;
    this.pending = new Map();
    this.closed = false;
    this.ws = null;
  }

  static async connect(port) {
    const classified = classifyTargets(await listTargets(port));
    if (!classified.gemini) {
      if (classified.signIn || classified.accounts) {
        const url = classified.signIn?.url || classified.accounts?.url || null;
        throw new AuthRequiredError(`Gemini is not signed in (${url}). ${SIGN_IN_HINT}`, { url });
      }
      const targets = classified.pages.map((target) => target.url);
      throw new Error(`No Gemini page target on port ${port}. Targets: ${targets.join(', ') || 'none'}`);
    }
    const client = new CdpClient(classified.gemini.webSocketDebuggerUrl);
    await client.open();
    return client;
  }

  static async connectTarget(target) {
    const client = new CdpClient(target.webSocketDebuggerUrl);
    await client.open();
    return client;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.webSocketUrl);
      this.ws = ws;
      const onOpen = () => {
        ws.removeEventListener('error', onError);
        ws.addEventListener('message', (event) => this.handleMessage(event));
        ws.addEventListener('close', () => this.handleClose());
        ws.addEventListener('error', () => this.handleClose());
        resolve();
      };
      const onError = (event) => reject(new Error(`Could not connect to Gemini DevTools: ${event?.message || 'socket error'}`));
      ws.addEventListener('open', onOpen, { once: true });
      ws.addEventListener('error', onError, { once: true });
    });
  }

  handleMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      return;
    }
    const entry = this.pending.get(message.id);
    if (!entry) return;
    this.pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(`${message.error.message}${message.error.data ? `: ${message.error.data}` : ''}`));
    else entry.resolve(message.result);
  }

  handleClose() {
    this.closed = true;
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(new Error('Gemini DevTools connection closed.'));
    }
    this.pending.clear();
  }

  send(method, params = {}, { timeoutMs = this.defaultTimeoutMs } = {}) {
    if (this.closed) return Promise.reject(new Error('Gemini DevTools connection is closed.'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`DevTools call timed out: ${method}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async evaluate(expression, { awaitPromise = true, timeoutMs } = {}) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise }, { timeoutMs });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`Page evaluate failed: ${description}`);
    }
    return result.result.value;
  }

  async navigate(url, { timeoutMs = 30000 } = {}) {
    await this.send('Page.navigate', { url }, { timeoutMs });
  }

  async screenshot({ format = 'png', captureBeyondViewport = false } = {}) {
    const result = await this.send('Page.captureScreenshot', { format, captureBeyondViewport }, { timeoutMs: 15000 });
    return Buffer.from(result.data, 'base64');
  }

  close() {
    if (!this.ws) return;
    this.closed = true;
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}
