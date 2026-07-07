/** DEPRECATE(redis-store): removed in P4 once prod runs INFERENCE_JOBS_STORE=redis. */
import { Types } from 'mongoose';
import { MongoJobStore } from './mongo-job-store';

const INPUT = {
  userId: 'user-1',
  expoPushToken: 'ExponentPushToken[t]',
  e2eeSession: { 'X-Signing-Algo': 'ed' },
  requests: [
    { id: 'a', body: { x: 1 } },
    { id: 'b', body: {} },
  ],
  sharedSystem: 'CIPHER',
};

describe('MongoJobStore', () => {
  describe('createJob', () => {
    it('creates the legacy document shape with a 24h TTL', async () => {
      const oid = new Types.ObjectId();
      const model = { create: jest.fn().mockResolvedValue({ _id: oid }) };
      const store = new MongoJobStore(model as never);

      const id = await store.createJob(INPUT);

      expect(id).toBe(oid.toString());
      const arg = model.create.mock.calls[0][0] as Record<string, unknown>;
      expect(arg).toMatchObject({
        userId: 'user-1',
        status: 'pending',
        requests: INPUT.requests,
        e2eeSession: INPUT.e2eeSession,
        sharedSystem: 'CIPHER',
        results: [],
        expoPushToken: 'ExponentPushToken[t]',
      });
      const createdAt = arg.createdAt as Date;
      const expiresAt = arg.expiresAt as Date;
      expect(expiresAt.getTime() - createdAt.getTime()).toBe(24 * 60 * 60 * 1000);
    });
  });

  describe('getRequestContext', () => {
    function makeFindByIdModel(doc: unknown) {
      return {
        findById: jest.fn().mockReturnValue({ lean: () => ({ exec: async () => doc }) }),
      };
    }

    it('returns request, sharedSystem and string-filtered e2eeSession', async () => {
      const model = makeFindByIdModel({
        requests: [{ id: 'a', body: { x: 1 } }],
        sharedSystem: 'CIPHER',
        e2eeSession: { 'X-Signing-Algo': 'ed', 'X-Bad': 123 },
      });
      const store = new MongoJobStore(model as never);

      const ctx = await store.getRequestContext(new Types.ObjectId().toString(), 0);

      expect(ctx).toEqual({
        request: { id: 'a', body: { x: 1 } },
        sharedSystem: 'CIPHER',
        e2eeSession: { 'X-Signing-Algo': 'ed' },
      });
    });

    it('returns null when the doc is missing', async () => {
      const store = new MongoJobStore(makeFindByIdModel(null) as never);
      await expect(store.getRequestContext(new Types.ObjectId().toString(), 0)).resolves.toBeNull();
    });

    it('returns null when the index is out of bounds', async () => {
      const model = makeFindByIdModel({ requests: [{ id: 'a', body: {} }], e2eeSession: null });
      const store = new MongoJobStore(model as never);
      await expect(
        store.getRequestContext(new Types.ObjectId().toString(), 99),
      ).resolves.toBeNull();
    });
  });

  describe('appendResult', () => {
    it('$push-es the result and sets status processing', async () => {
      const exec = jest.fn().mockResolvedValue({});
      const model = { updateOne: jest.fn().mockReturnValue({ exec }) };
      const store = new MongoJobStore(model as never);
      const jobId = new Types.ObjectId().toString();
      const result = { id: 'r0', ok: true, response: { c: [] }, error: null };

      await store.appendResult(jobId, 0, result);

      const [filter, update] = model.updateOne.mock.calls[0] as [
        { _id: Types.ObjectId },
        { $push: { results: unknown }; $set: { status: string } },
      ];
      expect(filter._id.toString()).toBe(jobId);
      expect(update.$push.results).toEqual(result);
      expect(update.$set.status).toBe('processing');
    });
  });

  describe('finalizeJob', () => {
    function makeFinalizeModel(doc: unknown) {
      return {
        findOneAndUpdate: jest.fn().mockReturnValue({ lean: () => ({ exec: async () => doc }) }),
      };
    }

    it('marks completed and returns counts', async () => {
      const model = makeFinalizeModel({ requests: [{}, {}, {}], results: [{}] });
      const store = new MongoJobStore(model as never);
      const jobId = new Types.ObjectId().toString();

      const counts = await store.finalizeJob(jobId);

      expect(counts).toEqual({ requestCount: 3, resultCount: 1 });
      const [filter, update, options] = model.findOneAndUpdate.mock.calls[0] as [
        { _id: Types.ObjectId },
        { $set: { status: string; completedAt: Date } },
        Record<string, unknown>,
      ];
      expect(filter._id.toString()).toBe(jobId);
      expect(update.$set.status).toBe('completed');
      expect(update.$set.completedAt).toBeInstanceOf(Date);
      expect(options).toEqual({
        returnDocument: 'after',
        projection: { results: 1, requests: 1 },
      });
    });

    it('returns null for an unknown job', async () => {
      const store = new MongoJobStore(makeFinalizeModel(null) as never);
      await expect(store.finalizeJob(new Types.ObjectId().toString())).resolves.toBeNull();
    });
  });

  describe('getResultsView', () => {
    function makeViewModel(doc: unknown) {
      return {
        findById: jest.fn().mockReturnValue({ lean: () => ({ exec: async () => doc }) }),
      };
    }

    it('always carries userId and normalizes missing response/error to null', async () => {
      const model = makeViewModel({
        userId: 'user-1',
        status: 'completed',
        results: [{ id: 'r0', ok: true }],
      });
      const store = new MongoJobStore(model as never);

      const view = await store.getResultsView(new Types.ObjectId().toString());

      expect(view).toEqual({
        userId: 'user-1',
        status: 'completed',
        results: [{ id: 'r0', ok: true, response: null, error: null }],
      });
      // Projection matches the legacy read exactly.
      const [, projection] = model.findById.mock.calls[0] as [unknown, unknown];
      expect(projection).toEqual({ userId: 1, status: 1, results: 1 });
    });

    it('returns null for an unknown job', async () => {
      const store = new MongoJobStore(makeViewModel(null) as never);
      await expect(store.getResultsView(new Types.ObjectId().toString())).resolves.toBeNull();
    });
  });

  describe('getNotifyInfo', () => {
    function makeNotifyModel(doc: unknown) {
      return {
        findById: jest.fn().mockReturnValue({ lean: () => ({ exec: async () => doc }) }),
      };
    }

    it('returns the token with the legacy projection', async () => {
      const model = makeNotifyModel({ expoPushToken: 'ExponentPushToken[x]' });
      const store = new MongoJobStore(model as never);

      await expect(store.getNotifyInfo(new Types.ObjectId().toString())).resolves.toEqual({
        expoPushToken: 'ExponentPushToken[x]',
      });
      const [, projection] = model.findById.mock.calls[0] as [unknown, unknown];
      expect(projection).toEqual({ expoPushToken: 1 });
    });

    it('returns null for an unknown job', async () => {
      const store = new MongoJobStore(makeNotifyModel(null) as never);
      await expect(store.getNotifyInfo(new Types.ObjectId().toString())).resolves.toBeNull();
    });
  });

  describe('ping', () => {
    it('runs a driver-level ping when connected', async () => {
      const command = jest.fn().mockResolvedValue({ ok: 1 });
      const model = { db: { db: { command } } };
      const store = new MongoJobStore(model as never);
      await expect(store.ping()).resolves.toBeUndefined();
      expect(command).toHaveBeenCalledWith({ ping: 1 });
    });

    it('rejects when no driver connection exists yet', async () => {
      const model = { db: { db: undefined } };
      const store = new MongoJobStore(model as never);
      await expect(store.ping()).rejects.toThrow(/not ready/);
    });

    it('rejects when the ping command fails', async () => {
      const command = jest.fn().mockRejectedValue(new Error('down'));
      const model = { db: { db: { command } } };
      const store = new MongoJobStore(model as never);
      await expect(store.ping()).rejects.toThrow('down');
    });
  });
});
