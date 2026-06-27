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

## License

MIT
