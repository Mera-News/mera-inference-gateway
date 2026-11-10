import { Module } from '@nestjs/common';
import { AttestationController } from './attestation.controller';
import { RoutingModule } from '../routing/routing.module';
import { AttestationService } from './attestation.service';

@Module({
  imports: [RoutingModule],
  controllers: [AttestationController],
  providers: [AttestationService],
})
export class AttestationModule {}
