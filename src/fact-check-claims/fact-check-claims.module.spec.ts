import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthGuard } from '../auth/auth.guard';
import { FactCheckClaimsController } from './fact-check-claims.controller';
import { FactCheckClaimsModule } from './fact-check-claims.module';
import { FACT_CHECK_CLAIMS_FETCH, FactCheckClaimsService } from './fact-check-claims.service';

/**
 * Container-level check, mirroring web-search.module.spec.ts: every other spec
 * constructs the service by hand, so nothing else proves the DI graph
 * (controller → service → ConfigService + FACT_CHECK_CLAIMS_FETCH) resolves. A
 * missing provider would otherwise only surface at boot — in production.
 */
async function compile(env: Record<string, string> = {}): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => env] }),
      FactCheckClaimsModule,
    ],
  })
    .overrideGuard(AuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
}

describe('FactCheckClaimsModule', () => {
  it('resolves the controller, the service, and the fetch binding', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(FactCheckClaimsController)).toBeInstanceOf(FactCheckClaimsController);
    expect(moduleRef.get(FactCheckClaimsService)).toBeInstanceOf(FactCheckClaimsService);
    expect(typeof moduleRef.get<typeof fetch>(FACT_CHECK_CLAIMS_FETCH)).toBe('function');

    await moduleRef.close();
  });

  it('boots with no fact-check env at all — the gate is off and the key is absent', async () => {
    const moduleRef = await compile();
    const app = moduleRef.createNestApplication();

    await expect(app.init()).resolves.toBeDefined();

    await app.close();
  });

  it('boots with the gate on and a key present', async () => {
    const moduleRef = await compile({
      FACT_CHECK_TOOLS_ENABLED: 'true',
      FACT_CHECK_TOOLS_API_KEY: 'k',
    });
    const app = moduleRef.createNestApplication();

    await expect(app.init()).resolves.toBeDefined();

    await app.close();
  });
});
