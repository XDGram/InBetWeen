# InBetween

Stay in control while AI works.

This repository starts with the production core: a typed runtime state machine, replaceable AI provider interface, replaceable persistence interface, artifact contracts, and a minimal lifecycle harness.

Core lifecycle:

`idle -> working -> needs_user -> working -> completed/failed`

## Scripts

- `npm run build` compiles TypeScript.
- `npm test` builds and runs the runtime tests.
- `npm run lifecycle` runs the minimal executable lifecycle path using the dev harness provider.

## Environment

Provider configuration is loaded from environment variables. No API keys are hardcoded.

See `.env.example` for the intended shape.
