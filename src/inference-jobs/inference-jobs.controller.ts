import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  Inject,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { Readable } from 'stream';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { DailyReadingExceededError, InferenceJobsService } from './inference-jobs.service';
import { SubmitJobDto } from './dto/submit-job.dto';
import { JOB_STORE, type JobStore } from './job-store.port';

// Validated before the raw header value is ever sha256-hashed into a Redis
// key — bounds length and character set so no client string can shape key
// syntax, independent of the fact that only the hash is ever used as a key.
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9:_-]{1,128}$/;

/** Longest Retry-After a reading refusal advertises. The app re-checks on its
 *  own schedule; a value of hours would only park its shared limiter. */
const READING_RETRY_AFTER_CAP_SECONDS = 60;

@Controller('v1/inference')
@UseGuards(AuthGuard)
export class InferenceJobsController {
  private readonly logger = new Logger(InferenceJobsController.name);

  constructor(
    private readonly jobs: InferenceJobsService,
    @Inject(JOB_STORE) private readonly store: JobStore,
  ) {}

  @Post('jobs')
  @HttpCode(202)
  async submit(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SubmitJobDto,
    @Headers('idempotency-key') idempotencyKey?: string,
    @Headers('x-mera-reading') readingClient?: string,
    @Res({ passthrough: true }) res?: Response,
  ): Promise<{ requestId: string; capabilityToken: string }> {
    // Capability-token authed callers (phase-2 chain from background) must
    // hold the `jobs:submit-followup` scope. The original submit always
    // happens with a JWT — no capability claims attached.
    if (req.user.capability) {
      if (!req.user.capability.scopes.includes('jobs:submit-followup')) {
        throw new ForbiddenException('Capability token missing jobs:submit-followup scope');
      }
    }
    // Optional: a missing header behaves exactly as before this feature
    // existed. When present, format is checked before anything touches
    // Redis — the service only ever sees a validated string, which it then
    // sha256-hashes before using it as a key.
    if (idempotencyKey !== undefined && !IDEMPOTENCY_KEY_PATTERN.test(idempotencyKey)) {
      throw new BadRequestException('Invalid Idempotency-Key');
    }
    let result;
    try {
      result = await this.jobs.submit(req.user.id, dto, idempotencyKey, {
        tier: req.user.tier,
        followup: req.user.capability !== undefined,
      });
    } catch (err) {
      if (!(err instanceof DailyReadingExceededError)) throw err;
      const body = { code: 'daily-quota-exceeded', resetAt: err.resetAt.toISOString() };
      // Clients that predate the meter (no X-Mera-Reading header) answer 429
      // by pausing every gateway call they make, and 401/403/409/5xx each
      // trigger worse handling. A 402 lands in their plain "submit failed"
      // branch: one POST, batch retried later, nothing paused.
      if (readingClient !== '1') throw new HttpException(body, 402);
      const toReset = Math.ceil((err.resetAt.getTime() - err.nowMs) / 1000);
      res?.setHeader(
        'Retry-After',
        String(Math.max(1, Math.min(READING_RETRY_AFTER_CAP_SECONDS, toReset))),
      );
      throw new HttpException(body, 429);
    }
    const { readingUsed, ...out } = result;
    if (readingUsed !== undefined) {
      res?.setHeader('X-Mera-Reading-Used', String(Math.round(readingUsed * 1000) / 1000));
    }
    return out;
  }

  @Get('jobs/:requestId/results')
  async getResults(
    @Param('requestId') requestId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | { pending: true }> {
    // The store mints 24-hex ids (crypto.randomBytes). Validating the shape up
    // front also guarantees the id can never smuggle key-syntax characters into
    // the store lookup.
    if (!/^[0-9a-f]{24}$/.test(requestId)) {
      throw new BadRequestException('Invalid requestId');
    }

    // Capability tokens are bound to a specific requestId. A token minted
    // for cycle A must not be usable to read cycle B even if both belong to
    // the same user — otherwise a leaked token's blast radius widens to
    // every job in the user's 24h history.
    if (req.user.capability) {
      if (!req.user.capability.scopes.includes('results:read')) {
        throw new ForbiddenException('Capability token missing results:read scope');
      }
      if (req.user.capability.rid !== requestId) {
        throw new ForbiddenException('Capability token bound to a different requestId');
      }
    }

    const view = await this.store.getResultsView(requestId);

    if (!view) {
      throw new NotFoundException('Unknown requestId');
    }
    if (view.userId !== req.user.id) {
      throw new ForbiddenException();
    }
    if (view.status !== 'completed') {
      return { pending: true };
    }

    const raw = JSON.stringify({
      requestId,
      results: view.results,
    });

    // Do NOT delete on fetch — the store's TTL handles cleanup after 24h, and
    // keeping the job available for the window lets the client's foreground
    // reconcile refetch safely if mid-parse it crashes.
    res.setHeader('Cache-Control', 'no-store');

    return new StreamableFile(Readable.from(raw), {
      type: 'application/json',
      length: Buffer.byteLength(raw),
    });
  }
}
