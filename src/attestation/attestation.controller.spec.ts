import { Logger } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AttestationController } from './attestation.controller';
import { AttestationService } from './attestation.service';

type MockAttestationService = { proxyAttestationReport: jest.Mock };

function makeService(): MockAttestationService {
  return { proxyAttestationReport: jest.fn() };
}

function makeReq(url: string): Request {
  return { url } as unknown as Request;
}

function makeRes(headersSent = false): Response {
  const res = {
    headersSent,
    status: jest.fn(),
    setHeader: jest.fn(),
    send: jest.fn(),
    json: jest.fn(),
  } as unknown as Response;

  // Make the chainable methods return `res` so chained calls work.
  (res.status as jest.Mock).mockReturnValue(res);
  (res.setHeader as jest.Mock).mockReturnValue(res);
  (res.send as jest.Mock).mockReturnValue(res);
  (res.json as jest.Mock).mockReturnValue(res);

  return res;
}

function makeUpstream(opts: {
  status: number;
  contentType: string | null;
  body: string;
}): globalThis.Response {
  return {
    status: opts.status,
    ok: opts.status >= 200 && opts.status < 300,
    headers: { get: jest.fn().mockReturnValue(opts.contentType) },
    text: jest.fn().mockResolvedValue(opts.body),
  } as unknown as globalThis.Response;
}

describe('AttestationController', () => {
  let controller: AttestationController;
  let service: MockAttestationService;

  beforeEach(() => {
    service = makeService();
    controller = new AttestationController(service as unknown as AttestationService);
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    jest.spyOn(Logger.prototype, 'debug').mockImplementation();
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe('getReport', () => {
    describe('happy path', () => {
      it('extracts query string from req.url and passes it to the service', async () => {
        const upstream = makeUpstream({
          status: 200,
          contentType: 'application/json',
          body: 'BODY',
        });
        service.proxyAttestationReport.mockResolvedValue(upstream);

        const req = makeReq('/api/attestation/report?nonce=abc');
        const res = makeRes();

        await controller.getReport(req, res);

        expect(service.proxyAttestationReport).toHaveBeenCalledWith('nonce=abc');
      });

      it('sets status 200, Content-Type header, and sends the body', async () => {
        const upstream = makeUpstream({
          status: 200,
          contentType: 'application/json',
          body: 'BODY',
        });
        service.proxyAttestationReport.mockResolvedValue(upstream);

        const req = makeReq('/api/attestation/report?nonce=abc');
        const res = makeRes();

        await controller.getReport(req, res);

        expect(res.status).toHaveBeenCalledWith(200);
        expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'application/json');
        expect(res.send).toHaveBeenCalledWith('BODY');
      });
    });

    describe('Content-Type header handling', () => {
      it('does NOT call setHeader for Content-Type when upstream headers.get returns null', async () => {
        const upstream = makeUpstream({
          status: 200,
          contentType: null,
          body: 'BODY',
        });
        service.proxyAttestationReport.mockResolvedValue(upstream);

        const req = makeReq('/api/attestation/report?nonce=abc');
        const res = makeRes();

        await controller.getReport(req, res);

        expect(res.setHeader).not.toHaveBeenCalledWith('Content-Type', expect.anything());
        expect(res.send).toHaveBeenCalledWith('BODY');
      });
    });

    describe('query string extraction', () => {
      it('calls service with empty string when req.url has no `?`', async () => {
        const upstream = makeUpstream({
          status: 200,
          contentType: 'text/plain',
          body: '',
        });
        service.proxyAttestationReport.mockResolvedValue(upstream);

        const req = makeReq('/api/attestation/report');
        const res = makeRes();

        await controller.getReport(req, res);

        expect(service.proxyAttestationReport).toHaveBeenCalledWith('');
      });
    });

    describe('error handling', () => {
      it('logs the error and responds 502 when service rejects', async () => {
        const err = new Error('upstream down');
        service.proxyAttestationReport.mockRejectedValue(err);

        const req = makeReq('/api/attestation/report?nonce=abc');
        const res = makeRes(false);

        await controller.getReport(req, res);

        expect(res.status).toHaveBeenCalledWith(502);
        expect(res.json).toHaveBeenCalledWith({
          error: 'Upstream request failed',
          reason: 'upstream down',
        });
      });

      it('does NOT call res.status(502) when headersSent is true', async () => {
        const err = new Error('upstream down');
        service.proxyAttestationReport.mockRejectedValue(err);

        const req = makeReq('/api/attestation/report?nonce=abc');
        const res = makeRes(true);

        await controller.getReport(req, res);

        expect(res.status).not.toHaveBeenCalledWith(502);
        expect(res.json).not.toHaveBeenCalled();
      });
    });
  });
});
