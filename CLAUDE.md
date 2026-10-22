# CLAUDE.md

## Project Overview

Standalone NestJS inference gateway that proxies E2EE-encrypted chat requests to NEAR AI, plus an
async job subsystem (BullMQ + a Redis job store on the shared `news-persistent-redis` instance) for
large fan-out inference batches delivered via silent Expo push. Deployed to Cloud Run, prod and
staging both live.

| Area | Path |
|------|------|
| Chat proxy | `src/chat/` |
| Async jobs | `src/inference-jobs/` |
| Job queues/workers | `src/queues/` |
| Auth (JWT + capability tokens) | `src/auth/` |
| Plaintext-query exceptions | `src/web-search/`, `src/fact-check-claims/` |
| Attestation proxy | `src/attestation/` |
| Push notifications | `src/notifications/` |
| Composition root | `src/app.module.ts`, `src/main.ts` |

## Commands

`npm run lint`, `npm run typecheck`, `npm run test`, `npm run test:e2e` (needs Redis on
localhost:6379). Full list and traps: `mera-gateway` skill.

Deploys: `main` -> prod, `staging` -> staging (triggers `deploy-news-inference-gateway` and
`-staging` in `mera-infra/cloud-build.tf`). CI (`.github/workflows/node.js.yml`) runs lint,
typecheck, unit+cov, e2e and build on pushes to `main`, `staging` and `dev`.

## Load a skill

Read the skill before the code, even for a one-line fix. It carries this area's map,
invariants and traps.

| Working on | Load |
|---|---|
| Anything in this repo | `mera-gateway` skill: full route table, src/ map, invariants, traps, env vars |

## Invariants

- **E2EE passthrough.** The gateway never reads, logs or transforms message content.
  `web-search` and `fact-check-claims` are the only plaintext routes (no `messages[]`), so never
  write that the gateway never sees plaintext. Bounds: skill.
- **Disabled is never empty.** 503 `search-unavailable`, never `200 + []`. See skill.
- **Job-store access control.** Job lookups always return the owning `userId`; the controller
  403s on mismatch. Request-path lookups are exact-key point reads, never SCAN.

## Deeper docs

`README.md` (onboarding narrative). Everything else: `mera-gateway` skill.
