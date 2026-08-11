# mera-inference-gateway

[![License: Proprietary](https://img.shields.io/badge/License-Proprietary%20(All%20Rights%20Reserved)-red)](LICENSE.md)

Privacy-first E2EE inference gateway. Proxies encrypted chat requests to NEAR AI TEE-protected inference without ever reading message content.

## Why This Exists

**The inference path is an opaque pipe.** Messages are end-to-end encrypted on the client using NEAR AI's E2EE protocol before they reach this gateway. On the inference routes — `POST /v1/chat/completions`, `POST /v1/chat/completions/batch`, `POST /v1/inference/jobs` and their results — the gateway authenticates the request, then forwards the encrypted payload directly to NEAR AI running inside a Trusted Execution Environment (TEE). It never decrypts or inspects message content; decryption happens only inside the TEE.

```
Client (E2EE encrypt) --> mera-inference-gateway --> NEAR AI (TEE decrypt + infer)
         ^                    |                              |
         |                    | Auth only                    | Encrypted response
         |                    | (never reads                 |
         |                    |  message content)            v
         +----------------------------------------------------+
```

### The two exceptions: `POST /v1/web-search` and `POST /v1/fact-check-claims`

The two lookup routes are **not** part of that pipe, and the claim above must not be read as covering them. They share one posture, described here once.

- **They receive the query in plaintext.** A third-party index — Brave for web search, Google's Fact Check Tools API for ClaimReview — has to be queried with the actual terms; there is no way to search with ciphertext. That is a deliberate trade-off, on separate routes, with a separate posture.
- **They are opt-in and off by default.** `BRAVE_SEARCH_ENABLED` and `FACT_CHECK_TOOLS_ENABLED` default to `false`; while a gate is off, no request leaves the gateway for that route.
- **What is sent upstream: the query text and nothing else.** No user id, no session or bearer token, no user facts, no feed, no chat history, no conversation context — the outbound request carries exactly the search string, a result count, the caller's optional language/age filters, and the server-side API key.
- **What the gateway keeps: nothing.** The query text is never logged (not at debug, not truncated) and never stored, and no log line associates a user with a search. The API keys are server-only and are never logged or returned. Fact Check Tools takes its key as a URL parameter, so that route never logs a request URL either.
- **Everything else is unchanged.** No message content, encrypted or otherwise, is read on any route.

#### Disabled is not empty

Both routes obey one rule: **no configuration state may produce a response a caller can mistake for "we searched and found nothing."**

| Response | Means |
|---|---|
| `200` with a populated list | We searched. Hits. |
| `200` with `[]` | **We searched**, and the index had nothing. A real answer. |
| `503` + `{"code": "search-unavailable"}` | **We did not search.** Gate off, key missing, key rejected, or upstream throttled. |

`/v1/web-search` used to return `{"results": []}` when its own gate was off, which is byte-identical to a real zero-hit search. Anything built on that — a fact-checker especially — would report a fabricated all-clear from a missing env var. The 503 carries a stable `code` plus a coarse `reason` (`disabled`, `not-configured`, `upstream-rejected-key`, `upstream-rate-limited`); the reason never contains the query, the key, or a user id.

## API Endpoints

### `POST /v1/chat/completions`

Streaming chat completions (Server-Sent Events). Accepts an OpenAI-compatible request body with E2EE-encrypted message content.

**Headers:**
- `Authorization: Bearer <jwt-token>` (required)

**Request body:** Standard [OpenAI chat completions format](https://platform.openai.com/docs/api-reference/chat/create)

**Response:** Server-Sent Events stream

#### E2EE mode

The gateway forwards the E2EE headers verbatim to NEAR AI and relays NEAR AI's E2EE response headers back to the client. E2EE does **not** change the response mode: the mode follows the request's own `stream` flag, and any 2xx body is piped straight through, SSE or JSON alike. With `stream: true` each streamed `delta.content` is its own self-contained E2EE envelope, independently decryptable by the client.

**E2EE headers (all forwarded to NEAR AI):**

| Header | Description |
|--------|-------------|
| `X-Signing-Algo` | `ecdsa` or `ed25519` |
| `X-Client-Pub-Key` | Client ephemeral public key (hex) |
| `X-Model-Pub-Key` | Model public key from attestation (hex) |
| `X-Encryption-Version` | NEAR AI E2EE protocol version (e.g. `2`) |

**Response:** follows the request's `stream` flag — SSE with encrypted `choices[*].delta.content` when `stream: true`, otherwise JSON with encrypted `choices[*].message.content`

---

### `POST /v1/chat/completions/batch`

Synchronous batch inference. Accepts an array of OpenAI-compatible request bodies and returns all results in a single JSON response.

**Headers:**
- `Authorization: Bearer <jwt-token>` (required)
- E2EE headers (same set as above, optional — applied to every item in the batch)

**Request body:**
```json
{
  "requests": [ /* array of OpenAI chat.completions request bodies */ ]
}
```

**Response:** `{ "results": [ { "index": 0, "response": { ... } }, ... ] }`

**Backpressure:** Returns `503` when the in-memory inference queue is full (`INFERENCE_MAX_CONCURRENCY` + `INFERENCE_MAX_QUEUE_DEPTH` exceeded). Retry with exponential back-off.

---

### `POST /v1/inference/jobs`

Submit an async inference job. The job is persisted to a dedicated Redis instance (every key TTL'd) and processed in the background via BullMQ workers. Returns `202 Accepted` immediately.

**Headers:**
- `Authorization: Bearer <jwt-token>` (required)

**Request body:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `expoPushToken` | string | Yes | Expo push token; a silent notification is sent when the job completes |
| `requests` | `InferenceRequestDto[]` | Yes | 1–5000 inference requests |
| `requests[].id` | string | Yes | Client-assigned correlation ID |
| `requests[].body` | object | Yes | OpenAI chat.completions request body (E2EE content untouched) |
| `e2eeSession` | object | No | E2EE headers shared across every request in the job |
| `e2eeSession["X-Signing-Algo"]` | string | No | |
| `e2eeSession["X-Client-Pub-Key"]` | string | No | |
| `e2eeSession["X-Model-Pub-Key"]` | string | No | |
| `e2eeSession["X-Encryption-Version"]` | string | No | |
| `sharedSystem` | string | No | E2EE-encrypted system message prepended to every request's `messages[]`; max 64 KB. Avoids repeating identical ciphertext per request. |

**Response `202`:**
```json
{
  "requestId": "<24-hex-random-id>",
  "capabilityToken": "<signed-jwt>"
}
```

The `capabilityToken` is a scoped JWT (HMAC-signed via `INFERENCE_CAPABILITY_SECRET`) bound to `requestId`. It carries scopes `results:read` and `jobs:submit-followup`. Use it — instead of the user JWT — to poll results or submit follow-up jobs, limiting blast radius if a token is leaked.

---

### `GET /v1/inference/jobs/:requestId/results`

Poll for async job results.

**Headers:**
- `Authorization: Bearer <capability-token>` (capability token from submit, recommended) or `Bearer <jwt-token>`

**Path params:** `requestId` — the 24-hex random ID returned at submit time.

**Response (pending):** `{ "pending": true }`

**Response (completed):**
```json
{
  "requestId": "...",
  "results": [
    { "id": "<request-id>", "ok": true, "response": { /* upstream json */ } },
    { "id": "<request-id>", "ok": false, "error": "upstream 500" }
  ]
}
```

Results are retained for ~24 hours via a Redis key TTL, then automatically deleted.

---

### `POST /v1/web-search`

Authenticated proxy for Brave Search. Feeds the chat model's context, which is why it lives on the inference gateway rather than on the news API. **Plaintext route** — see [the exception above](#the-one-exception-post-v1web-search).

**Headers:**
- `Authorization: Bearer <jwt-token>` (required; capability tokens also accepted)

**Request body:**
```json
{ "query": "search terms" }
```

**Response `200`:**
```json
{
  "results": [
    { "title": "…", "url": "https://…", "snippet": "…" }
  ]
}
```

At most 10 results. `{ "results": [] }` behind a `200` means exactly one thing: we asked Brave and Brave had nothing. Every state in which the gateway did **not** reach Brave is a `503` instead — see [Disabled is not empty](#disabled-is-not-empty).

| Status | When |
|--------|------|
| `200` | Success, including a genuine zero-hit search |
| `400` | Trimmed query shorter than 2 or longer than 200 characters, or `query` missing/not a string |
| `401` | Missing or invalid bearer token |
| `429` | Per-IP throttle (`THROTTLE_LIMIT` / `THROTTLE_TTL`) |
| `502` | Brave unreachable or returned an unexpected non-2xx |
| `503` | `{"code":"search-unavailable"}` — gate off, key unset, key rejected by Brave (401/403), or Brave throttled us (429). **No search happened.** |

---

### `POST /v1/fact-check-claims`

Authenticated proxy for Google's [Fact Check Tools API](https://developers.google.com/fact-check/tools/api/reference/rest/v1alpha1/claims/search) (`claims:search`), which serves the ClaimReview structured data IFCN signatories publish. **Plaintext route** — same posture as web search above.

It exists so "which organisation checked this claim" is a *structured lookup* rather than a model's inference: an organisation returned from this index cannot be hallucinated, and `textualRating` is already the publisher's own verdict wording.

**Headers:**
- `Authorization: Bearer <jwt-token>` (required; capability tokens also accepted)

**Request body** (`languageCode` and `maxAgeDays` optional):
```json
{ "query": "the claim text", "languageCode": "en", "maxAgeDays": 365 }
```

**Response `200`:** the upstream `claims[].claimReview[]` nesting flattened, each entry carrying its parent claim's context. Field names are Google's — mapping them to a UI shape is the client's job.
```json
{
  "claimReviews": [
    {
      "claim": "…", "claimant": "…", "claimDate": "…",
      "publisher": { "name": "PolitiFact", "site": "politifact.com" },
      "url": "https://…", "title": "…", "reviewDate": "…",
      "textualRating": "Pants on Fire", "languageCode": "en"
    }
  ]
}
```

At most 20 flattened reviews (`pageSize=10` upstream; one claim can carry several reviews). **An empty list behind a `200` is a real, publishable answer**: no IFCN signatory has published on this claim. That is the *normal* outcome for most news — measured coverage on this corpus is roughly 4% — and it must never be rendered as a failure.

Omitting `languageCode` is a deliberate, valid request, not a degraded one: the corpus skews heavily English, so a locale-scoped miss is worth retrying unfiltered before concluding nobody has published.

| Status | When |
|--------|------|
| `200` | Success, including the honest empty |
| `400` | Trimmed query shorter than 2 or longer than 300 characters, malformed `languageCode`, or `maxAgeDays` outside 1–3650 |
| `401` | Missing or invalid bearer token |
| `429` | Per-IP throttle (`THROTTLE_LIMIT` / `THROTTLE_TTL`) |
| `502` | Upstream unreachable or returned an unexpected non-2xx |
| `503` | `{"code":"search-unavailable"}` — gate off, key unset, key rejected (401/403), or upstream throttled (429). **No lookup happened**, and it is not evidence that nobody checked the claim. |

⚠️ The published quota for this API is **undocumented**. Confirm it in the Cloud console before depending on it at volume.

---

### `GET /api/attestation/report`

Proxies the NEAR AI TEE attestation report. Use this to retrieve the model's current signing public key before encrypting a message.

**Headers:**
- `Authorization: Bearer <jwt-token>` (required)

**Query parameters:** Forwarded verbatim to NEAR AI (e.g. `model`, `nonce`, `signing_address`).

**Response:** NEAR AI attestation report JSON including `signing_public_key`, `signing_address`, `signing_algo`, `intel_quote`, and `nvidia_payload`.

---

### `GET /health`

Health check. Returns `{ "status": "ok" }`. Not authenticated.

---

### `GET /queues`

Bull Board admin UI for monitoring BullMQ queues. Protected by HTTP basic auth (`BULLBOARD_ADMIN_USERNAME` / `BULLBOARD_ADMIN_PASSWORD`). Returns `503` if credentials are not configured.

---

## Async Job Architecture

```
POST /v1/inference/jobs
  |
  +-- create job (dedicated Redis, every key TTL'd — job hash 24h)
  |
  +-- BullMQ Flow (FlowService)
        |
        +-- llm-inference (child ×N)   <-- one BullMQ job per request
        |      proxyChat() → append result (idempotent, Lua HSETNX)
        |
        +-- finalize-job (parent, fires after all children)
        |      marks doc status = 'completed'
        |
        +-- notify-user
               sends silent Expo push notification
```

Three BullMQ queues: `llm-inference`, `finalize-job`, `notify-user`. Workers run with configurable concurrency (`LLM_INFERENCE_CONCURRENCY`). All queues retry with exponential back-off (3 attempts, 2 s base). Completed jobs are removed after 1 h; failed jobs after 24 h.

## Setup

### Prerequisites

- Node.js 20+
- A NEAR AI API key — [app.near.ai](https://app.near.ai/)
- An auth service exposing a JWKS endpoint (see [Backend Requirements](#backend-requirements-byo-backend))
- Redis 7+ — BullMQ queues (`INFERENCE_REDIS_URL`) plus a dedicated job-store instance (`INFERENCE_JOBS_REDIS_URL`)

### Installation

```bash
npm install
```

### Configuration

Copy `.env.example` to `.env` and fill in the required values:

```bash
cp .env.example .env
```

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `NEAR_AI_API_KEY` | Yes | — | NEAR AI API key |
| `AUTH_JWKS_URL` | Yes | — | Auth service JWKS endpoint (e.g. `https://auth.example.com/api/auth/jwks`) |
| `AUTH_JWT_ISSUER` | No | `mera-server-auth` | Expected `iss` claim in JWTs |
| `INFERENCE_REDIS_URL` | Yes | — | Redis connection string for BullMQ |
| `INFERENCE_JOBS_REDIS_URL` | Yes | — | Dedicated Redis instance for the job store (NOT the BullMQ one) |
| `INFERENCE_CAPABILITY_SECRET` | Yes | — | HMAC secret for capability tokens (generate with `openssl rand -hex 32`) |
| `EXPO_ACCESS_TOKEN` | No | — | Expo push API token; push notifications silently skipped if unset |
| `PORT` | No | `8080` | Server port |
| `NODE_ENV` | No | `development` | `development` or `production` |
| `CORS_ORIGIN` | No | `http://localhost:8081` | Allowed CORS origin |
| `THROTTLE_TTL` | No | `60` | Rate-limit window in seconds |
| `THROTTLE_LIMIT` | No | `30` | Max requests per window |
| `INFERENCE_MAX_CONCURRENCY` | No | `8` | In-memory concurrency for `/v1/chat/completions/batch` |
| `INFERENCE_MAX_QUEUE_DEPTH` | No | `200` | Max queued+active items before batch returns 503 |
| `INFERENCE_BODY_LIMIT` | No | `50mb` | Express body-parser size limit |
| `UPSTREAM_TIMEOUT_MS` | No | `120000` | NEAR AI request timeout in ms (tolerates a cold model on first request) |
| `LLM_INFERENCE_CONCURRENCY` | No | `8` | BullMQ worker concurrency for `llm-inference` queue |
| `INFERENCE_JOBS_KEY_PREFIX` | No | `inf:` | Job-store Redis key namespace (`inf:stg:` on staging) |
| `INFERENCE_JOBS_RESULT_TTL_SECONDS` | No | `86400` | TTL for the job hash + results (client re-fetch window) |
| `INFERENCE_JOBS_BODY_TTL_SECONDS` | No | `7200` | TTL for request bodies (only needed while processing) |
| `INFERENCE_MAX_JOB_BYTES` | No | `5242880` | Submit-time payload byte cap (413 on breach) |
| `LOG_LEVEL` | No | `debug` (dev) / `warn` (prod) | Pino log level |
| `BULLBOARD_ADMIN_USERNAME` | No | — | Bull Board admin UI username; UI returns 503 if unset |
| `BULLBOARD_ADMIN_PASSWORD` | No | — | Bull Board admin UI password |
| `BRAVE_SEARCH_ENABLED` | No | `false` | Spend gate for `POST /v1/web-search`. Off unless exactly `true`; while off the route answers `503 search-unavailable` and no request leaves the gateway |
| `BRAVE_SEARCH_API_KEY` | No | — | Brave Search subscription token, sent as `X-Subscription-Token`. Server-only: never returned to a client and never logged. Required only when `BRAVE_SEARCH_ENABLED=true` |
| `FACT_CHECK_TOOLS_ENABLED` | No | `false` | Gate for `POST /v1/fact-check-claims`. Off unless exactly `true`; while off the route answers `503 search-unavailable` and no request leaves the gateway |
| `FACT_CHECK_TOOLS_API_KEY` | No | — | Google Fact Check Tools API key, sent as the `key` URL parameter. Server-only: never returned, never logged — and neither is the request URL, which contains it. Required only when `FACT_CHECK_TOOLS_ENABLED=true` |

### Running

```bash
# Development (watch mode)
npm run start:dev

# Production
npm run build
npm run start:prod
```

## Deployment (Google Cloud Run)

### Build and push Docker image

```bash
docker build -t mera-inference-gateway .

# Tag and push to your container registry
docker tag mera-inference-gateway gcr.io/YOUR_PROJECT/mera-inference-gateway
docker push gcr.io/YOUR_PROJECT/mera-inference-gateway
```

### Deploy to Cloud Run

```bash
gcloud run deploy mera-inference-gateway \
  --image gcr.io/YOUR_PROJECT/mera-inference-gateway \
  --platform managed \
  --region us-central1 \
  --set-env-vars "NEAR_AI_API_KEY=your-key,NODE_ENV=production" \
  --set-env-vars "AUTH_JWKS_URL=https://auth.example.com/api/auth/jwks" \
  --set-env-vars "INFERENCE_REDIS_URL=redis://...,INFERENCE_JOBS_REDIS_URL=redis://..." \
  --set-env-vars "INFERENCE_CAPABILITY_SECRET=your-secret" \
  --port 8080 \
  --allow-unauthenticated
```

## Backend Requirements (BYO Backend)

This is a **standalone gateway release**. You must supply your own dependencies. The minimum requirements are:

| Dependency | Description |
|------------|-------------|
| **NEAR AI API key** | Obtain from [app.near.ai](https://app.near.ai/). The gateway forwards all inference requests to `https://cloud-api.near.ai/v1`. |
| **Auth service with JWKS** | Any service that issues JWTs and exposes a JWKS endpoint. Must set the `iss` claim to the value of `AUTH_JWT_ISSUER` (default `mera-server-auth`). The gateway uses `createRemoteJWKSet` from `jose` for stateless, no-database JWT verification. Mera uses [Better Auth](https://better-auth.com) with the `jwt()` plugin enabled. |
| **Redis 7+ (BullMQ)** | BullMQ queue backend. Set `INFERENCE_REDIS_URL`. |
| **Redis 7+ (job store)** | Dedicated instance holding job payloads/results. Set `INFERENCE_JOBS_REDIS_URL`. Every key carries a TTL — job hash + results expire after ~24 h, request bodies after ~2 h. |
| **Expo push account** | Optional. Set `EXPO_ACCESS_TOKEN` to enable silent push notifications on job completion. Without it, notifications are silently skipped; clients must poll for results instead. |

## Configuring for Your Own Fork

Before deploying a fork publicly you must update the following:

- **Auth issuer** — set `AUTH_JWT_ISSUER` to match the `iss` claim your auth service puts in its JWTs, and set `AUTH_JWKS_URL` to your JWKS endpoint. The two must match or every request will be rejected with `401`.
- **Secrets** — generate a fresh `INFERENCE_CAPABILITY_SECRET` (`openssl rand -hex 32`). Never reuse the value from any other environment.
- **CORS** — set `CORS_ORIGIN` to your client's origin.
- **Bull Board credentials** — set `BULLBOARD_ADMIN_USERNAME` and `BULLBOARD_ADMIN_PASSWORD`. The admin UI returns `503` until both are configured — this is intentional (fail-closed).
- **Branding** — this gateway is proprietary software owned by Mera Labs B.V. See [TRADEMARK.md](TRADEMARK.md) for trademark restrictions.

See [TRADEMARK.md](TRADEMARK.md) for the full trademark policy.

## Security

- **E2EE passthrough** — the gateway never decrypts or inspects message content on any route
- **Two plaintext routes, scoped** — `POST /v1/web-search` and `POST /v1/fact-check-claims` receive search terms in the clear because a third-party index must be queried with them. Both off by default; the query is never logged and never stored; nothing but the query text (plus optional language/age filters) is sent upstream. Neither can answer "no results" when it did not actually search — a disabled or throttled route returns `503 search-unavailable`
- **Stateless JWT auth** — Ed25519 asymmetric verification using JWKS; no shared secret, no database
- **Capability tokens** — scoped per `requestId`; limits blast radius of a leaked token to a single job
- **Rate limiting** — configurable per-window throttling via `@nestjs/throttler` (default: 30 req/60 s)
- **Helmet** — standard HTTP security headers on all responses
- **Input validation** — global `ValidationPipe` with `whitelist: true`
- **Bull Board** — fail-closed: returns `503` when credentials are not configured

## License & Trademark

**This project is proprietary and confidential — not open source.** It is licensed under the proprietary terms in [LICENSE.md](LICENSE.md). Copyright © 2025-2026 Mera Labs B.V. (KVK 42077437), all rights reserved. No license to use, copy, modify, or distribute it is granted except by separate written agreement with Mera Labs B.V.

See [TRADEMARK.md](TRADEMARK.md) for trademark restrictions.

For licensing inquiries: contact@mera.news
For security vulnerabilities: see [SECURITY.md](SECURITY.md)
