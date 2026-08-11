# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Model Usage Policy

**Do it yourself when the context is already loaded and the change is small — ≤3 files and
~150 lines.** A cold subagent costs ~30–60s of warm-up plus context rediscovery, so delegating
under that line is slower *and* dearer. Past it, or whenever work can run in parallel, delegate.
Applies to **Fable and Opus alike**.

### Delegate — match the row, don't deliberate

| Situation | Action |
|---|---|
| ≤3 files, ~150 lines, context already loaded | Do it yourself |
| Must be serialized in one file | Do it yourself — never two agents on one file |
| >3 files or >150 lines, or spans repos | Delegate |
| ≥3 independent units that can run at once | Delegate, 1 agent per unit |
| ≥5 near-identical edits (locales, DTOs, call sites) | Delegate, batched across Haiku agents |
| Investigation that would flood context | Delegate to `Explore` |

Units that share an undecided question are **not** independent. Decide it first and repeat the
answer in every prompt, or keep them in one agent — parallel agents inventing their own answers
to the same question is the top failure mode of fan-out.

### Model per agent

| Model | Use for |
|---|---|
| **Opus** | Tricky logic, cross-cutting or multi-repo changes, large files, and any scout that may later implement |
| **Sonnet** | Well-scoped single-concern work: one feature file, one service, one test suite |
| **Haiku** | Mechanical volume: locale translations, string/import/rename sweeps, boilerplate, log triage |

### Plan with scouts, then reuse them

For multi-area work, spawn one **Opus** scout per area to plan that area — use
`general-purpose`, not `Plan`/`Explore`, which are read-only and can't implement. Then implement
by `SendMessage`-ing the same agent: it resumes with its context intact and near-zero warm-up.
A resumed agent keeps its spawn-time model, so spawn scouts at the model that should write the code.

**How many:** 3–6 units → 1 agent each; 7–15 → batch into 6–10; 16+ → batch into 12–24.
Ceiling 24 concurrent (Opus ≤6, Sonnet ≤12, Haiku ≤24). Send every agent for a stage in **one
message** so they actually run concurrently.

Every subagent prompt states: **objective, absolute file paths, decisions already made,
constraints, output format, and what is out of scope.** Tell scouts to escalate ambiguity rather
than guess. Never `git stash` / `git reset` in a subagent — they share this working tree.

## Project Overview

Standalone NestJS inference gateway that proxies E2EE-encrypted chat requests to NEAR AI. On the inference path the gateway **never decrypts or inspects message content** — it authenticates requests via JWT and forwards encrypted payloads to NEAR AI's TEE-protected inference. An async job subsystem (BullMQ + a dedicated Redis job store) handles large fan-out inference batches and delivers results via silent Expo push notifications.

**Two routes are deliberately outside that guarantee: `POST /v1/web-search` and `POST /v1/fact-check-claims`.** They take the user's search terms in **plaintext**, because a third-party index (Brave; Google's Fact Check Tools / ClaimReview corpus) cannot be queried with ciphertext. Both are opt-in and off by default (`BRAVE_SEARCH_ENABLED` / `FACT_CHECK_TOOLS_ENABLED`, default `false`), both send upstream the query text and nothing else (no user id, no token, no facts, no feed, no chat history), and neither logs or stores the query. State the claim that way — "the gateway never decrypts or inspects message content" is true on every route; "the gateway never sees plaintext" is **not**, and must not be written anywhere.

**Both obey one rule: disabled is never empty.** No configuration state may produce a response a caller can mistake for "we searched and found nothing". `200 + []` means we searched and the index had nothing; `503 + {"code":"search-unavailable"}` means we did not search. `src/search-unavailable.ts` holds the shared envelope and the full argument.

The job store is a port (`JobStore` in `src/inference-jobs/job-store.port.ts`) with a single adapter: `RedisJobStore`, backed by a dedicated `inference-redis` Memorystore instance (`INFERENCE_JOBS_REDIS_URL`) where every key carries a TTL. BullMQ runs on the separate shared `INFERENCE_REDIS_URL` instance.

## Commands

```bash
npm run start:dev      # Development with watch mode
npm run build          # Compile TypeScript
npm run start:prod     # Run compiled output
npm run lint           # ESLint with auto-fix
npm run format         # Prettier formatting
npm run test           # Unit tests
npm run test:e2e       # End-to-end tests
npm run test:cov       # Test coverage
```

## Architecture

```
src/
  main.ts                    # Bootstrap: helmet, compression, basic-auth (Bull Board),
  |                          #   CORS, validation pipe, exception filter
  app.module.ts              # Root module: config, logging (Pino/GCP), throttling,
  |                          #   JobStoreModule, BullBoardModule, all feature modules
  constants.ts               # UPSTREAM_BASE_URL, JWT_ISSUER
  auth/
    auth.guard.ts            # JWT + capability-token verification (JWKS, jose)
    capability-token.service.ts  # Mint/verify HMAC-signed capability tokens
  chat/
    chat.module.ts           # Registers CompletionsController + ChatService + InferenceQueueService
    completions.controller.ts  # POST /v1/chat/completions (2xx body piped through as-is),
    |                          #   POST /v1/chat/completions/batch (in-memory queue backpressure)
    chat.service.ts          # proxyChat() — raw fetch proxy to NEAR AI
    inference-queue.service.ts  # In-memory concurrency limiter for batch endpoint
  inference-jobs/
    inference-jobs.module.ts
    inference-jobs.controller.ts  # POST /v1/inference/jobs (202 + capability token),
    |                             #   GET /v1/inference/jobs/:requestId/results (owner-checked)
    inference-jobs.service.ts     # submit(): store.createJob, create BullMQ Flow, mint token
    job-store.port.ts             # JobStore port: JOB_STORE symbol + interface + JobPayloadTooLargeError
    job-store.module.ts           # Composition root: binds JOB_STORE to RedisJobStore
    redis-job-store.ts            # Redis adapter (dedicated instance, Lua idempotent appends, TTL'd keys)
    dto/
      submit-job.dto.ts      # SubmitJobDto, InferenceRequestDto, E2EESessionDto
  attestation/
    attestation.controller.ts  # GET /api/attestation/report — proxies NEAR AI attestation
  search-unavailable.ts      # Shared 503 envelope: SEARCH_UNAVAILABLE_CODE + searchUnavailable()
  web-search/
    web-search.module.ts       # Composition root; binds WEB_SEARCH_FETCH to global fetch
    web-search.controller.ts   # POST /v1/web-search (200; 502 upstream; 503 unavailable)
    web-search.service.ts      # Brave proxy: spend gate, length guards, 8s AbortController
    dto/
      web-search.dto.ts        # WebSearchRequestDto — { query } and nothing else
  fact-check-claims/
    fact-check-claims.module.ts      # Composition root; binds FACT_CHECK_CLAIMS_FETCH
    fact-check-claims.controller.ts  # POST /v1/fact-check-claims (same shape as web-search)
    fact-check-claims.service.ts     # Google Fact Check Tools proxy; flattens claimReview[]
    dto/
      fact-check-claims.dto.ts       # { query, languageCode?, maxAgeDays? } and nothing else
  health/
    health.controller.ts     # GET /health
  queues/
    queues.module.ts         # BullMQ queue/worker registration
    queues.constants.ts      # Queue names: llm-inference, finalize-job, notify-user
    flow.service.ts          # Creates BullMQ Flows (parent + N children)
    llm-inference.processor.ts  # Worker: proxyChat per request, store.appendResult (idempotent)
    finalize-job.processor.ts   # BullMQ Flow parent: marks job completed, enqueues notify-user
    notify-user.processor.ts    # Worker: sends silent Expo push notification
  notifications/
    expo-push.service.ts     # Expo push SDK wrapper (silent notifications)
  filters/
    http-exception.filter.ts  # Global exception filter
```

## Routes

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/v1/chat/completions` | JWT | Transparent proxy; response mode follows the request's `stream` flag (E2EE does not change it) |
| `POST` | `/v1/chat/completions/batch` | JWT | Synchronous batch; 503 when in-memory queue full |
| `POST` | `/v1/inference/jobs` | JWT or capability token | Submit async job; returns 202 + capability token |
| `GET` | `/v1/inference/jobs/:requestId/results` | JWT or capability token | Poll job results; `{ pending: true }` until complete |
| `POST` | `/v1/web-search` | JWT or capability token | Brave proxy. **Plaintext query** (see below); 400 on length, 502 on an unexpected upstream failure, **503 `search-unavailable` whenever no search happened** (gate off, key unset/rejected, upstream 429) |
| `POST` | `/v1/fact-check-claims` | JWT or capability token | Google Fact Check Tools (ClaimReview) proxy. **Plaintext query** (see below); returns `claimReview[]` flattened; same 400/502/**503 `search-unavailable`** contract |
| `GET` | `/api/attestation/report` | JWT | Proxy NEAR AI TEE attestation report |
| `GET` | `/health` | None | Health check |
| `GET` | `/queues` | HTTP basic auth | Bull Board admin UI; 503 if credentials not configured |

## Key Design Principle: E2EE Passthrough

The gateway is intentionally ignorant of message content. `messages[].content` fields contain E2EE-encrypted payloads. Both `ChatService.proxyChat()` and the async job processors forward ciphertext upstream without inspection.

**Never add code that reads, logs, or transforms message content.** That rule stands unchanged.

`POST /v1/web-search` and `POST /v1/fact-check-claims` do not breach it: they are separate routes that carry no `messages[]` at all. What they do carry is a plaintext search string, which is a different thing and is documented as such — a third-party index has to be queried with the actual terms. The rules that keep them honest:

- **Off by default** (`BRAVE_SEARCH_ENABLED`, `FACT_CHECK_TOOLS_ENABLED`); while off, nothing leaves the gateway — and the route says so with a 503 rather than pretending it searched.
- **Never log the query text** — not at debug, not truncated, not alongside a user id. Both services log lengths and statuses only, and specs assert the query string never appears in any log call. `FactCheckClaimsService` additionally never logs its request URL: Google takes the API key as a URL parameter, so that one string holds both the secret and the claim.
- **Send upstream the query and nothing else.** No user id, no bearer token, no facts, no feed, no chat history. The DTOs declare only the query (plus the fact-check route's optional `languageCode` / `maxAgeDays`), and the global `ValidationPipe` (`whitelist: true`) strips anything else a client sends.
- **Never answer "no results" when you did not search.** Every unavailable state throws `searchUnavailable(...)` from `src/search-unavailable.ts` — a 503 with `code: 'search-unavailable'`. The one empty array either route may still return sits behind a 200 and means the index genuinely had nothing.
- **Never widen it.** Do not add a route that forwards decrypted message content to a third party; this exception is scoped to a search string the user typed and is not a precedent.

## E2EE Headers

The four canonical E2EE headers forwarded to NEAR AI (exact, case-sensitive):

- `X-Signing-Algo`
- `X-Client-Pub-Key`
- `X-Model-Pub-Key`
- `X-Encryption-Version`

These are forwarded verbatim and do **not** affect the response mode: `POST /v1/chat/completions` pipes any 2xx upstream body through unconditionally, so SSE vs JSON is decided by the request's own `stream` flag. Under `stream: true` each `delta.content` is a self-contained E2EE envelope.

## Auth

- Stateless JWT verification using Ed25519 public keys fetched from the auth service's JWKS endpoint (`AUTH_JWKS_URL` env var)
- Uses `createRemoteJWKSet` from `jose` — keys are cached and auto-refreshed on rotation
- Verifies `iss` claim against `JWT_ISSUER` constant (`src/constants.ts`), overridable via `AUTH_JWT_ISSUER` env var
- No database, no shared secret for JWT path
- Capability tokens: HMAC-signed JWTs minted at job submit, scoped to a single `requestId` with scopes `results:read` and `jobs:submit-followup`; signed with `INFERENCE_CAPABILITY_SECRET`
- Bearer token extracted from `Authorization` header
- Requires the auth service to have the `jwt()` plugin enabled (better-auth)

## Async Job Flow

```
POST /v1/inference/jobs
  → store.createJob (TTL 24h, status=pending; redis store enforces
    INFERENCE_MAX_JOB_BYTES → 413, store down → 503)
  → FlowService.createInferenceFlow()
       BullMQ Flow: N llm-inference children + 1 finalize-job parent
  → CapabilityTokenService.mint({ userId, requestId })
  → return 202 { requestId, capabilityToken }

llm-inference worker (×N, concurrency=LLM_INFERENCE_CONCURRENCY):
  → store.getRequestContext(jobId, index)
  → maybePrependSharedSystem() if sharedSystem set
  → ChatService.proxyChat()
  → store.appendResult (idempotent per (jobId, index) — BullMQ is
    at-least-once; redis adapter uses HSETNX in a Lua script)

finalize-job worker (fires after all children):
  → store.finalizeJob → status=completed, completedAt
  → enqueue notify-user

notify-user worker:
  → store.getNotifyInfo → ExpoPushService.sendSilent({ type: 'inference-done', requestId })
```

### Redis job-store key layout

All keys live on the dedicated `inference-redis` instance (volatile-ttl —
**every key must carry a TTL**), namespaced by `INFERENCE_JOBS_KEY_PREFIX`
(`inf:` prod, `inf:stg:` staging):

```
{p}job:{id}          HASH   userId, status, requestCount, completedCount, e2eeSession, sharedSystem…  (TTL 24h)
{p}job:{id}:req:{i}  STRING JSON {id, body}  (TTL 2h — only needed while processing)
{p}job:{id}:results  HASH   {i} -> JSON {id, ok, response, error}  (TTL 24h)
```

Access-control invariant: `getResultsView`/`getNotifyInfo` always return the
owning `userId`; the controller 403s on mismatch, and capability tokens are
bound to a single requestId. Request-path lookups are exact-key point reads —
never SCAN, never client-derived prefixes.

## Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEAR_AI_API_KEY` | Yes | — | NEAR AI API key |
| `AUTH_JWKS_URL` | Yes | — | Auth service JWKS endpoint URL |
| `AUTH_JWT_ISSUER` | No | `mera-server-auth` | Expected `iss` claim in JWTs |
| `INFERENCE_REDIS_URL` | Yes | — | Redis connection string (BullMQ) |
| `INFERENCE_JOBS_REDIS_URL` | Yes | — | Dedicated job-store Redis (NOT the BullMQ instance) |
| `INFERENCE_JOBS_KEY_PREFIX` | No | `inf:` | Job-store key namespace (`inf:stg:` on staging) |
| `INFERENCE_JOBS_RESULT_TTL_SECONDS` | No | `86400` | TTL for job hash + results (client re-fetch window) |
| `INFERENCE_JOBS_BODY_TTL_SECONDS` | No | `7200` | TTL for request bodies |
| `INFERENCE_MAX_JOB_BYTES` | No | `5242880` | Submit-time payload byte cap (413 on breach) |
| `BULLMQ_PREFIX` | No | `bull` | BullMQ key prefix on the shared Redis (`bull-stg` on staging) |
| `INFERENCE_CAPABILITY_SECRET` | Yes | — | HMAC secret for capability tokens |
| `EXPO_ACCESS_TOKEN` | No | — | Expo push token; push silently skipped if unset |
| `PORT` | No | `8080` | Server port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `CORS_ORIGIN` | No | `http://localhost:8081` | Allowed CORS origin |
| `THROTTLE_TTL` | No | `60` | Rate-limit window in seconds |
| `THROTTLE_LIMIT` | No | `30` | Max requests per window |
| `INFERENCE_MAX_CONCURRENCY` | No | `8` | In-memory concurrency for batch endpoint |
| `INFERENCE_MAX_QUEUE_DEPTH` | No | `200` | Max queued+active before batch returns 503 |
| `INFERENCE_BODY_LIMIT` | No | `50mb` | Express body size limit |
| `UPSTREAM_TIMEOUT_MS` | No | `120000` | NEAR AI request timeout in ms (tolerates a cold model on first request) |
| `LLM_INFERENCE_CONCURRENCY` | No | `8` | BullMQ worker concurrency for llm-inference queue |
| `LOG_LEVEL` | No | `debug` / `warn` | Pino log level (debug in dev, warn in prod) |
| `BULLBOARD_ADMIN_USERNAME` | No | — | Bull Board HTTP basic auth username; UI returns 503 if unset |
| `BULLBOARD_ADMIN_PASSWORD` | No | — | Bull Board HTTP basic auth password |
| `BRAVE_SEARCH_ENABLED` | No | `false` | Spend gate for `/v1/web-search`; on only when exactly `true`. Off ⇒ 503 `search-unavailable`, never an empty result |
| `BRAVE_SEARCH_API_KEY` | No | — | Brave subscription token (`X-Subscription-Token`). Server-only — never returned, never logged. Needed only when the gate is on |
| `FACT_CHECK_TOOLS_ENABLED` | No | `false` | Gate for `/v1/fact-check-claims`; on only when exactly `true`. Off ⇒ 503 `search-unavailable`. The API's quota is undocumented — confirm it in the Cloud console before leaning on it |
| `FACT_CHECK_TOOLS_API_KEY` | No | — | Google Fact Check Tools key, sent as the `key` URL param. Server-only — never returned, never logged, and neither is the request URL that carries it |

## Deployment

Deployed as a Google Cloud Run service. The Dockerfile uses a multi-stage build with `node:20-alpine`. Default port is 8080 (Cloud Run convention). Non-root user in production image.

## Patterns

- Uses NestJS `ConfigService` for all env access (never raw `process.env` in services; exception: `LLM_INFERENCE_CONCURRENCY` read at module load time in the BullMQ processor)
- GCP-compatible structured logging via Pino (severity levels mapped to GCP format)
- Rate limiting via `@nestjs/throttler` (global guard)
- Global `ValidationPipe` with `transform: true, whitelist: true`
- Bull Board mounted at `/queues`, protected by fail-closed basic-auth middleware in `main.ts`
- Compression disabled on `/v1/chat/completions` to avoid interfering with SSE framing
