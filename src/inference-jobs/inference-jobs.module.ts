import { Module } from '@nestjs/common';
import { InferenceJobsController } from './inference-jobs.controller';
import { InferenceJobsService } from './inference-jobs.service';
import { QueuesModule } from '../queues/queues.module';

// JOB_STORE is provided by the global JobStoreModule (composition root in
// app.module.ts), so no storage imports here.
@Module({
  imports: [QueuesModule],
  controllers: [InferenceJobsController],
  providers: [InferenceJobsService],
})
export class InferenceJobsModule {}
