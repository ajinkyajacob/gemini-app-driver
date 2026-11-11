import { DEFAULT_PORT, ensureCdp, isCdpAlive, isRunning, restore, setup } from './app.js';
import { GeminiApp } from './gemini.js';
import { guardStatus } from './guard.js';
import { resolveInstall } from './paths.js';

const PROTOCOL_VERSION = '2024-11-05';

const TOOLS = [
  {
    name: 'gemini_status',
    description:
      'Report the Gemini desktop app state: installed version, whether the driver patch is applied, whether the app is running, and the live page state (conversation, model, streaming).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gemini_setup',
    description:
      'Enable driver access: patch the installed Gemini app so it accepts a DevTools port, then restart it with remote debugging on. Safe to re-run after app updates.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'number', description: 'DevTools port to use (default 9333).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_restore',
    description: 'Undo the driver patch, restore the original app.asar, and restart Gemini normally.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gemini_login',
    description:
      'Bring the Gemini app window forward and wait for the user to finish signing in (the driver cannot enter credentials). Returns signedIn plus the account email once the composer is ready.',
    inputSchema: {
      type: 'object',
      properties: {
        timeout_ms: { type: 'number', description: 'Maximum time to wait for sign-in (default 300000).' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_ask',
    description:
      'Send a prompt to Gemini in the desktop app, wait for the response to finish streaming, and return the answer text (and image count). Use new_chat to start a fresh conversation, mode for Chat/Task, tools to enable composer tools, and attachments to upload local files first.',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: 'The prompt to send.' },
        new_chat: { type: 'boolean', description: 'Start a new conversation before sending.' },
        mode: { type: 'string', enum: ['chat', 'task'], description: 'Chat/Task mode (only selectable in a new chat).' },
        thinking: {
          type: 'string',
          enum: ['low', 'medium', 'high'],
          description: 'Thinking level for models that expose it (from the model picker submenu).',
        },
        tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Composer tools to enable first, e.g. ["Create image"] or ["Deep Research"].',
        },
        attachments: {
          type: 'array',
          items: { type: 'string' },
          description: 'Absolute paths of local files to attach before sending.',
        },
        timeout_ms: { type: 'number', description: 'Maximum time to wait for the answer (default 180000).' },
      },
      required: ['prompt'],
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_model',
    description:
      'Read or switch the Gemini model. The picker lists options such as "3.5 Flash-Lite", "3.8 Flash", "3.1 Pro", and "4 Argon" (plus a thinking-level submenu). Call without a model to list them.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'Model name or partial name (e.g. "3.8 Flash", "Argon"). Omit to list models.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_thinking',
    description:
      'Read or switch the Thinking level (low / medium / high) exposed in the model picker submenu. Call without a level to read it.',
    inputSchema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['low', 'medium', 'high'], description: 'Thinking level to select.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_tools',
    description:
      'List the composer tools menu: Upload files, Add from Drive, More uploads, Create image, Create video, More tools (Create music, Canvas, Deep Research, Guided Learning, Personal Intelligence).',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gemini_tool',
    description:
      'Enable or disable a composer tool by name, e.g. "Create image", "Create video", "Canvas", "Deep Research", "Guided Learning".',
    inputSchema: {
      type: 'object',
      properties: {
        tool: { type: 'string', description: 'Tool name exactly as listed by gemini_tools.' },
        enabled: { type: 'boolean', description: 'Desired state (default true).' },
      },
      required: ['tool'],
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_attach',
    description:
      'Attach local files to the composer: images/videos go to the media input, documents/code/data go to the document input. The files stay attached for the next gemini_ask.',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths to attach.' },
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_mode',
    description:
      'Read or switch the new-chat mode: "chat" (Ask Gemini) or "task" (Describe a task). Task mode only exists in a new chat; without a mode argument this returns the current mode and the available options.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['chat', 'task'], description: 'Mode to select. Omit to read the current mode.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_read',
    description: 'Read the current Gemini conversation as an ordered list of user and model messages.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gemini_new_chat',
    description: 'Start a new empty conversation in the Gemini desktop app, optionally in Chat or Task mode.',
    inputSchema: {
      type: 'object',
      properties: {
        mode: { type: 'string', enum: ['chat', 'task'], description: 'Chat/Task mode for the new conversation.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_notebooks',
    description: 'List Gemini notebooks (sidebar Notebooks section), with ids, titles, and which one is open.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum notebooks to return (default 50).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_open_notebook',
    description: 'Open a notebook by id or partial title. After opening, gemini_ask works inside that notebook.',
    inputSchema: {
      type: 'object',
      properties: { notebook: { type: 'string', description: 'Notebook id or title text.' } },
      required: ['notebook'],
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_notebook_chats',
    description: 'List past chats recorded in the currently open notebook.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gemini_open_notebook_chat',
    description: 'Open a past chat in the currently open notebook by (partial) title.',
    inputSchema: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Chat title text.' } },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_new_notebook',
    description: 'Create a new notebook with the given name via the /notebooks/create flow and open it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'Notebook name.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_rename_notebook',
    description: 'Rename the currently open notebook.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string', description: 'New notebook name.' } },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_delete_notebook',
    description:
      'Delete the currently open notebook (destructive, no extra confirmation beyond the app dialog). Open the intended notebook first.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gemini_conversations',
    description: 'List conversations from the Gemini sidebar with their ids and titles.',
    inputSchema: {
      type: 'object',
      properties: { limit: { type: 'number', description: 'Maximum conversations to return (default 50).' } },
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_open',
    description: 'Open an existing conversation by id or by (partial) title, then return its messages.',
    inputSchema: {
      type: 'object',
      properties: { conversation: { type: 'string', description: 'Conversation id or title text.' } },
      required: ['conversation'],
      additionalProperties: false,
    },
  },
  {
    name: 'gemini_stop',
    description: 'Stop an in-progress Gemini response.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'gemini_screenshot',
    description: 'Capture a screenshot of the Gemini page. Returns the image plus an optional saved file path.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Optional absolute path to save the PNG to.' },
      },
      additionalProperties: false,
    },
  },
];

function jsonText(value) {
  return JSON.stringify(value, null, 2);
}

export class McpServer {
  constructor({ port = DEFAULT_PORT, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
    this.port = port;
    this.log = log;
    this.app = new GeminiApp({ port, log });
    this.queue = Promise.resolve();
  }

  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async status() {
    const install = resolveInstall();
    const guard = guardStatus(install);
    const running = await isRunning();
    const cdp = await isCdpAlive(this.port);
    const base = {
      installedVersion: install.version,
      installRoot: install.root,
      patched: guard.state === 'patched',
      guardState: guard.state,
      running,
      cdp,
      port: this.port,
    };
    if (!cdp) return base;
    const auth = await this.app.authStatus().catch((error) => ({ state: 'unknown', hint: error.message }));
    const result = {
      ...base,
      auth: {
        state: auth.state,
        account: auth.account || null,
        url: auth.url || null,
        hint: auth.hint || null,
      },
    };
    if (auth.state !== 'signed-in') return result;
    try {
      const snap = await this.app.snapshot();
      result.page = {
        url: snap.url,
        conversationId: snap.conversationId,
        model: snap.model,
        mode: snap.mode,
        modeOptions: snap.modeOptions,
        streaming: snap.streaming,
        messages: snap.messages.length,
        composerEmpty: snap.editorEmpty,
      };
    } catch (error) {
      result.pageError = error.message;
    }
    return result;
  }

  async ensure({ restart = true } = {}) {
    const result = await ensureCdp({ port: this.port, restart, log: this.log });
    return result;
  }

  async callTool(name, args = {}) {
    switch (name) {
      case 'gemini_status':
        return { content: [{ type: 'text', text: jsonText(await this.status()) }] };

      case 'gemini_setup': {
        const port = Number(args.port || this.port);
        const result = await setup({ port });
        this.port = port;
        this.app.port = port;
        const snap = await this.app.snapshot().catch(() => null);
        return {
          content: [
            {
              type: 'text',
              text: jsonText({
                ok: true,
                port,
                patched: result.guard.state === 'patched',
                version: result.install.version,
                auth: result.auth || 'unknown',
                page: snap ? { url: snap.url, conversationId: snap.conversationId, model: snap.model } : null,
              }),
            },
          ],
        };
      }

      case 'gemini_restore': {
        const result = await restore({ port: this.port });
        return {
          content: [
            { type: 'text', text: jsonText({ ok: true, restored: result.changed, state: result.state, note: 'Gemini restarted without the DevTools port.' }) },
          ],
        };
      }

      case 'gemini_login': {
        await this.ensure();
        const result = await this.app.login({ timeoutMs: Number(args.timeout_ms || 300000) });
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_ask': {
        if (!args.prompt || typeof args.prompt !== 'string') throw new Error('prompt is required');
        await this.ensure();
        const result = await this.app.ask(args.prompt, {
          newChat: Boolean(args.new_chat),
          mode: args.mode,
          thinking: args.thinking,
          tools: Array.isArray(args.tools) ? args.tools : undefined,
          attachments: Array.isArray(args.attachments) ? args.attachments : undefined,
          timeoutMs: Number(args.timeout_ms || 180000),
        });
        return {
          content: [
            {
              type: 'text',
              text: jsonText({
                answer: result.text,
                images: result.images || 0,
                conversationId: result.conversationId,
                url: result.url,
                timedOut: result.timedOut,
                stopped: result.stopped || undefined,
              }),
            },
          ],
        };
      }

      case 'gemini_model': {
        await this.ensure();
        if (!args.model) {
          const result = await this.app.models();
          return { content: [{ type: 'text', text: jsonText(result) }] };
        }
        const result = await this.app.setModel(args.model);
        return { content: [{ type: 'text', text: jsonText({ ok: true, ...result }) }] };
      }

      case 'gemini_thinking': {
        await this.ensure();
        if (!args.level) {
          const result = await this.app.thinking();
          return { content: [{ type: 'text', text: jsonText(result) }] };
        }
        const result = await this.app.setThinking(args.level);
        return { content: [{ type: 'text', text: jsonText({ ok: true, ...result }) }] };
      }

      case 'gemini_tools': {
        await this.ensure();
        const result = await this.app.tools();
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_tool': {
        if (!args.tool) throw new Error('tool is required');
        await this.ensure();
        const result = await this.app.setTool(args.tool, args.enabled !== false);
        return { content: [{ type: 'text', text: jsonText({ ok: true, ...result }) }] };
      }

      case 'gemini_attach': {
        if (!Array.isArray(args.paths) || args.paths.length === 0) throw new Error('paths is required');
        await this.ensure();
        const result = await this.app.attach(args.paths);
        return { content: [{ type: 'text', text: jsonText({ ok: true, ...result }) }] };
      }

      case 'gemini_mode': {
        await this.ensure();
        if (!args.mode) {
          const snap = await this.app.snapshot();
          return {
            content: [
              {
                type: 'text',
                text: jsonText({
                  mode: snap.mode,
                  options: snap.modeOptions,
                  placeholder: snap.editorPlaceholder,
                  conversationId: snap.conversationId,
                  selectable: snap.modeOptions.length > 0,
                }),
              },
            ],
          };
        }
        const result = await this.app.setMode(args.mode);
        return { content: [{ type: 'text', text: jsonText({ ok: true, ...result }) }] };
      }

      case 'gemini_read': {
        await this.ensure();
        const transcript = await this.app.transcript();
        return { content: [{ type: 'text', text: jsonText(transcript) }] };
      }

      case 'gemini_new_chat': {
        await this.ensure();
        const result = await this.app.newChat({ mode: args.mode });
        return { content: [{ type: 'text', text: jsonText({ ok: true, ...result }) }] };
      }

      case 'gemini_notebooks': {
        await this.ensure();
        const result = await this.app.notebooks({ limit: Number(args.limit || 50) });
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_open_notebook': {
        if (!args.notebook) throw new Error('notebook is required');
        await this.ensure();
        const result = await this.app.openNotebook(args.notebook);
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_notebook_chats': {
        await this.ensure();
        const result = await this.app.notebookChats();
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_open_notebook_chat': {
        if (!args.title) throw new Error('title is required');
        await this.ensure();
        const result = await this.app.openNotebookChat(args.title);
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_new_notebook': {
        if (!args.name) throw new Error('name is required');
        await this.ensure();
        const result = await this.app.newNotebook(args.name);
        return { content: [{ type: 'text', text: jsonText({ ok: true, ...result }) }] };
      }

      case 'gemini_rename_notebook': {
        if (!args.name) throw new Error('name is required');
        await this.ensure();
        const result = await this.app.renameNotebook(args.name);
        return { content: [{ type: 'text', text: jsonText({ ok: true, ...result }) }] };
      }

      case 'gemini_delete_notebook': {
        await this.ensure();
        const result = await this.app.deleteNotebook();
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_conversations': {
        await this.ensure();
        const result = await this.app.conversations({ limit: Number(args.limit || 50) });
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_open': {
        if (!args.conversation) throw new Error('conversation is required');
        await this.ensure();
        const result = await this.app.openConversation(args.conversation);
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_stop': {
        await this.ensure();
        const result = await this.app.stop();
        return { content: [{ type: 'text', text: jsonText(result) }] };
      }

      case 'gemini_screenshot': {
        await this.ensure();
        if (args.path) {
          const saved = await this.app.screenshotTo(args.path);
          const buffer = await this.app.screenshotBuffer();
          return {
            content: [
              { type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' },
              { type: 'text', text: jsonText({ saved: saved.path, bytes: saved.bytes }) },
            ],
          };
        }
        const buffer = await this.app.screenshotBuffer();
        return {
          content: [
            { type: 'image', data: buffer.toString('base64'), mimeType: 'image/png' },
            { type: 'text', text: jsonText({ bytes: buffer.length }) },
          ],
        };
      }

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  }

  handleRequest(message) {
    const { id, method, params } = message;

    if (method === 'initialize') {
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: 'gemini-app-driver', version: '0.1.0' },
      };
    }
    if (method === 'ping') return {};
    if (method === 'tools/list') return { tools: TOOLS };
    if (method === 'tools/call') {
      const name = params?.name;
      const args = params?.arguments || {};
      return this.enqueue(() => this.callTool(name, args)).then(
        (result) => result,
        (error) => ({
          content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
          isError: true,
        }),
      );
    }
    if (typeof method === 'string' && method.startsWith('notifications/')) return undefined;
    return Promise.reject(Object.assign(new Error(`Method not found: ${method}`), { code: -32601 }));
  }

  start() {
    let buffer = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      buffer += chunk;
      let index = buffer.indexOf('\n');
      while (index !== -1) {
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (line) this.onLine(line);
        index = buffer.indexOf('\n');
      }
    });
    process.stdin.on('end', () => {
      this.app.dispose();
      process.exit(0);
    });
  }

  onLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      return;
    }
    if (message.id === undefined) {
      Promise.resolve(this.handleRequest(message)).catch(() => {});
      return;
    }
    Promise.resolve()
      .then(() => this.handleRequest(message))
      .then((result) => {
        if (result !== undefined) this.write({ jsonrpc: '2.0', id: message.id, result });
      })
      .catch((error) => {
        this.write({
          jsonrpc: '2.0',
          id: message.id,
          error: { code: error.code || -32603, message: error.message || String(error) },
        });
      });
  }

  write(payload) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
  }
}
