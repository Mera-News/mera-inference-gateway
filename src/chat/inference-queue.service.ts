import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

@Injectable()
export class InferenceQueueService {
  private readonly logger = new Logger(InferenceQueueService.name);
  private readonly maxConcurrency: number;
  private readonly maxDepth: number;
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(config: ConfigService) {
    // Cap simultaneous upstream inference calls (default 8) to stay within
    // NEAR AI rate limits; excess requests wait rather than fan out.
    this.maxConcurrency = config.get<number>('INFERENCE_MAX_CONCURRENCY', 8);
    // Reject (vs. queue indefinitely) once active + waiting exceeds 200, so a
    // backlog sheds load instead of exhausting memory.
    this.maxDepth = config.get<number>('INFERENCE_MAX_QUEUE_DEPTH', 200);
    this.logger.log(
      `InferenceQueue ready maxConcurrency=${this.maxConcurrency} maxDepth=${this.maxDepth}`,
    );
  }

  canAccept(incoming: number): boolean {
    return this.active + this.waiters.length + incoming <= this.maxDepth;
  }

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }

  snapshot(): { active: number; waiting: number } {
    return { active: this.active, waiting: this.waiters.length };
  }
}
