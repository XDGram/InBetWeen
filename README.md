# InBetween

Stay in control while AI works.

This repository starts with the production core: a typed runtime state machine, protocol-neutral external-agent contracts, a local MCP adapter, replaceable persistence, artifact contracts, and a legacy provider-driven landing-page path kept for compatibility during migration.

Core lifecycle:

`idle -> working -> needs_user -> working -> completed/failed`

## Scripts

- `npm run build` compiles TypeScript.
- `npm test` builds and runs the runtime tests.
- `npm run dev` builds and starts the user-facing interface at `http://127.0.0.1:4173`.
- `npm run mcp` starts the local InBetween MCP stdio server from the built `dist` output.
- `npm run lifecycle:real` runs the real env-configured AI landing-page lifecycle.
- `npm run lifecycle:local` runs the local scripted infrastructure/test harness.
- `npm run persistence:verify` proves a session and its event history survive reopening the local database.

## Environment

Provider and persistence configuration are loaded from environment variables. No API keys are hardcoded.

See `.env.example` for the intended shape.

The frontend uses local SQLite persistence by default at `.inbetween-data/inbetween.sqlite`. Set `INBETWEEN_PERSISTENCE=memory` for an explicitly ephemeral process, or set `INBETWEEN_SQLITE_PATH` so multiple local processes open the same database file.

The MCP server uses the same persistence configuration and does not require an AI provider key. External AI clients connect over stdio and explicitly drive work through InBetween tools while `WorkRuntime` remains the lifecycle authority. For MCP client configuration, prefer invoking the built entrypoint directly (`node dist/src/mcp/run-server.js`) or using a silent npm invocation so stdout remains reserved for MCP protocol messages.

The interface creates a real runtime session, subscribes to committed events over Server-Sent Events, and renders website artifacts in a sandboxed preview. Starting and continuing work use the configured AI provider; missing or invalid provider configuration becomes a visible runtime failure.

While a website session is working, the optional **Shape** action records a non-blocking visual direction such as Minimal or Bold. It remains distinct from a required AI decision, is persisted as a runtime event and user activity, and is included in the provider's later continuation context.
