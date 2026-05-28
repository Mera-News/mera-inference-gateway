import { Controller, Get, Logger, Req, Res, UseGuards } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AuthGuard } from '../auth/auth.guard';
import { AttestationService } from './attestation.service';

@Controller('api')
@UseGuards(AuthGuard)
export class AttestationController {
  private readonly logger = new Logger(AttestationController.name);

  constructor(private readonly attestationService: AttestationService) {}

  @Get('attestation/report')
  async getReport(@Req() req: Request, @Res() res: Response) {
    const queryString = req.url.split('?')[1] ?? '';
    const startedAt = Date.now();
    try {
      const upstream = await this.attestationService.proxyAttestationReport(queryString);

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
