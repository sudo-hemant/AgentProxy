# AgentProxy

AgentProxy lets your AI coding agent mock the API responses of a web app running on your machine, in your own Chrome. You don't configure anything by hand.

Ask your agent *"make `GET /api/orders` return a 500 and check how the page handles it"*. The agent:
1. sets the mock;
2. reloads the page and checks the result;
3. confirms the mock was hit;
4. clears it, or lets it expire on its own.

It works with any frontend framework and needs no changes to your app.

## How it works

```
AI agent ──MCP (stdio)──► AgentProxy server ◄──WebSocket on 127.0.0.1── Chrome extension ──► your localhost page
```

- **The server** runs on your machine. It gives the agent its tools and holds the mocks.
- **The Chrome extension** connects to the server. It replaces `fetch` and `XMLHttpRequest` inside your `localhost` pages, so matching requests get the mock without touching the network. Every other request goes out unchanged, with its cookies and login token.

## Requirements

- Node.js 20 or newer, and pnpm 10 (`corepack enable` sets pnpm up)
- Google Chrome (or Chromium)
- An MCP-capable agent. Setup registers with Claude Code automatically, and prints a config for others.

## Setup

```sh
git clone https://github.com/sudo-hemant/AgentProxy.git
cd AgentProxy
pnpm install
pnpm run setup
```

`pnpm run setup`:
1. builds everything;
2. pairs the extension with the server;
3. registers the server with Claude Code at user scope, so it's available in every project;
4. prints the folder to load in Chrome.

Then load the extension:
1. Open `chrome://extensions` and turn on **Developer mode**.
2. Click **Load unpacked** and choose `packages/extension/dist` in this repo.

Start a new agent session. Your agent can now use AgentProxy. A good first check is to ask it for AgentProxy's status.

**Options:**
- **Register in a different Claude Code scope:** `pnpm run setup --scope project` or `pnpm run setup --scope local`.
- **Another agent:** if the `claude` command isn't installed, setup prints an `mcpServers` entry to add to your agent's MCP config.
- **Pair only, without registering:** `pnpm run setup --no-register`.

## Try it

Run your app on `localhost` and open it in Chrome. Then ask your agent something like:

> Make `GET /api/orders` return a 500 with `{"error": "boom"}`, reload the page, check that the error state shows, and confirm the mock was hit.

## Tools

| Tool | What it does |
|---|---|
| `set_mock` | Mocks matching requests with a status, body and headers. Only `url` is required. The other fields are `match_type` (`wildcard` by default, or `exact`, `domain`, `regex`), `method`, `status` (200–599), `body`, `headers`, `expires_in_seconds` and `id`. Mocks last 10 minutes by default, 24 hours at most. Setting the same `id` again replaces a mock. |
| `list_mocks` | Lists the mocks in effect. When several match, the newest wins. |
| `clear_mocks` | Removes all mocks, or the given `ids`. |
| `get_matches` | Shows which requests each mock answered, to confirm a mock took effect. |
| `status` | Shows whether the extension is connected, and what to do if it isn't. |

## Troubleshooting

Ask your agent for AgentProxy's `status` first. Its `note` says what's wrong.

- **"No browser is connected"**
  - Check the extension is loaded and enabled in `chrome://extensions`.
  - The server starts with your agent session, and the extension connects within 30 seconds of that, usually at once.
- **"Port 47821 is already in use"**
  - Another AgentProxy is running, for example from another agent session. Close it.
  - Or set `AGENTPROXY_PORT` to another port and rerun `pnpm run setup` with it, so the extension is paired with that port.
- **"The extension can't be paired"** means the extension hasn't been built. Run `pnpm run setup` again.
- **A mock doesn't apply:**
  - Mocks apply to requests made after they're set. Reload the page or repeat the action.
  - Check the pattern with `list_mocks`, and `get_matches` to see what matched.

## Limits

- **Only `localhost` pages are covered.**
- **Only requests the page makes with `fetch` or `XMLHttpRequest` (including axios) can be mocked.** That excludes images, scripts, and requests from web workers or service workers.
- **Server-side requests** (SSR, API routes) never pass through the browser, so they can't be mocked.
- **Mocked requests don't appear in the DevTools Network tab.**
- **Your browser:** the extension is loaded from this repo's folder; it isn't in the Chrome Web Store yet. Only Chrome and Chromium are supported.

## Development

```sh
pnpm build        # build all packages
pnpm test         # unit tests
pnpm test:e2e     # browser tests: the extension in Chromium against a test app
pnpm lint         # Biome
pnpm typecheck
```

The design is in [`docs/overview.md`](docs/overview.md), the plan in [`docs/plan.md`](docs/plan.md), and progress and decisions in [`docs/status.md`](docs/status.md).
