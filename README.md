# pi-extension-claude-cli

A [pi](https://github.com/earendil-works/pi) provider extension that wraps the local `claude` CLI binary. Auth is handled by whatever `claude` is already logged into — no separate API key or OAuth setup required.

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent
- [Claude CLI](https://claude.ai/download) installed and authenticated

```sh
claude auth login
```

## Install

```sh
pi install path/to/pi-extension-claude-cli
```

## Usage

```sh
pi --provider claude-cli "your prompt"
pi --provider claude-cli --model claude-sonnet-4-6 "your prompt"
```

Available models: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`

## How it works

Spawns `claude -p <prompt> --output-format stream-json` as a subprocess and pipes the streaming events into pi. Tool calls (Bash, Read, Edit, etc.) are executed by the claude subprocess and shown as `▶ ToolName: ...` lines in the pi stream.

## Web search

`WebSearch` and `WebFetch` are pre-granted via `--allowedTools` (in `-p` print mode they're otherwise denied with no way to prompt for permission). Just ask:

```sh
pi --provider claude-cli "search the web for the latest VN-Index close"
```

## Browser interaction (opt-in)

Set `CLAUDE_CLI_BROWSER=1` to attach a browser MCP server that drives a **real browser** via accessibility snapshots — closest to "Claude in Chrome", but token-efficient.

```sh
CLAUDE_CLI_BROWSER=1 pi --provider claude-cli "open example.com and describe the page"
```

Off by default so ordinary prompts don't pay the cost of spawning a browser server.

### Engines — Chrome **or** Firefox/Zen (Gecko)

Two backends share the same token-efficient snapshot model. Pick with `CLAUDE_CLI_BROWSER_ENGINE`:

| Engine | Server | Drives | Protocol |
|---|---|---|---|
| `chrome` (aliases: `chromium`) | [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) | Chrome / Chromium | CDP |
| `firefox` (aliases: `zen`, `gecko`, `mozilla`, `ff`) | [@mozilla/firefox-devtools-mcp](https://github.com/mozilla/firefox-devtools-mcp) | Firefox **and Gecko forks like [Zen](https://zen-browser.app/)** | WebDriver BiDi / Marionette |

If `CLAUDE_CLI_BROWSER_ENGINE` is unset, the engine **auto-detects**: a `CLAUDE_CLI_BROWSER_URL` implies Chrome; otherwise an installed Zen/Firefox binary selects `firefox`; else Chrome.

```sh
# Force the Gecko engine (Zen is auto-detected at /Applications/Zen.app)
CLAUDE_CLI_BROWSER=1 CLAUDE_CLI_BROWSER_ENGINE=zen \
  pi --provider claude-cli "open example.com and describe the page"
```

Firefox/Zen knobs: `CLAUDE_CLI_FIREFOX_PATH` (binary override — defaults to Zen, then Firefox/Dev/Nightly), `CLAUDE_CLI_BROWSER_PROFILE` (reuse a logged-in profile), `CLAUDE_CLI_BROWSER_CONNECT=1` + `CLAUDE_CLI_MARIONETTE_PORT` (attach to a Zen already running with `--marionette` instead of launching one — note: console/network event capture is unavailable in attach mode). `evaluate_script` needs Firefox/Zen on Gecko 153+ (it's a no-op on older builds; the model falls back to snapshots).

First-run / welcome tab: when the extension launches the browser itself (i.e. not `CLAUDE_CLI_BROWSER_CONNECT`), it sets prefs via `moz:firefoxOptions` to suppress the onboarding / "what's new" tab that a fresh or freshly-updated Gecko profile opens — otherwise that extra tab pollutes the first snapshot and can intercept the first navigation/click. Gecko has no `--no-first-run` flag, so this is done with prefs (`browser.aboutwelcome.enabled=false`, `browser.startup.homepage_override.mstone=ignore`, …), applied per-launch only — your real profile is untouched. Append your own with `CLAUDE_CLI_BROWSER_PREFS` (comma- or newline-separated `name=value`). Not applied in attach mode, since the browser is already running.

### Why it's token-efficient

When the browser is attached, a system prompt biases the model toward the **accessibility-tree snapshot** (`take_snapshot`) with stable element refs, and toward `evaluate_script` for reading data — not screenshots. This is the same approach VS Code's native browser tool and `agent-browser` use, and the cost gap is large:

| Representation | Tokens / step |
|---|---|
| Pruned a11y snapshot (refs) | ~200–400 |
| Full DOM dump | ~3,000–5,000 |
| Screenshot | ~4,000–5,000 |

So the model is told: **snapshot first, act by ref, `evaluate_script` to read, screenshot only for genuinely visual bugs** (CSS/layout, canvas, broken rendering). Screenshots — when actually needed — are forced to cheap WebP at reduced size. A screenshot is the *most* expensive per step, not the cheapest; it is the fallback, not the default.

### Connecting to your real browser (humanized sessions)

**Chrome.** By default a dedicated (non-headless, real) Chrome profile is launched. To drive your **own** Chrome with your logins and cookies, start it with remote debugging and point the extension at it:

```sh
# 1. start Chrome with a debugging port
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222

# 2. attach
CLAUDE_CLI_BROWSER=1 CLAUDE_CLI_BROWSER_URL=http://127.0.0.1:9222 \
  pi --provider claude-cli "log into the staging dashboard and run the checkout smoke test"
```

**Zen / Firefox.** Point at your logged-in profile, or attach to a running instance:

```sh
# Reuse your Zen profile (logins/cookies). Find it at about:profiles in Zen.
CLAUDE_CLI_BROWSER=1 CLAUDE_CLI_BROWSER_ENGINE=zen \
  CLAUDE_CLI_BROWSER_PROFILE="$HOME/Library/Application Support/zen/Profiles/<your>.default" \
  pi --provider claude-cli "open the staging dashboard and run the checkout smoke test"

# …or attach to a Zen you already have open (launch it once with --marionette)
/Applications/Zen.app/Contents/MacOS/zen --marionette &
CLAUDE_CLI_BROWSER=1 CLAUDE_CLI_BROWSER_ENGINE=zen CLAUDE_CLI_BROWSER_CONNECT=1 \
  pi --provider claude-cli "audit the page that's currently open for UI bugs"
```

Point `CLAUDE_CLI_BROWSER_CONFIG` at your own MCP-config JSON to swap in a different browser backend entirely (set `CLAUDE_CLI_BROWSER_ENGINE` too so the right `mcp__*` wildcard is allowed).

### Use-case recipes

The browser prompt is tuned for human-like testing. Examples:

```sh
# Smoke test — asserts elements + checks console/network for errors, returns PASS/FAIL
CLAUDE_CLI_BROWSER=1 pi --provider claude-cli \
  "smoke test https://example.com: confirm the nav, hero, and footer render and no console/network errors"

# Regression — compare a flow against expected behavior
CLAUDE_CLI_BROWSER=1 pi --provider claude-cli \
  "go to the login page, sign in with test/test, confirm the dashboard loads with the user's name"

# UI / visual bug bounty — cross-checks snapshot semantics vs rendering
CLAUDE_CLI_BROWSER=1 pi --provider claude-cli \
  "audit https://example.com for UI bugs: overlapping/cut-off elements, broken states, console errors, failed requests"
```

Each example runs against either engine — add `CLAUDE_CLI_BROWSER_ENGINE=zen` to drive Zen/Firefox instead of Chrome.

**Requires a browser on the machine:** Chrome (or Chrome for Testing) for the `chrome` engine, or Firefox/Zen for the `firefox` engine. The matching MCP server (`chrome-devtools-mcp` / `@mozilla/firefox-devtools-mcp`) is fetched via `npx` on first run.

## Acknowledgements

Initial version vibe coded with [Claude Code](https://claude.ai/code).

## License

MIT
