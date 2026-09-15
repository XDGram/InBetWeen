# InBetween

Stay in control while AI works.

This repository starts with the production core: a typed runtime state machine, replaceable AI provider interface, replaceable persistence interface, artifact contracts, and a real first vertical slice for AI-powered landing-page generation.

Core lifecycle:

`idle -> working -> needs_user -> working -> completed/failed`

## Scripts

- `npm run build` compiles TypeScript.
- `npm test` builds and runs the runtime tests.
- `npm run dev` builds and starts the user-facing interface at `http://127.0.0.1:4173`.
- `npm run lifecycle:real` runs the real env-configured AI landing-page lifecycle.
- `npm run lifecycle:local` runs the local scripted infrastructure/test harness.
- `npm run persistence:verify` proves a session and its event history survive reopening the local database.

## Environment

Provider and persistence configuration are loaded from environment variables. No API keys are hardcoded.

See `.env.example` for the intended shape.

The frontend uses local SQLite persistence by default at `.inbetween-data/inbetween.sqlite`. Set `INBETWEEN_PERSISTENCE=memory` for an explicitly ephemeral process, or set `INBETWEEN_SQLITE_PATH` so multiple local processes open the same database file.

The interface creates a real runtime session, subscribes to committed events over Server-Sent Events, and renders website artifacts in a sandboxed preview. Starting and continuing work use the configured AI provider; missing or invalid provider configuration becomes a visible runtime failure.

While a website session is working, the optional **Shape** action records a non-blocking visual direction such as Minimal or Bold. It remains distinct from a required AI decision, is persisted as a runtime event and user activity, and is included in the provider's later continuation context.
