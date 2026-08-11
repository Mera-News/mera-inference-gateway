# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Standalone NestJS inference gateway that proxies E2EE-encrypted chat requests to NEAR AI, plus an
async job subsystem (BullMQ + a dedicated Redis job store) for large fan-out inference batches
delivered via silent Expo push. Deployed to Cloud Run, prod and staging both live.

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

```bash
npm run start:dev      # Development with watch mode
npm run build           # Compile TypeScript
npm run start:prod      # Run compiled output
npm run lint            # ESLint with auto-fix
npm run test            # Unit tests
npm run test:e2e        # End-to-end tests
npm run test:cov        # Test coverage
```

Two triggers deploy this repo (`mera-infra/cloud-build.tf:296` and `:394`): `deploy-news-inference-gateway` (`^main$` -> prod), `deploy-news-inference-gateway-staging` (`^staging$` -> staging).

## Load a skill

| Working on | Load |
|---|---|
| Anything in this repo | `mera-gateway` skill — full route table, src/ map, invariants, traps, env vars |

## Invariants

- **E2EE passthrough.** The gateway never reads, logs, or transforms message content. Both
  `ChatService.proxyChat()` and the async job processors forward ciphertext upstream without
  inspection. `web-search` and `fact-check-claims` are the only routes exempt, because they carry
  no `messages[]` at all — see the skill for exactly how that exception is bounded. Never write
  that the gateway never sees plaintext: on those two routes it does.
- **Disabled is never empty.** `web-search` / `fact-check-claims` return `503
  {"code":"search-unavailable"}` for every state where no search happened. `200 + []` is reserved
  for "searched, index had nothing."
- **Job-store access control.** Job lookups always return the owning `userId`; the controller
  403s on mismatch. Request-path lookups are exact-key point reads on the dedicated
  `inference-redis` instance — never SCAN.

## Deeper docs

- `mera-inference-gateway/README.md` — onboarding narrative
- `mera-gateway` skill — routes, E2EE headers, auth, async job flow, Redis key layout, env vars
