# pi-extension-claude-cli

A [pi](https://github.com/earendil-works/pi) provider extension that wraps the local `claude` CLI binary. Auth is handled by whatever `claude` is already logged into — no separate API key or OAuth setup required.

## Requirements

- [pi](https://github.com/earendil-works/pi) coding agent
- [Claude CLI](https://claude.ai/download) installed and authenticated

```sh
claude auth login
```

## Install

This extension ships as the `claude-cli/` submodule of the `pi-agent-extensions`
bundle, which is the usual way to install it. Develop it here and bump the
submodule pointer in the bundle afterward.

To install it on its own:

```sh
pi install path/to/pi-extension-claude-cli
```

## Usage

```sh
pi --provider claude-cli "your prompt"
pi --provider claude-cli --model claude-opus-5 "your prompt"
```

Available models: `claude-fable-5`, `claude-opus-5-5`, `claude-opus-5`, `claude-opus-4-8`, `claude-sonnet-5-5`, `claude-sonnet-5`, `claude-sonnet-4-6`, `claude-haiku-4-5-20251001`

## How it works

The extension spawns `claude -p <prompt> --output-format stream-json` as a subprocess and pipes its response into Pi.

Pi remains responsible for tools:

- Claude's native tools, plugins, hooks, and MCP servers are disabled for the subprocess.
- The currently active Pi tools and their schemas are supplied through an authenticated, capture-only loopback MCP bridge, with structured output as a fallback.
- The MCP bridge records requests but never executes tool implementations; requested calls are emitted as real Pi `ToolCall` blocks.
- Pi validates and executes each call, emits the normal tool lifecycle events, and returns the result on the next turn.
- The loopback server uses an ephemeral port and per-turn bearer token, then removes its temporary config when the turn ends.

This means Pi options such as `--tools write` and `--exclude-tools bash` are respected by the `claude-cli` provider. A recent Claude CLI with `--json-schema`, `--setting-sources`, and streamable HTTP MCP support is required.

## Acknowledgements

Initial version vibe coded with [Claude Code](https://claude.ai/code).

## License

MIT
