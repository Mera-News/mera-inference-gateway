/** DEPRECATE(redis-store): removed in P4 once prod runs INFERENCE_JOBS_STORE=redis. */
import { Injectable } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { InferenceJob, InferenceJobDocument } from '../models/inference-job.schema';
import { CreateJobInput, JobResult, JobStore, RequestContext, ResultsView } from './job-store.port';

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Legacy adapter over the Atlas `inference_jobs` TTL collection. Behavior is
 * a faithful transplant of the pre-port Mongoose queries so the mongo path
 * stays byte-identical while INFERENCE_JOBS_STORE=redis soaks in staging.
 */
@Injectable()
export class MongoJobStore implements JobStore {
  constructor(
    @InjectModel(InferenceJob.name)
    private readonly inferenceJobModel: Model<InferenceJobDocument>,
  ) {}

  async createJob(input: CreateJobInput): Promise<string> {
    const now = new Date();
    const doc = await this.inferenceJobModel.create({
      userId: input.userId,
      expoPushToken: input.expoPushToken,
      e2eeSession: input.e2eeSession,
      status: 'pending',
      requests: input.requests.map((r) => ({ id: r.id, body: r.body })),
      sharedSystem: input.sharedSystem,
      results: [],
      createdAt: now,
      completedAt: null,
      expiresAt: new Date(now.getTime() + DEFAULT_TTL_MS),
    });
    return doc._id.toString();
  }

  async getRequestContext(jobId: string, requestIndex: number): Promise<RequestContext | null> {
    const doc = await this.inferenceJobModel.findById(new Types.ObjectId(jobId)).lean().exec();
    if (!doc) return null;
    const request = doc.requests[requestIndex];
    if (!request) return null;

    const e2eeSession: Record<string, string> = {};
    if (doc.e2eeSession) {
      for (const [k, v] of Object.entries(doc.e2eeSession)) {
        if (typeof v === 'string') e2eeSession[k] = v;
      }
    }

    return {
      request: { id: request.id, body: request.body },
      sharedSystem: doc.sharedSystem ?? null,
      e2eeSession: doc.e2eeSession ? e2eeSession : null,
    };
  }

  async appendResult(jobId: string, _requestIndex: number, result: JobResult): Promise<void> {
    await this.inferenceJobModel
      .updateOne(
        { _id: new Types.ObjectId(jobId) },
        {
          $push: { results: result },
          $set: { status: 'processing' },
        },
      )
      .exec();
  }

  async finalizeJob(jobId: string): Promise<{ requestCount: number; resultCount: number } | null> {
    const updated = await this.inferenceJobModel
      .findOneAndUpdate(
        { _id: new Types.ObjectId(jobId) },
        { $set: { status: 'completed', completedAt: new Date() } },
        { returnDocument: 'after', projection: { results: 1, requests: 1 } },
      )
      .lean()
      .exec();
    if (!updated) return null;
    return { requestCount: updated.requests.length, resultCount: updated.results.length };
  }

  async getResultsView(jobId: string): Promise<ResultsView | null> {
    const doc = await this.inferenceJobModel
      .findById(new Types.ObjectId(jobId), { userId: 1, status: 1, results: 1 })
      .lean()
      .exec();
    if (!doc) return null;
    return {
      userId: doc.userId,
      status: doc.status,
      results: (doc.results ?? []).map((r) => ({
        id: r.id,
        ok: r.ok,
        response: r.response ?? null,
        error: r.error ?? null,
      })),
    };
  }

  async getNotifyInfo(jobId: string): Promise<{ expoPushToken: string | null } | null> {
    const doc = await this.inferenceJobModel
      .findById(new Types.ObjectId(jobId), { expoPushToken: 1 })
      .lean()
      .exec();
    if (!doc) return null;
    return { expoPushToken: doc.expoPushToken ?? null };
  }

  async ping(): Promise<void> {
    const db = this.inferenceJobModel.db.db;
    if (!db) {
      throw new Error('mongo connection not ready');
    }
    await db.command({ ping: 1 });
  }
}
