# pi-extension-claude-cli

A [pi](https://github.com/earendil-works/pi) provider extension that wraps the local `claude` and `codex` CLI binaries. Auth is handled by whichever CLI is already logged in — no separate API key setup is required.

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent
- [Claude CLI](https://claude.ai/download) and/or [Codex CLI](https://github.com/openai/codex) installed and authenticated

```sh
claude auth login
codex login
```

## Install

```sh
pi install path/to/pi-extension-claude-cli
```

## Usage

```sh
pi --provider claude-cli "your prompt"
pi --provider claude-cli --model claude-sonnet-4-6 "your prompt"
pi --provider codex-cli --model gpt-5.6-luna "your prompt"
```

Available Claude models: `claude-opus-4-8`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`.
Available Codex models: `gpt-5.6-luna`, `gpt-5.5-codex`, `gpt-5.4`.

## How it works

Spawns `claude -p ... --output-format stream-json` or `codex exec --json --full-auto ...` as a subprocess and pipes JSON events into pi. Tool activity is shown as `▶ ...` lines. Override binary locations with `CLAUDE_BIN` and `CODEX_BIN`.

## Acknowledgements

Initial version vibe coded with [Claude Code](https://claude.ai/code).

## License

MIT
