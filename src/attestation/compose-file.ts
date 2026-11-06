import { HttpException, Logger } from '@nestjs/common';

const REPO_RAW_URL = 'https://raw.githubusercontent.com/nearai/cvm-compose-files';
const COMMIT_PATTERN = /^[0-9a-f]{40}$/;
const FILE_PATTERN = /^prod\/[A-Za-z0-9._-]+\.ya?ml$/;

const MAX_FILE_BYTES = 1024 * 1024;
const FETCH_TIMEOUT_MS = 8_000;
/** A verify tap reads one or two files, and they change a few times a day. */
const MAX_CACHED_FILES = 8;
/** Same bound as GpuAttestationRelay: a tap is one person checking by hand. */
const MAX_CALLS_PER_WINDOW = 60;
const WINDOW_MS = 60 * 1000;

/**
 * Relays one file of NEAR's public compose repo at an exact commit, so phones
 * don't contact GitHub. The gateway is untrusted here too: the app checks the
 * bytes against the hash in NEAR's attested action log, so nothing here reads them.
 */
export class ComposeFileRelay {
  private readonly logger = new Logger(ComposeFileRelay.name);
  private readonly cache = new Map<string, Buffer>();
  private windowStartedAt = 0;
  private windowCalls = 0;

  async fetchFile(commit: unknown, file: unknown): Promise<Buffer> {
    if (
      typeof commit !== 'string' ||
      typeof file !== 'string' ||
      !COMMIT_PATTERN.test(commit) ||
      !FILE_PATTERN.test(file)
    ) {
      throw new HttpException({ error: 'Invalid commit or file' }, 400);
    }

    const key = `${commit}/${file}`;
    const cached = this.cache.get(key);
    if (cached) return cached;

    // 503, not 429: the app answers a 429 by pausing every gateway call it makes.
    if (this.overCap()) throw new HttpException({ error: 'Compose file unavailable' }, 503);

    const startedAt = Date.now();
    let status: number | undefined;
    try {
      const response = await fetch(`${REPO_RAW_URL}/${key}`, {
        redirect: 'error',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      status = response.status;
      if (status !== 200) throw new Error('Upstream refused');
      if (Number(response.headers.get('content-length') ?? 0) > MAX_FILE_BYTES) {
        throw new Error('File too large');
      }
      const body = Buffer.from(await response.arrayBuffer());
      if (body.length > MAX_FILE_BYTES) throw new Error('File too large');

      this.cache.set(key, body);
      if (this.cache.size > MAX_CACHED_FILES) {
        this.cache.delete(this.cache.keys().next().value as string);
      }
      return body;
    } catch (error) {
      // Name only, so no upstream text reaches the logs.
      this.logger.warn(
        `Compose file not relayed: error=${(error as Error)?.name} status=${status} elapsedMs=${Date.now() - startedAt}`,
      );
      throw new HttpException({ error: 'Compose file unavailable' }, 502);
    }
  }

  private overCap(): boolean {
    const now = Date.now();
    if (now - this.windowStartedAt >= WINDOW_MS) {
      this.windowStartedAt = now;
      this.windowCalls = 0;
    }
    this.windowCalls += 1;
    return this.windowCalls > MAX_CALLS_PER_WINDOW;
  }
}
