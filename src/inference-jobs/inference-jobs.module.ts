import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { InferenceJobsController } from './inference-jobs.controller';
import { InferenceJobsService } from './inference-jobs.service';
import { InferenceJob, InferenceJobSchema } from './inference-job.schema';
import { QueuesModule } from '../queues/queues.module';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: InferenceJob.name, schema: InferenceJobSchema }]),
    QueuesModule,
  ],
  controllers: [InferenceJobsController],
  providers: [InferenceJobsService],
})
export class InferenceJobsModule {}
