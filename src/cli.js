import path from 'node:path';
import { DEFAULT_PORT, ensureCdp, isCdpAlive, isRunning, restore, setup } from './app.js';
import { GeminiApp } from './gemini.js';
import { guardStatus } from './guard.js';
import { McpServer } from './mcp.js';
import { resolveInstall } from './paths.js';

const HELP = `gemini-app-driver — drive the Gemini desktop app from an agent

Usage:
  gemini-app-driver setup [--port 9333]        patch the app and restart it with DevTools enabled
  gemini-app-driver restore                    restore the original app.asar and restart normally
  gemini-app-driver status                     show install, patch, app, auth and page state
  gemini-app-driver login [--timeout <ms>]     surface the app window and wait for sign-in to finish
  gemini-app-driver ask [options] <prompt>     send a prompt and print the answer
      --new-chat                               start a new conversation first
      --mode chat|task                         select Chat or Task mode (new chats only)
      --thinking low|medium|high               set the thinking level
      --tool "Create image"                    enable a composer tool before sending (comma-separated)
      --attach <path[,path]>                   attach local files before sending
      --timeout <ms>                           max wait for the answer (default 180000)
      --json                                   print the full JSON result
  gemini-app-driver mode [chat|task]           read or switch the new-chat mode
  gemini-app-driver model [name]               list models or switch the current model
  gemini-app-driver thinking [low|medium|high] read or switch the thinking level
  gemini-app-driver tools                      list the composer tools menu
  gemini-app-driver tool <name> [on|off]       enable/disable a composer tool
  gemini-app-driver attach <path...>           attach local files to the composer
  gemini-app-driver read [--json]              print the current conversation transcript
  gemini-app-driver new-chat [--mode chat|task] start a new conversation
  gemini-app-driver conversations [--limit n]  list sidebar conversations
  gemini-app-driver notebooks [--limit n]      list Gemini notebooks
  gemini-app-driver open-notebook <id|title>   open a notebook
  gemini-app-driver notebook-chats             list past chats in the open notebook
  gemini-app-driver open-notebook-chat <title> open a past chat in the open notebook
  gemini-app-driver new-notebook <name>        create a notebook
  gemini-app-driver rename-notebook <name>     rename the open notebook
  gemini-app-driver delete-notebook            delete the open notebook (asks nothing)
  gemini-app-driver open <id|title>            open a conversation
  gemini-app-driver stop                       stop an in-flight response
  gemini-app-driver screenshot [path]          save a PNG of the Gemini page
  gemini-app-driver mcp                        run the MCP server on stdio

Environment:
  GEMINI_DRIVER_PORT   DevTools port (default 9333)
`;

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg.startsWith('--')) {
      const [name, inline] = arg.slice(2).split('=');
      if (inline !== undefined) {
        flags[name] = inline;
      } else if (['new-chat', 'json', 'help'].includes(name)) {
        flags[name] = true;
      } else {
        flags[name] = argv[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return { positional, flags };
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

export async function main(argv = process.argv.slice(2)) {
  const { positional, flags } = parseArgs(argv);
  const command = positional.shift() || 'help';
  const port = Number(flags.port || DEFAULT_PORT);
  const log = (line) => process.stderr.write(`[gemini-driver] ${line}\n`);

  if (command === 'help' || flags.help) {
    process.stdout.write(HELP);
    return;
  }

  if (command === 'mcp') {
    new McpServer({ port }).start();
    return;
  }

  const app = new GeminiApp({ port, log });

  try {
    switch (command) {
      case 'setup': {
        const result = await setup({ port, log });
        process.stdout.write(
          `${JSON.stringify(
            {
              ok: true,
              port,
              version: result.install.version,
              patched: result.guard.state,
              auth: result.auth || 'unknown',
              asar: result.install.asarPath,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      case 'restore': {
        const result = await restore({ port, log });
        process.stdout.write(`${JSON.stringify({ ok: true, restored: result.changed, state: result.state }, null, 2)}\n`);
        return;
      }

      case 'status': {
        const install = resolveInstall();
        const guard = guardStatus(install);
        const status = {
          installedVersion: install.version,
          installRoot: install.root,
          guardState: guard.state,
          running: await isRunning(),
          cdp: await isCdpAlive(port),
          port,
        };
        if (status.cdp) {
          const auth = await app.authStatus().catch((error) => ({ state: 'unknown', hint: error.message }));
          status.auth = {
            state: auth.state,
            account: auth.account || null,
            url: auth.url || null,
            hint: auth.hint || null,
          };
          if (auth.state === 'signed-in') {
            const snap = await app.snapshot().catch(() => null);
            if (snap) {
              status.page = {
                url: snap.url,
                conversationId: snap.conversationId,
                model: snap.model,
                mode: snap.mode,
                modeOptions: snap.modeOptions,
                streaming: snap.streaming,
                messages: snap.messages.length,
              };
            }
          }
        }
        process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
        return;
      }

      case 'login': {
        await ensureCdp({ port, log });
        const result = await app.login({ timeoutMs: Number(flags.timeout || 300000) });
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        if (!result.signedIn) process.exitCode = 2;
        return;
      }

      case 'mode': {
        const mode = positional[0];
        await ensureCdp({ port, log });
        if (!mode) {
          const snap = await app.snapshot();
          process.stdout.write(
            `${JSON.stringify(
              {
                mode: snap.mode,
                options: snap.modeOptions,
                placeholder: snap.editorPlaceholder,
                conversationId: snap.conversationId,
                selectable: snap.modeOptions.length > 0,
              },
              null,
              2,
            )}\n`,
          );
        } else {
          const result = await app.setMode(mode);
          process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
        }
        return;
      }

      case 'model': {
        await ensureCdp({ port, log });
        const name = positional[0];
        if (!name) {
          const result = await app.models();
          if (flags.json) {
            process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
          } else {
            process.stdout.write(`current: ${result.current}\n`);
            for (const model of result.models) {
              process.stdout.write(`${model.selected ? '*' : ' '} ${model.name}${model.description ? `  (${model.description})` : ''}\n`);
            }
            if (result.thinking?.level) {
              process.stdout.write(`thinking: ${result.thinking.level} (${result.thinking.options.join(', ')})\n`);
            }
          }
        } else {
          const result = await app.setModel(name);
          process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
        }
        return;
      }

      case 'thinking': {
        await ensureCdp({ port, log });
        const level = positional[0];
        if (!level) {
          process.stdout.write(`${JSON.stringify(await app.thinking(), null, 2)}\n`);
        } else {
          process.stdout.write(`${JSON.stringify({ ok: true, ...(await app.setThinking(level)) }, null, 2)}\n`);
        }
        return;
      }

      case 'tools': {
        await ensureCdp({ port, log });
        const result = await app.tools();
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          for (const item of result.tools) {
            const state = item.checked === null ? '' : ` [${item.checked === 'true' ? 'on' : 'off'}]`;
            process.stdout.write(`${item.name}${state}\n`);
          }
          for (const item of result.moreTools) {
            const state = item.checked === null ? '' : ` [${item.checked === 'true' ? 'on' : 'off'}]`;
            process.stdout.write(`  ${item.name}${state}\n`);
          }
        }
        return;
      }

      case 'tool': {
        const name = positional[0];
        if (!name) throw new Error('Missing tool name. Usage: gemini-app-driver tool "Create image" [on|off]');
        const desired = (positional[1] || 'on').toLowerCase();
        const enabled = !['off', 'false', '0', 'disable', 'disabled'].includes(desired);
        await ensureCdp({ port, log });
        process.stdout.write(`${JSON.stringify(await app.setTool(name, enabled), null, 2)}\n`);
        return;
      }

      case 'attach': {
        if (positional.length === 0) throw new Error('Missing file paths. Usage: gemini-app-driver attach <path...>');
        await ensureCdp({ port, log });
        process.stdout.write(`${JSON.stringify(await app.attach(positional), null, 2)}\n`);
        return;
      }

      case 'ask': {
        const prompt = positional.join(' ').trim();
        if (!prompt) throw new Error('Missing prompt. Usage: gemini-app-driver ask "..."');
        await ensureCdp({ port, log });
        const result = await app.ask(prompt, {
          newChat: Boolean(flags['new-chat']),
          mode: flags.mode,
          thinking: flags.thinking,
          tools: flags.tool ? String(flags.tool).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          attachments: flags.attach ? String(flags.attach).split(',').map((s) => s.trim()).filter(Boolean) : undefined,
          timeoutMs: Number(flags.timeout || 180000),
        });
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          process.stdout.write(`${result.text}\n`);
          if (result.timedOut) log('response still streaming at timeout; text above is partial');
        }
        return;
      }

      case 'read': {
        await ensureCdp({ port, log });
        const transcript = await app.transcript();
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(transcript, null, 2)}\n`);
        } else {
          for (const message of transcript.messages) {
            process.stdout.write(`\n[${message.role}]\n${message.text}\n`);
          }
        }
        return;
      }

      case 'new-chat': {
        await ensureCdp({ port, log });
        const result = await app.newChat({ mode: flags.mode });
        process.stdout.write(`${JSON.stringify({ ok: true, ...result }, null, 2)}\n`);
        return;
      }

      case 'conversations': {
        await ensureCdp({ port, log });
        const result = await app.conversations({ limit: Number(flags.limit || 50) });
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          for (const conversation of result.conversations) {
            process.stdout.write(`${conversation.id}  ${conversation.title}\n`);
          }
        }
        return;
      }

      case 'notebooks': {
        await ensureCdp({ port, log });
        const result = await app.notebooks({ limit: Number(flags.limit || 50) });
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          for (const notebook of result.notebooks) {
            const marker = notebook.id === result.currentNotebook ? '*' : ' ';
            process.stdout.write(`${marker} ${notebook.id}  ${notebook.title}\n`);
          }
        }
        return;
      }

      case 'open-notebook': {
        const query = positional.join(' ').trim();
        if (!query) throw new Error('Missing notebook id or title.');
        await ensureCdp({ port, log });
        process.stdout.write(`${JSON.stringify(await app.openNotebook(query), null, 2)}\n`);
        return;
      }

      case 'notebook-chats': {
        await ensureCdp({ port, log });
        const result = await app.notebookChats();
        if (flags.json) {
          process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        } else {
          for (const chat of result.chats) {
            process.stdout.write(`${chat.when ? `${chat.when}  ` : ''}${chat.title}\n`);
          }
        }
        return;
      }

      case 'open-notebook-chat': {
        const title = positional.join(' ').trim();
        if (!title) throw new Error('Missing notebook chat title.');
        await ensureCdp({ port, log });
        process.stdout.write(`${JSON.stringify(await app.openNotebookChat(title), null, 2)}\n`);
        return;
      }

      case 'new-notebook': {
        const name = positional.join(' ').trim();
        if (!name) throw new Error('Missing notebook name.');
        await ensureCdp({ port, log });
        process.stdout.write(`${JSON.stringify(await app.newNotebook(name), null, 2)}\n`);
        return;
      }

      case 'rename-notebook': {
        const name = positional.join(' ').trim();
        if (!name) throw new Error('Missing new notebook name.');
        await ensureCdp({ port, log });
        process.stdout.write(`${JSON.stringify(await app.renameNotebook(name), null, 2)}\n`);
        return;
      }

      case 'delete-notebook': {
        await ensureCdp({ port, log });
        process.stdout.write(`${JSON.stringify(await app.deleteNotebook(), null, 2)}\n`);
        return;
      }

      case 'open': {
        const query = positional.join(' ').trim();
        if (!query) throw new Error('Missing conversation id or title.');
        await ensureCdp({ port, log });
        const result = await app.openConversation(query);
        process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
        return;
      }

      case 'stop': {
        await ensureCdp({ port, log });
        process.stdout.write(`${JSON.stringify(await app.stop(), null, 2)}\n`);
        return;
      }

      case 'screenshot': {
        await ensureCdp({ port, log });
        const target = positional[0] || path.join(process.cwd(), 'screenshots', `gemini-${stamp()}.png`);
        const saved = await app.screenshotTo(target);
        process.stdout.write(`${saved.path}\n`);
        return;
      }

      default:
        throw new Error(`Unknown command: ${command}\n\n${HELP}`);
    }
  } finally {
    app.dispose();
  }
}
