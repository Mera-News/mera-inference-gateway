import { Controller, Get, Logger, Query, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { parseProvider } from '../constants';
import { RoutingService } from '../routing/routing.service';
import { AuthGuard } from '../auth/auth.guard';
import { AttestationService } from './attestation.service';
import { ComposeFileRelay } from './compose-file';

@Controller('api')
@UseGuards(AuthGuard)
export class AttestationController {
  private readonly logger = new Logger(AttestationController.name);
  private readonly composeFiles = new ComposeFileRelay();

  constructor(
    private readonly attestationService: AttestationService,
    private readonly routing: RoutingService,
  ) {}

  @Get('attestation/compose-file')
  async getComposeFile(
    @Query('commit') commit: unknown,
    @Query('file') file: unknown,
    @Res() res: Response,
  ) {
    const body = await this.composeFiles.fetchFile(commit, file);
    res.status(200).type('text/plain; charset=utf-8').send(body);
  }

  @Get('attestation/report')
  async getReport(@Req() req: Request, @Res() res: Response) {
    const provider = parseProvider(req.headers['x-mera-provider']);
    if (!provider) {
      res.status(400).json({ error: 'Unknown X-Mera-Provider' });
      return;
    }
    const queryString = req.url.split('?')[1] ?? '';
    const model = new URLSearchParams(queryString).get('model');
    if (!this.routing.keyFor(provider) || (model && (await this.routing.isDown(provider, model)))) {
      res.status(503).json(await this.routing.unavailableBody());
      return;
    }
    const startedAt = Date.now();
    try {
      const upstream = await this.attestationService.proxyAttestationReport(queryString, provider);

      res.status(upstream.status);
      const contentType = upstream.headers.get('content-type');
      if (contentType) res.setHeader('Content-Type', contentType);
      const body = await upstream.text();
      res.send(body);
    } catch (error) {
      const elapsedMs = Date.now() - startedAt;
      const err = error as (Error & { code?: string; cause?: { code?: string } }) | undefined;
      this.logger.error(
        {
          msg: 'Attestation proxy failed',
          queryString,
          elapsedMs,
          errorName: err?.name,
          errorMessage: err?.message,
          errorCode: err?.code ?? err?.cause?.code,
        },
        err?.stack,
      );
      if (!res.headersSent) {
        res.status(502).json({
          error: 'Upstream request failed',
          reason: err?.message ?? 'unknown',
        });
      }
    }
  }
}
