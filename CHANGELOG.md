# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] — 2025-01-01

Initial public source-available release.

### Added
- NestJS inference gateway that proxies E2EE-encrypted chat requests to NEAR AI without decrypting or inspecting message content.
- Stateless JWT authentication via JWKS endpoint (`src/auth/auth.guard.ts`) using Ed25519 public keys with `jose`.
- Capability token service (`src/auth/capability-token.service.ts`) for scoped access control.
- SSE streaming endpoint (`POST /api/chat`) and batch inference endpoint (`POST /api/batch-infer`).
- Concurrency and queue-depth limiting via a semaphore pattern (`INFERENCE_MAX_CONCURRENCY`, `INFERENCE_MAX_QUEUE_DEPTH`).
- Global rate limiting via `@nestjs/throttler`.
- GCP-compatible structured logging via Pino with severity-level mapping.
- Multi-stage Dockerfile for Cloud Run deployment with non-root user.
- Community-health docs: `LICENSE.md`, `NOTICE`, `TRADEMARK.md`, `SECURITY.md`, `CONTRIBUTING.md`, `CODE_OF_CONDUCT.md`, and GitHub issue/PR templates.
- `.env.example` documenting every required and optional environment variable.

[Unreleased]: https://github.com/mera-news/mera-inference-gateway/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mera-news/mera-inference-gateway/releases/tag/v0.1.0
