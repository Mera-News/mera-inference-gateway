import { Global, Module } from '@nestjs/common';
import { AuthGuard } from './auth.guard';
import { CapabilityTokenService } from './capability-token.service';

// Global so AuthGuard's CapabilityTokenService dependency resolves wherever
// the guard is bound via @UseGuards(AuthGuard) — chat, attestation, jobs.
@Global()
@Module({
  providers: [AuthGuard, CapabilityTokenService],
  exports: [AuthGuard, CapabilityTokenService],
})
export class AuthModule {}
