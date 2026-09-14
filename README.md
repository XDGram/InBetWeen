# InBetween

Stay in control while AI works.

This repository starts with the production core: a typed runtime state machine, replaceable AI provider interface, replaceable persistence interface, artifact contracts, and a real first vertical slice for AI-powered landing-page generation.

Core lifecycle:

`idle -> working -> needs_user -> working -> completed/failed`

## Scripts

- `npm run build` compiles TypeScript.
- `npm test` builds and runs the runtime tests.
- `npm run lifecycle:real` runs the real env-configured AI landing-page lifecycle.
- `npm run lifecycle:local` runs the local scripted infrastructure/test harness.

## Environment

Provider configuration is loaded from environment variables. No API keys are hardcoded.

See `.env.example` for the intended shape.
