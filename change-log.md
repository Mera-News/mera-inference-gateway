# mera-inference-gateway change log

Monthly engineering record. Git holds every commit; what it does not hold is why something was
attempted, what it measured, what was abandoned and for what reason, and what is still unresolved.

One section per month, **most recent first**. Appended at the end of a wave, never per commit.

This is the **deployed** proxy, running in prod and staging. It is source-available under a
proprietary licence. Do not confuse it with `mera-node`, which shares ancestry and deploys nowhere.

---

## 2026-08

**Theme:** search moves inside the encrypted boundary.

**Shipped:** the Brave web-search proxy moved here from the GraphQL API (08-07), putting search behind
the same capability-token boundary as inference. Multi-query `/v1/web-search` (08-25), fanning queries
out server-side rather than making the device issue them one at a time. Request-entry deadlines,
client-disconnect propagation, and model and user attribution in timeout logs (08-03). CLAUDE.md
trimmed from 268 lines to 59, with the detail moved into the area skill.

**Rejected:** search living on the GraphQL API, where it sat outside the encrypted path.

**Open:** a 404 from this service means no search happened. Callers that treat it as a soft failure
silently zero their attribution, which has already caused one defect downstream in the app.

---

## 2026-07

**Theme:** the job store loses its database.

**Shipped:** the job store made pluggable behind a `JobStore` port with a Redis adapter (07-07), then
Mongo deleted outright (07-13) with mongoose removed alongside it. Capability token TTL cut from 24h
to 2h in the same change. A 10-minute in-memory attestation cache with upstream timing logs (07-20).

**Rejected:** Mongo as the job store. The gateway holds short-lived job state and nothing durable, so
a document database was carrying operational weight it never needed to.

**Open:** nothing. The port abstraction is the reason this swap took one wave.

---

## 2026-06

**Theme:** making the service runnable without the app's infrastructure.

**Shipped:** the Expo push token made optional (06-09), so the gateway does not require app
infrastructure to run. Tests updated. An AWS docker image. A daily fetch limit (06-25). Connection
pool tuning.

---

## 2026-05

**Theme:** the repo opens.

**Shipped:** first public commit 05-28, a standalone NestJS end-to-end-encrypted inference proxy,
opened so the privacy claim in the app could be inspected rather than asserted.

**Open:** the E2EE constraint means the gateway cannot inspect payloads to explain a failure, so every
diagnostic has to come from timing and metadata. That bounds how precisely a bad request can be
characterised, and it is a permanent property of the design rather than a gap to close.
