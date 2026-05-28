# Security Policy

## Supported Versions

| Version | Supported |
|---------|-----------|
| 0.x     | Yes       |

## Reporting a Vulnerability

**Do NOT open a public GitHub issue for security vulnerabilities.**

Email: contact@mera.news

Please include:
- A description of the vulnerability
- Steps to reproduce the issue
- The affected service version (from `package.json`)
- Your contact details (if you would like to be credited)

We will acknowledge your report within **5 business days** and aim to ship a fix within **30 days** for critical issues. We will credit reporters in release notes unless anonymity is requested.

## Scope

**In scope:**
- JWT/JWKS verification (`src/auth/auth.guard.ts`) — token forgery, key confusion, or JWKS endpoint manipulation
- Capability token issuance and validation (`src/auth/capability-token.service.ts`)
- E2EE-passthrough integrity — any path through which the gateway could inadvertently decrypt, log, or transform encrypted message content
- The NEAR AI proxy path — request smuggling, header injection, or response manipulation between client and upstream
- Job-queue paths — privilege escalation or unauthorized job enqueuing via BullMQ
- Bull Board authentication — unauthorized access to the job-queue dashboard

**Out of scope:**
- Vulnerabilities in the NEAR AI upstream or its TEE infrastructure (report those to NEAR AI directly)
- Denial-of-service / volumetric attacks (handled at the infrastructure layer via Cloud Run and throttling)
- Social engineering attacks
- Vulnerabilities in third-party dependencies that are already publicly known and tracked upstream

## Private Reporting via GitHub

To use GitHub's private vulnerability reporting, click the **"Report a vulnerability"** button on the Security tab of this repository. GitHub activates private advisory submission when this `SECURITY.md` file is present.
