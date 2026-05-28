import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { UPSTREAM_BASE_URL } from '../constants';

@Injectable()
export class AttestationService {
  private readonly logger = new Logger(AttestationService.name);
  private readonly apiKey: string;

  constructor(private configService: ConfigService) {
    const key = this.configService.get<string>('NEAR_AI_API_KEY', '');
    if (!key) {
      throw new Error('NEAR_AI_API_KEY environment variable is not set');
    }
    this.apiKey = key;
  }

  /** Pure proxy: forward query params as-is to the attestation endpoint,
   *  return raw Response. */
  async proxyAttestationReport(queryString: string): Promise<globalThis.Response> {
    const url = `${UPSTREAM_BASE_URL}/attestation/report${queryString ? `?${queryString}` : ''}`;
    this.logger.debug(`Proxying attestation report: ${url}`);

    const controller = new AbortController();
    const timeoutMs = 30_000;
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    try {
      return await fetch(url, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.apiKey}` },
        signal: controller.signal,
      });
    } catch (error) {
      if ((error as Error)?.name === 'AbortError') {
        throw new Error(`Upstream attestation timeout after ${timeoutMs}ms (url=${url})`);
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }
}
