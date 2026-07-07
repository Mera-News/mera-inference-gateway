/** DEPRECATE(redis-store): removed in P4 once prod runs INFERENCE_JOBS_STORE=redis. */
import { Prop, Schema, SchemaFactory } from '@nestjs/mongoose';
import { HydratedDocument } from 'mongoose';

/**
 * Per-request inside a job. `body` holds the E2EE-ciphertext chat request
 * exactly as the client sent it; the gateway never decrypts.
 */
@Schema({ _id: false })
class InferenceRequest {
  @Prop({ type: String, required: true })
  id!: string;

  @Prop({ type: Object, required: true })
  body!: Record<string, unknown>;
}
const InferenceRequestSchema = SchemaFactory.createForClass(InferenceRequest);

@Schema({ _id: false })
class InferenceResult {
  @Prop({ type: String, required: true })
  id!: string;

  @Prop({ type: Boolean, required: true })
  ok!: boolean;

  // Upstream response — still E2EE ciphertext in the `choices[].message.content`.
  @Prop({ type: Object, default: null })
  response?: unknown;

  // Plaintext error class for ops visibility. Never contains user content.
  @Prop({ type: String, default: null })
  error?: string;
}
const InferenceResultSchema = SchemaFactory.createForClass(InferenceResult);

@Schema({ _id: false })
class E2EESessionHeaders {
  @Prop({ type: String })
  'X-Signing-Algo'?: string;

  @Prop({ type: String })
  'X-Client-Pub-Key'?: string;

  @Prop({ type: String })
  'X-Model-Pub-Key'?: string;

  /** NEAR AI v2 marker — forwarded verbatim to the upstream. */
  @Prop({ type: String })
  'X-Encryption-Version'?: string;
}
const E2EESessionHeadersSchema = SchemaFactory.createForClass(E2EESessionHeaders);

export type InferenceJobStatus = 'pending' | 'processing' | 'completed' | 'failed';

@Schema({ collection: 'inference_jobs', timestamps: false })
export class InferenceJob {
  @Prop({ type: String, required: true, index: true })
  userId!: string;

  // Optional — null when the client submitted without a registered Expo push
  // token. notify-user skips the silent push for these; the client polls
  // GET /jobs/:id/results instead.
  @Prop({ type: String, default: null })
  expoPushToken!: string | null;

  @Prop({ type: E2EESessionHeadersSchema, default: null })
  e2eeSession!: E2EESessionHeaders | null;

  @Prop({
    type: String,
    required: true,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending',
  })
  status!: InferenceJobStatus;

  @Prop({ type: [InferenceRequestSchema], default: [] })
  requests!: InferenceRequest[];

  /**
   * E2EE-encrypted system message applied to every request in this job.
   * The processor prepends `{role:'system', content: sharedSystem}` to each
   * request's `messages` array before forwarding to the upstream provider.
   * Null for legacy jobs that embed the system message inside each request.
   */
  @Prop({ type: String, default: null })
  sharedSystem!: string | null;

  @Prop({ type: [InferenceResultSchema], default: [] })
  results!: InferenceResult[];

  @Prop({ type: Date, required: true, default: () => new Date() })
  createdAt!: Date;

  @Prop({ type: Date, default: null })
  completedAt!: Date | null;

  // TTL index — Mongo drops the doc ~60s after expiresAt passes.
  @Prop({ type: Date, required: true, index: { expireAfterSeconds: 0 } })
  expiresAt!: Date;
}

export type InferenceJobDocument = HydratedDocument<InferenceJob>;
export const InferenceJobSchema = SchemaFactory.createForClass(InferenceJob);
