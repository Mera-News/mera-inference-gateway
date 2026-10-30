import { Test } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JobStoreModule, JOB_STORE_REDIS_CLIENT } from './job-store.module';
import { METER_TTL_SECONDS, ReadMeterService } from './read-meter.service';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const RedisMock = require('ioredis-mock');

const MB = 1024 * 1024;
const BASE = 10 * MB;
const T = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const DAY = '20260315';
const NOON = T('2026-03-15T12:00:00Z');

describe('ReadMeterService', () => {
  let redis: any;

  beforeEach(async () => {
    redis = new RedisMock();
    await redis.flushall();
    setTime(NOON);
  });

  const setTime = (sec: number) => jest.spyOn(redis, 'time').mockResolvedValue([sec, '0']);

  const make = (env: Record<string, string | undefined> = { READ_BUDGET_BASE_BYTES: String(BASE) }) => {
    const svc = new ReadMeterService(redis, { get: (k: string) => env[k] } as unknown as ConfigService);
    svc.onModuleInit();
    return svc;
  };
  const key = (u = 'u1', day = DAY, prefix = 'inf:') => `${prefix}meter:${u}:${day}`;
  const args = (o: Record<string, unknown> = {}) =>
    ({ userId: 'u1', tier: 'starter', cost: 1, mayRaiseLimit: true, ...o }) as any;

  it('is off when base is unset and never touches redis', async () => {
    const svc = make({});
    expect(svc.enabled).toBe(false);
    expect(await svc.charge(args())).toEqual({ status: 'off' });
    expect(await redis.keys('*')).toEqual([]);
    expect(make({ READ_BUDGET_BASE_BYTES: '' }).enabled).toBe(false);
  });

  it('throws at boot on a bad base', () => {
    expect(() => make({ READ_BUDGET_BASE_BYTES: 'abc' })).toThrow();
    expect(() => make({ READ_BUDGET_BASE_BYTES: '1.5' })).toThrow();
    expect(() => make({ READ_BUDGET_BASE_BYTES: '999999' })).toThrow(/1000000/);
  });

  it('boots on a 2 MB Starter base, below INFERENCE_MAX_JOB_BYTES', () => {
    expect(make({ READ_BUDGET_BASE_BYTES: '2000000' }).enabled).toBe(true);
  });

  it('a 2 MB base refuses Starter past 2 MB and lets Individual through', async () => {
    const svc = make({ READ_BUDGET_BASE_BYTES: '2000000' });
    expect((await svc.charge(args({ cost: 2_100_000 }))).status).toBe('refused');
    const ind: any = await svc.charge(args({ userId: 'u2', tier: 'individual', cost: 2_100_000 }));
    expect(ind.status).toBe('charged');
    expect(ind.limit).toBe(50_000_000);
  });

  it('charges bytes, calls, limit, TTLs and the user index', async () => {
    const svc = make();
    const res = await svc.charge(args({ cost: 100 }));
    expect(res).toEqual({
      status: 'charged',
      charge: { key: key(), bytes: 100 },
      used: 100,
      limit: BASE,
    });
    expect(await redis.hgetall(key())).toEqual({ bytes: '100', calls: '1', limit: String(BASE) });
    expect(await redis.ttl(key())).toBe(METER_TTL_SECONDS);
    expect(await redis.ttl(`inf:meter:users:${DAY}`)).toBe(METER_TTL_SECONDS);
    expect(await redis.smembers(`inf:meter:users:${DAY}`)).toEqual(['u1']);
  });

  it('refuses over the limit, keeps bytes, and keeps the first limitHitAt', async () => {
    const svc = make();
    await svc.charge(args({ cost: BASE - 10 }));
    const r1: any = await svc.charge(args({ cost: 11 }));
    expect(r1.status).toBe('refused');
    expect(r1.used).toBe(BASE - 10);
    expect(r1.limit).toBe(BASE);
    const first = await redis.hget(key(), 'limitHitAt');
    expect(first).toBe(String(NOON * 1000));
    setTime(NOON + 60);
    await svc.charge(args({ cost: 11 }));
    expect(await redis.hget(key(), 'limitHitAt')).toBe(first);
    expect(await redis.hget(key(), 'bytes')).toBe(String(BASE - 10));
    expect(await redis.ttl(key())).toBe(METER_TTL_SECONDS);
  });

  it('accepts a charge landing exactly on the limit', async () => {
    const svc = make();
    const r: any = await svc.charge(args({ cost: BASE }));
    expect(r.status).toBe('charged');
    expect(r.used).toBe(BASE);
  });

  it.each([
    [undefined, 1],
    ['none', 1],
    ['starter', 1],
    ['bogus', 1],
    ['individual', 25],
    ['professional', 100],
  ])('tier %s gets %dx', async (tier, mult) => {
    const svc = make();
    const r: any = await svc.charge(args({ tier: tier === 'bogus' ? undefined : tier }));
    expect(r.limit).toBe(BASE * mult);
  });

  it('follow-ups (mayRaiseLimit=false) use base when missing and never lower a stored 100x', async () => {
    const svc = make();
    const missing: any = await svc.charge(args({ userId: 'u2', tier: 'professional', mayRaiseLimit: false }));
    expect(missing.limit).toBe(BASE);
    await svc.charge(args({ tier: 'professional' }));
    const again: any = await svc.charge(args({ tier: 'starter', mayRaiseLimit: false }));
    expect(again.limit).toBe(BASE * 100);
  });

  it('a higher tier raises the limit and clears limitHitAt; a lower tier never lowers it', async () => {
    const svc = make();
    await svc.charge(args({ cost: BASE }));
    expect((await svc.charge(args())).status).toBe('refused');
    expect(await redis.hget(key(), 'limitHitAt')).not.toBeNull();
    const up: any = await svc.charge(args({ tier: 'individual' }));
    expect(up.status).toBe('charged');
    expect(up.limit).toBe(BASE * 25);
    expect(await redis.hget(key(), 'limitHitAt')).toBeNull();
    const down: any = await svc.charge(args({ tier: 'starter' }));
    expect(down.limit).toBe(BASE * 25);
  });

  it('rolls the day key at UTC midnight and reports the next midnight as resetAt', async () => {
    const svc = make();
    setTime(T('2026-03-15T23:59:59Z'));
    await svc.charge(args({ cost: BASE }));
    const refused: any = await svc.charge(args());
    expect(refused.resetAt).toEqual(new Date('2026-03-16T00:00:00Z'));
    setTime(T('2026-03-16T00:00:00Z'));
    const next: any = await svc.charge(args());
    expect(next.status).toBe('charged');
    expect(next.charge.key).toBe(key('u1', '20260316'));
    expect(await redis.exists(key())).toBe(1);
  });

  it('refund hits the charged key after the day rolls, and skips a missing key', async () => {
    const svc = make();
    setTime(T('2026-03-15T23:59:59Z'));
    const r: any = await svc.charge(args({ cost: 50 }));
    setTime(T('2026-03-16T00:00:01Z'));
    await svc.refund(r.charge);
    expect(await redis.hgetall(key())).toEqual({ bytes: '0', calls: '0', limit: String(BASE) });
    await svc.refund({ key: key('ghost'), bytes: 5 });
    expect(await redis.exists(key('ghost'))).toBe(0);
  });

  it('refund swallows a redis error', async () => {
    const svc = make();
    (redis as any).refundReadMeter = jest.fn().mockRejectedValue(new Error('down'));
    await expect(svc.refund({ key: key(), bytes: 1 })).resolves.toBeUndefined();
  });

  it('propagates a time() failure from charge', async () => {
    const svc = make();
    jest.spyOn(redis, 'time').mockRejectedValue(new Error('down'));
    await expect(svc.charge(args())).rejects.toThrow('down');
  });

  it('honours INFERENCE_JOBS_KEY_PREFIX', async () => {
    const svc = make({ READ_BUDGET_BASE_BYTES: String(BASE), INFERENCE_JOBS_KEY_PREFIX: 'inf:stg:' });
    const r: any = await svc.charge(args());
    expect(r.charge.key).toBe('inf:stg:meter:u1:' + DAY);
  });

  it('boots under Nest DI with the job-store client', async () => {
    const prev = process.env.INFERENCE_JOBS_REDIS_URL;
    process.env.INFERENCE_JOBS_REDIS_URL = 'redis://x:6379';
    try {
      const mod = await Test.createTestingModule({
        imports: [ConfigModule.forRoot({ isGlobal: true, ignoreEnvFile: true }), JobStoreModule.register()],
        providers: [ReadMeterService],
      })
        .overrideProvider(JOB_STORE_REDIS_CLIENT)
        .useValue(redis)
        .compile();
      await mod.init();
      expect(mod.get(ReadMeterService)).toBeInstanceOf(ReadMeterService);
      await mod.close();
    } finally {
      if (prev === undefined) delete process.env.INFERENCE_JOBS_REDIS_URL;
      else process.env.INFERENCE_JOBS_REDIS_URL = prev;
    }
  });
});
