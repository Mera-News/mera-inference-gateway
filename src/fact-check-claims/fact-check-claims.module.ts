import { Module } from '@nestjs/common';
import { FactCheckClaimsController } from './fact-check-claims.controller';
import { FACT_CHECK_CLAIMS_FETCH, FactCheckClaimsService } from './fact-check-claims.service';

/**
 * Composition root for the ClaimReview lookup. `fetch` is bound here as a
 * provider so specs inject a stub and never touch the network — the service
 * itself holds no reference to the global. Same shape as `WebSearchModule`.
 */
@Module({
  controllers: [FactCheckClaimsController],
  providers: [
    FactCheckClaimsService,
    {
      provide: FACT_CHECK_CLAIMS_FETCH,
      useValue: globalThis.fetch.bind(globalThis),
    },
  ],
})
export class FactCheckClaimsModule {}
