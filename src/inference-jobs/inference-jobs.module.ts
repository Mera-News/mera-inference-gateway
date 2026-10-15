import { Module } from '@nestjs/common';
import { InferenceJobsController } from './inference-jobs.controller';
import { InferenceJobsService } from './inference-jobs.service';
import { ReadMeterService } from './read-meter.service';
import { QueuesModule } from '../queues/queues.module';

// JOB_STORE is provided by the global JobStoreModule (composition root in
// app.module.ts), so no storage imports here.
@Module({
  imports: [QueuesModule],
  controllers: [InferenceJobsController],
  providers: [InferenceJobsService, ReadMeterService],
})
export class InferenceJobsModule {}
