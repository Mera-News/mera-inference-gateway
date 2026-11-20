# Contributing to Mera Inference Gateway

Thank you for your interest in contributing to the Mera Inference Gateway.

## License

Issues are welcome.

`"private": true` in `package.json` is intentional: it prevents an accidental `npm publish`.

## What We Accept

- Bug fixes that are reproducible and include clear reproduction steps
- Performance improvements with measurable impact
- Documentation fixes
- Security improvements (see [SECURITY.md](SECURITY.md) for vulnerability reporting)

For larger feature PRs, **open an issue for discussion before building**. This avoids wasted effort if the feature does not fit the project roadmap or would require changes to upstream integrations.

## What We Do Not Accept

- PRs that remove, modify, or bypass `LICENSE`, `TRADEMARK.md`, `COMMERCIAL.md`, or the `"license"` field in `package.json`
- PRs that re-introduce hardcoded `mera.news` URLs or internal service addresses (these must use environment variables via `.env.example` and `ConfigService` instead)
- PRs that introduce new Mera trademarks into copy or configuration in a way that would require trademark permission from Mera Labs B.V. (see [TRADEMARK.md](TRADEMARK.md))
- PRs that add code reading, logging, or transforming encrypted message content — the gateway is an intentional E2EE passthrough

## Development Setup

### Prerequisites

- Node.js 20+
- npm 10+

### Getting Started

```bash
# Clone the repository
git clone https://github.com/mera-news/mera-inference-gateway.git
cd mera-inference-gateway

# Install dependencies
npm install

# Copy environment variables
cp .env.example .env
# Fill in NEAR_AI_API_KEY and AUTH_JWKS_URL (and any other required values)

# Start development server
npm run start:dev
```

### Verify Setup

```bash
# Health check
curl http://localhost:8080/health
# Should return: {"status":"ok"}

# Auth check (should return 401 without valid token)
curl -X POST http://localhost:8080/api/chat
# Should return: 401 Unauthorized
```

## Code Style

- **Prettier**: run `npm run format` before committing.
- **ESLint**: run `npm run lint` before committing. The CI pipeline enforces this.
- **TypeScript**: strict mode. Do not add `// @ts-ignore` or `any` types without a comment explaining why.
- **NestJS patterns**: use `ConfigService` for all environment access — never raw `process.env` in services.
- **E2EE passthrough**: never add code that reads, logs, or transforms `messages[].content`. Messages are E2EE-encrypted payloads.

## Testing

```bash
npm test              # Unit tests
npm run test:e2e      # End-to-end tests
npm run test:cov      # Coverage report
npm run typecheck     # TypeScript type-check without emitting
```

## Making Changes

1. **Fork** the repository
2. **Create a branch** from `main`: `git checkout -b feat/your-feature`
3. **Make your changes** — keep commits focused and atomic
4. **Run checks**: `npm run lint && npm run format && npm test && npm run typecheck`
5. **Open a pull request** against `main` at https://github.com/mera-news/mera-inference-gateway

## Pull Request Checklist

Before submitting a PR, confirm:

- [ ] `npm run lint` passes with no new warnings
- [ ] `npm run format` was run
- [ ] `npm test` passes
- [ ] `npm run typecheck` passes
- [ ] No hardcoded `mera.news` URLs or internal service addresses (use `.env` / `ConfigService`)
- [ ] No Mera trademarks introduced in new copy (see [TRADEMARK.md](TRADEMARK.md))
- [ ] No code added that reads, logs, or transforms encrypted message content

## Contact

- **Security vulnerabilities**: see [SECURITY.md](SECURITY.md) — email contact@mera.news. Do not open public issues for vulnerabilities.
- **Licensing questions**: contact@mera.news

## Contribution terms

By opening a pull request you confirm that:

1. You wrote the contribution yourself, or you have the right to submit it.
2. If your employer has rights in what you write, you have its permission to contribute.
3. You keep the copyright in your contribution.
4. You grant Mera Labs B.V. a perpetual, worldwide, non-exclusive, royalty-free, irrevocable
   licence to use, copy, modify, publish, distribute and sublicense your contribution, including
   under any patent claims of yours that it would otherwise infringe. Mera Labs B.V. may do so as
   part of this project or of any other Mera Labs product, under this repository's licence or under
   any other licence terms, commercial ones included.

Tick the box in the pull request to say you agree. A pull request without it is not merged.
