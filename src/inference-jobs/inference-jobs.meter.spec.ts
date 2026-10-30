import { HttpException, Logger, ServiceUnavailableException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { Response } from 'express';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.guard';
import type { Tier } from '../auth/tier';
import { CompletionsController } from '../chat/completions.controller';
import { InferenceJobsController } from './inference-jobs.controller';
import { InferenceJobsService } from './inference-jobs.service';
import { ReadMeterService } from './read-meter.service';

const RedisMock = require('ioredis-mock');

/**
 * The submit seam with the real meter: controller -> service -> ReadMeterService
 * running its real Lua on an in-memory Redis. Only the job store, the flow
 * producer and token minting are stand-ins.
 */

const BASE = 6_000_000;
const BUDGETS = {
  READ_BUDGET_STARTER_BYTES: String(BASE),
  READ_BUDGET_INDIVIDUAL_BYTES: String(BASE * 25),
  READ_BUDGET_PROFESSIONAL_BYTES: String(BASE * 100),
};
const PREFIX = 'inf:';
const at = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const NOON = at('2026-10-15T12:00:00Z');
const DAY = '20261015';

type Res = Response & { headers: Record<string, string> };

function makeRes(): Res {
  const headers: Record<string, string> = {};
  return {
    headers,
    setHeader: (k: string, v: string) => {
      headers[k] = v;
    },
  } as unknown as Res;
}

function jwtUser(id: string, tier?: Tier): AuthenticatedUser {
  return { id, subscriptionIsActive: true, tier };
}

function capUser(id: string): AuthenticatedUser {
  return {
    id,
    subscriptionIsActive: true,
    capability: {
      uid: id,
      rid: 'a'.repeat(24),
      exp: Date.now() + 1e6,
      scopes: ['jobs:submit-followup', 'results:read'],
    },
  };
}

const req = (user: AuthenticatedUser) => ({ user }) as unknown as AuthenticatedRequest;

/** A request body of roughly `bytes` serialized bytes. */
function body(bytes: number): Record<string, unknown> {
  return { messages: [{ role: 'user', content: 'x'.repeat(bytes) }], max_tokens: 96 };
}

function dto(bodies: Record<string, unknown>[], sharedSystem?: string) {
  return {
    requests: bodies.map((b, i) => ({ id: `r${i}`, body: b })),
    ...(sharedSystem ? { sharedSystem } : {}),
  } as never;
}

/** What the meter must charge: each body (max_tokens 96 survives the clamp)
 *  plus sharedSystem once per request. */
function expectedCost(bodies: Record<string, unknown>[], sharedSystem = ''): number {
  return bodies.reduce(
    (sum, b) => sum + Buffer.byteLength(JSON.stringify(b)) + Buffer.byteLength(sharedSystem),
    0,
  );
}

describe('POST /v1/inference/jobs with the read meter', () => {
  let redis: any;
  let meter: ReadMeterService;
  let controller: InferenceJobsController;
  let store: Record<string, jest.Mock>;
  let flow: { createInferenceFlow: jest.Mock };
  let idem: Map<string, string>;
  let jobSeq: number;

  const setTime = (sec: number) => jest.spyOn(redis, 'time').mockResolvedValue([String(sec), '0']);
  const hash = (uid: string, day = DAY) => redis.hgetall(`${PREFIX}meter:${uid}:${day}`);

  function build(
    env: Record<string, string | undefined> = BUDGETS,
  ) {
    meter = new ReadMeterService(redis, { get: (k: string) => env[k] } as unknown as ConfigService);
    meter.onModuleInit();
    const service = new InferenceJobsService(
      store as never,
      flow as never,
      { mint: () => 'mc.tok' } as never,
      meter,
    );
    controller = new InferenceJobsController(service, store as never);
  }

  beforeEach(async () => {
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    redis = new RedisMock();
    await redis.flushall();
    setTime(NOON);
    jobSeq = 0;
    idem = new Map();
    // In-memory idempotency store with the real reserve/finalize/release shape.
    store = {
      createJob: jest.fn(async () => (++jobSeq).toString(16).padStart(24, '0')),
      reserveIdempotencyKey: jest.fn(async (u: string, k: string) => {
        const v = idem.get(`${u}:${k}`);
        if (v === undefined) {
          idem.set(`${u}:${k}`, '');
          return { status: 'reserved' };
        }
        return v === '' ? { status: 'in-progress' } : { status: 'exists', requestId: v };
      }),
      finalizeIdempotencyKey: jest.fn(async (u: string, k: string, rid: string) => {
        idem.set(`${u}:${k}`, rid);
      }),
      releaseIdempotencyKey: jest.fn(async (u: string, k: string) => {
        idem.delete(`${u}:${k}`);
      }),
    };
    flow = { createInferenceFlow: jest.fn().mockResolvedValue(undefined) };
    build();
  });

  afterEach(() => jest.restoreAllMocks());

  async function submitAs(
    user: AuthenticatedUser,
    d: never,
    opts: { key?: string; newClient?: boolean } = {},
  ) {
    const res = makeRes();
    const out = await controller.submit(
      req(user),
      d,
      opts.key,
      opts.newClient === false ? undefined : '1',
      res,
    );
    return { out, res };
  }

  async function refusal(p: Promise<unknown>): Promise<HttpException> {
    const err = await p.then(
      () => null,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(HttpException);
    return err as HttpException;
  }

  it('charges each submit its clamped body bytes and counts one call', async () => {
    const bodies = [body(1000), body(2000)];
    await submitAs(jwtUser('u1'), dto(bodies));
    const h = await hash('u1');
    expect(Number(h.bytes)).toBe(expectedCost(bodies));
    expect(h.calls).toBe('1');
    expect(Number(h.limit)).toBe(BASE);
    expect(await redis.smembers(`${PREFIX}meter:users:${DAY}`)).toEqual(['u1']);
  });

  it('charges sharedSystem once per request, not once per job', async () => {
    const shared = 's'.repeat(5000);
    const bodies = [body(100), body(100), body(100)];
    await submitAs(jwtUser('u1'), dto(bodies, shared));
    const h = await hash('u1');
    expect(Number(h.bytes)).toBe(expectedCost(bodies, shared));
    expect(Number(h.bytes)).toBeGreaterThan(3 * 5000);
  });

  it('a packed call (more articles in one body) costs more than an unpacked one', async () => {
    await submitAs(jwtUser('one'), dto([body(800)]));
    await submitAs(jwtUser('five'), dto([body(5 * 800)]));
    expect(Number((await hash('five')).bytes)).toBeGreaterThan(Number((await hash('one')).bytes));
  });

  it('clamps max_tokens on the stored body: absent -> 512, above -> 512, below kept', async () => {
    await submitAs(
      jwtUser('u1'),
      dto([
        { messages: [] },
        { messages: [], max_tokens: 4096 },
        { messages: [], max_tokens: 96 },
        { messages: [], max_completion_tokens: 2000 },
      ]),
    );
    const stored = store.createJob.mock.calls[0][0].requests.map(
      (r: { body: Record<string, unknown> }) => r.body,
    );
    expect(stored.map((b: Record<string, unknown>) => b.max_tokens)).toEqual([512, 512, 96, 512]);
    expect(stored[3].max_completion_tokens).toBe(512);
  });

  it('sends X-Mera-Reading-Used as used/limit on every accepted submit', async () => {
    const { res } = await submitAs(jwtUser('u1'), dto([body(BASE / 4)]));
    const used = Number(res.headers['X-Mera-Reading-Used']);
    expect(used).toBeGreaterThan(0.24);
    expect(used).toBeLessThan(0.26);
  });

  it('refuses a submit that would cross the limit: 429, code, resetAt, Retry-After capped at 60', async () => {
    await submitAs(jwtUser('u1'), dto([body(BASE - 10_000)]));
    const before = await hash('u1');
    const res = makeRes();
    const err = await refusal(
      controller.submit(req(jwtUser('u1')), dto([body(20_000)]), undefined, '1', res),
    );
    expect(err.getStatus()).toBe(429);
    expect(err.getResponse()).toEqual({
      code: 'daily-quota-exceeded',
      resetAt: '2026-10-16T00:00:00.000Z',
    });
    expect(res.headers['Retry-After']).toBe('60');
    const after = await hash('u1');
    expect(after.bytes).toBe(before.bytes);
    expect(after.limitHitAt).toBe(String(NOON * 1000));
    expect(store.createJob).toHaveBeenCalledTimes(1);
  });

  it('Retry-After counts down to the reset when it is under a minute away', async () => {
    setTime(at('2026-10-15T23:59:30Z'));
    await submitAs(jwtUser('u1'), dto([body(BASE - 1000)]));
    const res = makeRes();
    await refusal(controller.submit(req(jwtUser('u1')), dto([body(5000)]), undefined, '1', res));
    expect(res.headers['Retry-After']).toBe('30');
  });

  it('answers an old client (no X-Mera-Reading header) with 402 and no Retry-After', async () => {
    await submitAs(jwtUser('u1'), dto([body(BASE - 1000)]));
    const res = makeRes();
    const err = await refusal(
      controller.submit(req(jwtUser('u1')), dto([body(5000)]), undefined, undefined, res),
    );
    expect(err.getStatus()).toBe(402);
    expect((err.getResponse() as { code: string }).code).toBe('daily-quota-exceeded');
    expect(res.headers['Retry-After']).toBeUndefined();
  });

  it('a single job larger than the whole limit is refused, never let through as an overshoot', async () => {
    const err = await refusal(submitAs(jwtUser('u1'), dto([body(BASE + 1)])));
    expect(err.getStatus()).toBe(429);
    expect((await hash('u1')).bytes).toBeUndefined();
  });

  it('resets at 00:00 UTC: a new day charges a fresh hash', async () => {
    setTime(at('2026-10-15T23:59:59Z'));
    await submitAs(jwtUser('u1'), dto([body(BASE - 1000)]));
    await refusal(submitAs(jwtUser('u1'), dto([body(5000)])));
    setTime(at('2026-10-16T00:00:00Z'));
    await submitAs(jwtUser('u1'), dto([body(5000)]));
    expect(Number((await hash('u1', '20261016')).bytes)).toBeGreaterThan(5000);
  });

  it.each<[Tier | undefined, number]>([
    [undefined, 1],
    ['none', 1],
    ['starter', 1],
    ['individual', 25],
    ['professional', 100],
  ])('tier %s budgets %ix the starter bytes', async (tier, mult) => {
    await submitAs(jwtUser('u1', tier), dto([body(100)]));
    expect(Number((await hash('u1')).limit)).toBe(BASE * mult);
  });

  it('an individual user can read past the Starter limit', async () => {
    await submitAs(jwtUser('u1', 'individual'), dto([body(BASE - 1000)]));
    await submitAs(jwtUser('u1', 'individual'), dto([body(BASE)]));
    expect(Number((await hash('u1')).bytes)).toBeGreaterThan(BASE);
  });

  it('a capability-token follow-up is charged but never raises the stored limit', async () => {
    await submitAs(capUser('u1'), dto([body(1000)]));
    let h = await hash('u1');
    expect(Number(h.limit)).toBe(BASE);
    expect(Number(h.bytes)).toBeGreaterThan(1000);
    await submitAs(jwtUser('u1', 'professional'), dto([body(100)]));
    await submitAs(capUser('u1'), dto([body(100)]));
    h = await hash('u1');
    expect(Number(h.limit)).toBe(BASE * 100);
    expect(h.calls).toBe('3');
  });

  it('an upgrade mid-day raises the limit at once and clears limitHitAt', async () => {
    await submitAs(jwtUser('u1'), dto([body(BASE - 1000)]));
    await refusal(submitAs(jwtUser('u1'), dto([body(5000)])));
    expect((await hash('u1')).limitHitAt).toBeDefined();
    await submitAs(jwtUser('u1', 'individual'), dto([body(5000)]));
    const h = await hash('u1');
    expect(h.limitHitAt).toBeUndefined();
    expect(Number(h.limit)).toBe(BASE * 25);
  });

  it('an idempotent replay is not charged and carries no reading header', async () => {
    const first = await submitAs(jwtUser('u1'), dto([body(1000)]), { key: 'k1' });
    const bytes = (await hash('u1')).bytes;
    const replay = await submitAs(jwtUser('u1'), dto([body(1000)]), { key: 'k1' });
    expect(replay.out.requestId).toBe(first.out.requestId);
    expect((await hash('u1')).bytes).toBe(bytes);
    expect(replay.res.headers['X-Mera-Reading-Used']).toBeUndefined();
    expect(store.createJob).toHaveBeenCalledTimes(1);
  });

  it('a refusal releases the idempotency key: the same key resubmits with 202 once it fits', async () => {
    await submitAs(jwtUser('u1'), dto([body(BASE - 1000)]));
    await refusal(submitAs(jwtUser('u1'), dto([body(5000)]), { key: 'k2' }));
    expect(store.releaseIdempotencyKey).toHaveBeenCalledTimes(1);
    setTime(at('2026-10-16T08:00:00Z'));
    const { out } = await submitAs(jwtUser('u1'), dto([body(5000)]), { key: 'k2' });
    expect(out.requestId).toMatch(/^[0-9a-f]{24}$/);
  });

  it('refunds the charge and releases the key when the flow producer fails', async () => {
    flow.createInferenceFlow.mockRejectedValueOnce(new Error('bullmq down'));
    await expect(submitAs(jwtUser('u1'), dto([body(1000)]), { key: 'k3' })).rejects.toThrow(
      'bullmq down',
    );
    const h = await hash('u1');
    expect(h.bytes).toBe('0');
    expect(h.calls).toBe('0');
    expect(store.releaseIdempotencyKey).toHaveBeenCalledTimes(1);
  });

  it('fails closed with the job store 503 when the meter Redis is down', async () => {
    jest.spyOn(redis, 'time').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(submitAs(jwtUser('u1'), dto([body(1000)]))).rejects.toThrow(
      ServiceUnavailableException,
    );
    expect(store.createJob).not.toHaveBeenCalled();
  });

  it('meter off (READ_BUDGET_* unset): no charge, no header, nothing written', async () => {
    build({});
    const { res } = await submitAs(jwtUser('u1'), dto([body(BASE * 2)]));
    expect(res.headers['X-Mera-Reading-Used']).toBeUndefined();
    expect(await redis.keys('*')).toEqual([]);
  });

  it('chat and batch routes never reach the meter', () => {
    const deps: unknown[] = Reflect.getMetadata('design:paramtypes', CompletionsController) ?? [];
    expect(deps).not.toContain(ReadMeterService);
  });
});
