import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
  UseGuards,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import type { Response } from 'express';
import { Readable } from 'stream';
import { AuthGuard } from '../auth/auth.guard';
import type { AuthenticatedRequest } from '../auth/auth.guard';
import { InferenceJobsService } from './inference-jobs.service';
import { InferenceJob, InferenceJobDocument } from '../models/inference-job.schema';
import { SubmitJobDto } from './dto/submit-job.dto';

@Controller('v1/inference')
@UseGuards(AuthGuard)
export class InferenceJobsController {
  private readonly logger = new Logger(InferenceJobsController.name);

  constructor(
    private readonly jobs: InferenceJobsService,
    @InjectModel(InferenceJob.name)
    private readonly inferenceJobModel: Model<InferenceJobDocument>,
  ) {}

  @Post('jobs')
  @HttpCode(202)
  async submit(
    @Req() req: AuthenticatedRequest,
    @Body() dto: SubmitJobDto,
  ): Promise<{ requestId: string; capabilityToken: string }> {
    // Capability-token authed callers (phase-2 chain from background) must
    // hold the `jobs:submit-followup` scope. The original submit always
    // happens with a JWT — no capability claims attached.
    if (req.user.capability) {
      if (!req.user.capability.scopes.includes('jobs:submit-followup')) {
        throw new ForbiddenException('Capability token missing jobs:submit-followup scope');
      }
    }
    return this.jobs.submit(req.user.id, dto);
  }

  @Get('jobs/:requestId/results')
  async getResults(
    @Param('requestId') requestId: string,
    @Req() req: AuthenticatedRequest,
    @Res({ passthrough: true }) res: Response,
  ): Promise<StreamableFile | { pending: true }> {
    if (!Types.ObjectId.isValid(requestId)) {
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

    const doc = await this.inferenceJobModel
      .findById(new Types.ObjectId(requestId), {
        userId: 1,
        status: 1,
        results: 1,
      })
      .lean()
      .exec();

    if (!doc) {
      throw new NotFoundException('Unknown requestId');
    }
    if (doc.userId !== req.user.id) {
      throw new ForbiddenException();
    }
    if (doc.status !== 'completed') {
      return { pending: true };
    }

    const raw = JSON.stringify({
      requestId,
      results: doc.results ?? [],
    });

    // Do NOT delete on fetch — the TTL index handles cleanup after 24h, and
    // keeping the doc available for the window lets the client's foreground
    // reconcile refetch safely if mid-parse it crashes.
    res.setHeader('Cache-Control', 'no-store');

    return new StreamableFile(Readable.from(raw), {
      type: 'application/json',
      length: Buffer.byteLength(raw),
    });
  }
}
