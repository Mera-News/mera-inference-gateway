import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import { Types } from 'mongoose';
import type { Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest, AuthenticatedUser } from '../auth/auth.guard';
import { InferenceJobsController } from './inference-jobs.controller';
import { InferenceJobsService } from './inference-jobs.service';
import { JOB_STORE } from './job-store.port';

const VALID_ID = new Types.ObjectId().toString();

function makeReq(user: AuthenticatedUser): AuthenticatedRequest {
  return { user } as unknown as AuthenticatedRequest;
}

function makeRes(): Response {
  return { setHeader: jest.fn() } as unknown as Response;
}

describe('InferenceJobsController', () => {
  let controller: InferenceJobsController;
  let jobsService: { submit: jest.Mock };
  let store: { getResultsView: jest.Mock };

  beforeEach(async () => {
    store = { getResultsView: jest.fn() };
    jobsService = { submit: jest.fn() };

    const module: TestingModule = await Test.createTestingModule({
      controllers: [InferenceJobsController],
      providers: [
        { provide: InferenceJobsService, useValue: jobsService },
        { provide: JOB_STORE, useValue: store },
      ],
    })
      // The controller is decorated with @UseGuards(AuthGuard); we exercise the
      // handler logic directly so a permissive stub guard is sufficient.
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .compile();

    controller = module.get(InferenceJobsController);
  });

  describe('submit', () => {
    const dto = { expoPushToken: 'tok', requests: [{ id: 'r', body: {} }] };

    it('delegates to the service for JWT-authed callers', async () => {
      jobsService.submit.mockResolvedValue({
        requestId: VALID_ID,
        capabilityToken: 'mc.x.y',
      });
      const req = makeReq({ id: 'user-1', subscriptionIsActive: true });
      const out = await controller.submit(req, dto as never);
      expect(out.requestId).toBe(VALID_ID);
      expect(jobsService.submit).toHaveBeenCalledWith('user-1', dto);
    });

    it('rejects a capability token lacking jobs:submit-followup scope', async () => {
      const req = makeReq({
        id: 'user-1',
        subscriptionIsActive: true,
        capability: {
          uid: 'user-1',
          rid: VALID_ID,
          exp: Date.now() + 1000,
          scopes: ['results:read'],
        },
      });
      await expect(controller.submit(req, dto as never)).rejects.toThrow(ForbiddenException);
      expect(jobsService.submit).not.toHaveBeenCalled();
    });

    it('allows a capability token with jobs:submit-followup scope', async () => {
      jobsService.submit.mockResolvedValue({
        requestId: VALID_ID,
        capabilityToken: 'mc.x.y',
      });
      const req = makeReq({
        id: 'user-1',
        subscriptionIsActive: true,
        capability: {
          uid: 'user-1',
          rid: VALID_ID,
          exp: Date.now() + 1000,
          scopes: ['jobs:submit-followup'],
        },
      });
      await expect(controller.submit(req, dto as never)).resolves.toBeDefined();
      expect(jobsService.submit).toHaveBeenCalled();
    });
  });

  describe('getResults', () => {
    it('rejects an invalid requestId before touching the store', async () => {
      const req = makeReq({ id: 'user-1', subscriptionIsActive: true });
      await expect(controller.getResults('not-an-objectid', req, makeRes())).rejects.toThrow(
        BadRequestException,
      );
      expect(store.getResultsView).not.toHaveBeenCalled();
    });

    it('rejects a requestId carrying redis key syntax before touching the store', async () => {
      const req = makeReq({ id: 'user-1', subscriptionIsActive: true });
      await expect(controller.getResults('inf:job:*:results', req, makeRes())).rejects.toThrow(
        BadRequestException,
      );
      expect(store.getResultsView).not.toHaveBeenCalled();
    });

    it('returns 404 for an unknown requestId', async () => {
      store.getResultsView.mockResolvedValue(null);
      const req = makeReq({ id: 'user-1', subscriptionIsActive: true });
      await expect(controller.getResults(VALID_ID, req, makeRes())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('rejects a job belonging to another user', async () => {
      store.getResultsView.mockResolvedValue({
        userId: 'owner',
        status: 'completed',
        results: [],
      });
      const req = makeReq({ id: 'attacker', subscriptionIsActive: true });
      await expect(controller.getResults(VALID_ID, req, makeRes())).rejects.toThrow(
        ForbiddenException,
      );
    });

    it('returns { pending: true } for an incomplete job', async () => {
      store.getResultsView.mockResolvedValue({
        userId: 'user-1',
        status: 'processing',
        results: [],
      });
      const req = makeReq({ id: 'user-1', subscriptionIsActive: true });
      const out = await controller.getResults(VALID_ID, req, makeRes());
      expect(out).toEqual({ pending: true });
    });

    it('streams results for a matching owner on a completed job', async () => {
      store.getResultsView.mockResolvedValue({
        userId: 'user-1',
        status: 'completed',
        results: [{ id: 'r', ok: true, response: null, error: null }],
      });
      const req = makeReq({ id: 'user-1', subscriptionIsActive: true });
      const res = makeRes();
      const out = await controller.getResults(VALID_ID, req, res);
      // StreamableFile is returned on success.
      expect(out).toBeDefined();
      expect(res.setHeader).toHaveBeenCalledWith('Cache-Control', 'no-store');
    });

    describe('capability-token gating', () => {
      it('rejects a token missing results:read scope', async () => {
        const req = makeReq({
          id: 'user-1',
          subscriptionIsActive: true,
          capability: {
            uid: 'user-1',
            rid: VALID_ID,
            exp: Date.now() + 1000,
            scopes: ['jobs:submit-followup'],
          },
        });
        await expect(controller.getResults(VALID_ID, req, makeRes())).rejects.toThrow(
          ForbiddenException,
        );
        expect(store.getResultsView).not.toHaveBeenCalled();
      });

      it("rejects a token whose rid doesn't match the route", async () => {
        const otherId = new Types.ObjectId().toString();
        const req = makeReq({
          id: 'user-1',
          subscriptionIsActive: true,
          capability: {
            uid: 'user-1',
            rid: otherId,
            exp: Date.now() + 1000,
            scopes: ['results:read'],
          },
        });
        await expect(controller.getResults(VALID_ID, req, makeRes())).rejects.toThrow(
          ForbiddenException,
        );
        expect(store.getResultsView).not.toHaveBeenCalled();
      });

      it('allows a token with matching rid + results:read scope', async () => {
        store.getResultsView.mockResolvedValue({
          userId: 'user-1',
          status: 'completed',
          results: [],
        });
        const req = makeReq({
          id: 'user-1',
          subscriptionIsActive: true,
          capability: {
            uid: 'user-1',
            rid: VALID_ID,
            exp: Date.now() + 1000,
            scopes: ['results:read'],
          },
        });
        const out = await controller.getResults(VALID_ID, req, makeRes());
        expect(out).toBeDefined();
        expect(store.getResultsView).toHaveBeenCalled();
      });
    });
  });
});
