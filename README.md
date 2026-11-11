<img src="assets/icon.svg" width="64" height="64" alt="">

# gemini-app-driver

Drive the **Gemini desktop app for Windows** from an agent. It exposes the app's
Chromium page over the Chrome DevTools Protocol and ships a small CLI plus an
MCP (Model Context Protocol) server, so an agent can send prompts, read answers,
manage conversations, and take screenshots — using the Google account already
signed in inside the app.

No API key, no browser automation of gemini.google.com, no copy-pasting.

**Action map:** https://ajinkyajacob.github.io/gemini-app-driver/ — a visual
diagram of every CLI command and MCP tool, published from `docs/` via GitHub
Pages and rebuilt on every push.

## Why this works

The Gemini Windows app is Electron (v1.18.0, Chromium 152). It checks its own
command line and refuses to start if a debugging switch such as
`--remote-debugging-port` is present. The check is a single boolean in the
bundled `main.js`:

```js
var Pg = wg(h.app.isPackaged && P!=="dev", process.argv, process.execArgv);
Pg ? (log + app.exit(1)) : start()
```

`setup` flips that argument to `false` with a byte-for-byte, same-length patch
inside `app.asar` (so the archive's header and integrity hashes stay valid), then
starts the app with the DevTools port. The original archive is kept next to it as
`app.asar.driver-backup`, and `restore` puts it back.

The driver then attaches to the `https://gemini.google.com/app` target and works
through the page's own DOM (composer, send button, `user-query` / `model-response`
elements). It enables CDP focus emulation so answers render even when the app
window is minimized or behind other windows, without stealing your focus.

## Requirements

- Windows, Node.js 22+ (uses the built-in `fetch` and `WebSocket`).
- The Gemini desktop app installed and signed in.
- Nothing to `npm install` — the driver has no dependencies.

## Quick start

```powershell
cd C:\Users\ajink\.t3\projects\gemini-app-driver

node bin\gemini-app-driver.js setup
node bin\gemini-app-driver.js status
node bin\gemini-app-driver.js ask --new-chat "Reply with exactly: hello"
node bin\gemini-app-driver.js mode task
node bin\gemini-app-driver.js read
```

`setup` restarts the app once. Any later `ask`/`read` reuses the same port; if the
app was restarted normally, the next command re-applies the patch and restarts it
again.

> After the app updates itself (`app-<version>` changes), run `setup` again. It
> always targets the newest installed version.

## CLI

```
node bin/gemini-app-driver.js setup [--port 9333]
node bin/gemini-app-driver.js restore
node bin/gemini-app-driver.js status
node bin/gemini-app-driver.js login [--timeout ms]
node bin/gemini-app-driver.js ask [--new-chat] [--mode chat|task] [--tool "Create image"] [--attach path[,path]] [--timeout ms] [--json] <prompt>
node bin/gemini-app-driver.js mode [chat|task]
node bin/gemini-app-driver.js model [name]
node bin/gemini-app-driver.js thinking [low|medium|high]
node bin/gemini-app-driver.js tools
node bin/gemini-app-driver.js tool <name> [on|off]
node bin/gemini-app-driver.js attach <path...>
node bin/gemini-app-driver.js read [--json]
node bin/gemini-app-driver.js new-chat [--mode chat|task]
node bin/gemini-app-driver.js conversations [--limit n]
node bin/gemini-app-driver.js notebooks [--limit n]
node bin/gemini-app-driver.js open-notebook <id|title>
node bin/gemini-app-driver.js notebook-chats
node bin/gemini-app-driver.js open-notebook-chat <title>
node bin/gemini-app-driver.js new-notebook <name>
node bin/gemini-app-driver.js rename-notebook <name>
node bin/gemini-app-driver.js delete-notebook
node bin/gemini-app-driver.js open <id|partial title>
node bin/gemini-app-driver.js stop
node bin/gemini-app-driver.js screenshot [path]
node bin/gemini-app-driver.js mcp
```

Examples:

```powershell
# Follow-up in the current conversation
node bin\gemini-app-driver.js ask "Now summarise that in three bullets"

# Read the transcript as JSON
node bin\gemini-app-driver.js read --json

# Open an older conversation by title fragment
node bin\gemini-app-driver.js open "tea history"

# Save a PNG of the current page
node bin\gemini-app-driver.js screenshot C:\temp\gemini.png
```

`ask` waits for streaming to finish and prints the answer. If generation is
stopped (with `stop` or the in-app button) before any text appears, it returns an
empty answer with `"stopped": true` instead of hanging.

## MCP server

```powershell
node bin\gemini-app-driver.js mcp
```

It speaks newline-delimited JSON-RPC 2.0 on stdio. Register it with any MCP
client, for example:

```json
{
  "mcpServers": {
    "gemini-app": {
      "command": "node",
      "args": ["C:\\Users\\ajink\\.t3\\projects\\gemini-app-driver\\bin\\gemini-app-driver.js", "mcp"]
    }
  }
}
```

### Tools

| Tool | Arguments | What it does |
| --- | --- | --- |
| `gemini_status` | — | Version, patch state, app/CDP state, auth state, current conversation, model, streaming |
| `gemini_setup` | `port?` | Patch the app and restart it in debug mode (re-run after updates) |
| `gemini_restore` | — | Restore the original `app.asar` and restart normally |
| `gemini_login` | `timeout_ms?` | Bring the app forward and wait for sign-in to finish; returns `signedIn` + account |
| `gemini_ask` | `prompt`, `new_chat?`, `mode?`, `thinking?`, `tools?`, `attachments?`, `timeout_ms?` | Send a prompt, wait for completion, return `{answer, images, conversationId, url, timedOut}` |
| `gemini_model` | `model?` | List models or switch model (`3.8 Flash`, `3.1 Pro`, `4 Argon`, …) |
| `gemini_thinking` | `level?` | Read or switch the Thinking level (`low` / `medium` / `high`) |
| `gemini_tools` | — | List composer tools and their on/off state |
| `gemini_tool` | `tool`, `enabled?` | Enable/disable a tool (`Create image`, `Create video`, `Canvas`, `Deep Research`, …) |
| `gemini_attach` | `paths[]` | Upload local files (media vs documents routed automatically) |
| `gemini_mode` | `mode?` | Read or switch Chat/Task mode (`chat` / `task`) |
| `gemini_read` | — | Current conversation as ordered `{role, text}` messages |
| `gemini_new_chat` | `mode?` | Start a fresh conversation in Chat or Task mode |
| `gemini_conversations` | `limit?` | Sidebar conversations (`id`, `title`, `href`) |
| `gemini_notebooks` | `limit?` | Notebooks from the sidebar (`id`, `title`, open one marked) |
| `gemini_open_notebook` | `notebook` | Open a notebook by id or partial title; returns past chats |
| `gemini_notebook_chats` | — | Past chats recorded in the open notebook |
| `gemini_open_notebook_chat` | `title` | Open a past chat in the open notebook |
| `gemini_new_notebook` | `name` | Create a notebook via `/notebooks/create` and open it |
| `gemini_rename_notebook` | `name` | Rename the open notebook |
| `gemini_delete_notebook` | — | Delete the open notebook (destructive, "Delete everywhere") |
| `gemini_open` | `conversation` | Open by id or partial title; returns its messages |
| `gemini_stop` | — | Stop an in-flight response |
| `gemini_screenshot` | `path?` | Page screenshot as an MCP image (+ saved path) |

## Notebooks

The sidebar **Notebooks** section (Gemini's NotebookLM-backed projects, routes
`/notebook/<uuid>`) is mapped too:

```powershell
node bin\gemini-app-driver.js notebooks
node bin\gemini-app-driver.js open-notebook "Rust learning"
node bin\gemini-app-driver.js notebook-chats
node bin\gemini-app-driver.js open-notebook-chat "Simple Confirmation"
node bin\gemini-app-driver.js new-notebook "Weekly research"
node bin\gemini-app-driver.js rename-notebook "Weekly research v2"
node bin\gemini-app-driver.js delete-notebook   # "Delete everywhere" confirmation
```

- `new-notebook` drives `/notebooks/create`: it fills the name and presses
  **Create notebook**, then confirms the new `/notebook/<uuid>` route.
- `rename-notebook` / `delete-notebook` use the notebook's settings menu
  (Pin/Rename/Delete). Delete is destructive and wipes the notebook from both
  Gemini and NotebookLM; the driver intentionally requires you to call it.
- Asking from a notebook (`ask`) works: the chat opens as an `/app/<id>`
  conversation but is recorded under the notebook's **Past chats**, so the
  result reports the originating `notebookId`.
- **Not automated:** the "Add sources" picker and NotebookLM source management.
  Use the app for adding/removing sources; open, chat, rename, and delete are
  covered.

## Sign-in and auth

The driver rides the Google session already present in the desktop app. It never
enters credentials and never asks for your password.

- `status` reports `auth.state` as `signed-in`, `sign-in-required`, or `unknown`,
  plus the signed-in `account` email and a `hint`.
- Detection covers both the app's own sign-in screen
  (`app://bundle/src/sign_in/sign_in.html`) and an OAuth redirect to
  `accounts.google.com`. In either case, page actions fail with
  `SIGN_IN_REQUIRED` and say what to do.
- `login` brings the app window forward and waits for you to finish signing in,
  then returns `{signedIn, url, account}`. Over MCP: `gemini_login`.

```powershell
node bin\gemini-app-driver.js status
node bin\gemini-app-driver.js login --timeout 300000
```

If the session expires mid-run, the next action returns the same sign-in error;
run `login` once and retry. Nothing restarts or patches differently for auth —
`setup` also reports the auth state after launching.

## Chat vs Task mode

On a new chat the composer offers a segmented **Chat / Task** control. Chat is the
normal "Ask Gemini" mode; Task reframes the composer for task descriptions
("Describe a task") and swaps the suggested prompts. The driver reads the
selected segment and can switch it:

```powershell
node bin\gemini-app-driver.js mode            # {"mode":"chat","options":["chat","task"]}
node bin\gemini-app-driver.js mode task
node bin\gemini-app-driver.js ask --new-chat --mode task "Plan a 3-day Osaka itinerary"
```

The mode control only exists in a new chat, so passing `mode` in an existing
conversation returns an error telling you to start a new chat. `status` reports
the current `mode` and `modeOptions`; in an existing conversation `mode` is `null`.
Note this is unrelated to the model picker (`Argon`), which is reported as
`model`.

## Composer toolbar: model, thinking, tools, uploads

The composer toolbar (model pill, `+` button, mic) is mapped as well.

**Model picker** — the pill labelled with the current model (e.g. `Argon`) opens
the model menu plus a "Thinking level" submenu:

```powershell
node bin\gemini-app-driver.js model          # current + options
node bin\gemini-app-driver.js model "3.8 Flash"
node bin\gemini-app-driver.js thinking high   # low | medium | high
```

Typical options are `3.5 Flash-Lite`, `3.8 Flash`, `3.1 Pro`, `4 Argon`. The pill
shows the short display name (`Flash` for `3.8 Flash`), so the driver verifies by
selected state, not just the label.

**Tools menu** — the `+` ("Upload and tools") button:

| Item | What it does | Driver |
| --- | --- | --- |
| Upload files | documents, data, code | `attach` routes files here |
| (image upload) | images/video | `attach` routes media here |
| Add from Drive | Sheets/Docs/Slides picker | listed, requires manual Drive picking |
| More uploads | additional local uploads | listed |
| Create image | toggles image generation | `tool "Create image" on` |
| Create video | toggles video generation | `tool "Create video" on` |
| More tools | Create music, Canvas, Deep Research, Guided Learning, Personal Intelligence | `tool "<name>" on/off` |

```powershell
node bin\gemini-app-driver.js tools
node bin\gemini-app-driver.js tool "Deep Research" on
node bin\gemini-app-driver.js tool "Create image" off
```

**Uploads** — `attach` resolves absolute paths, splits media (`png/jpg/gif/webp/
mp4/mov/…`) from documents/code/data, and sets files on the matching hidden
`input[type=file]` through CDP, then waits for the preview chips to appear:

```powershell
node bin\gemini-app-driver.js attach C:\docs\report.pdf C:\img\shot.png
node bin\gemini-app-driver.js ask --new-chat --attach C:\docs\report.pdf "Summarise this in 3 bullets"
```

**Generating images** — enable the tool, then send the prompt. The answer has no
text, so `ask` reports `images` instead:

```powershell
node bin\gemini-app-driver.js ask --new-chat --tool "Create image" "A flat red circle on white"
# {"text":"","images":1,...}
```

Use `screenshot` to capture the generated image. Over MCP the same calls are
`gemini_model`, `gemini_thinking`, `gemini_tools`, `gemini_tool`, `gemini_attach`,
and `gemini_ask` accepts `tools`, `attachments`, and `thinking`.

## How it is put together

| File | Purpose |
| --- | --- |
| `src/paths.js` | Finds the newest `app-<version>` install, `app.asar`, launcher |
| `src/guard.js` | Same-size patch/restore of the DevTools-switch check, with backup |
| `src/app.js` | Quit/launch Gemini with the debug port, wait for CDP, orchestrate setup/restore |
| `src/cdp.js` | Dependency-free CDP WebSocket client (evaluate, navigate, screenshot) |
| `src/gemini.js` | High-level operations: prompt, send, wait, transcript, conversations, stop |
| `src/mcp.js` | MCP stdio server and tool handlers |
| `src/cli.js` | CLI commands |
| `bin/gemini-app-driver.js` | Entry point |

Operational notes:

- The DevTools port binds to `127.0.0.1` only. While it is open, any local process
  can drive the signed-in Gemini session — use `restore` when you are done.
- `setup` restarts the app, which closes the current window. Anything unsent in
  the composer is lost.
- Everything is read from the live DOM, so a future app redesign can break
  selectors. `status` is the quickest way to check the page is understood.
- Screenshots show what the renderer paints; the page is treated as focused even
  when the window is not, so answers are visible.

## Environment

- `GEMINI_DRIVER_PORT` — DevTools port (default `9333`).
