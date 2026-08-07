import { ConfigModule } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { AuthGuard } from '../auth/auth.guard';
import { WebSearchController } from './web-search.controller';
import { WebSearchModule } from './web-search.module';
import { WEB_SEARCH_FETCH, WebSearchService } from './web-search.service';

/**
 * Container-level check: every other spec constructs the service by hand, so
 * nothing else proves the DI graph (controller → service → ConfigService +
 * WEB_SEARCH_FETCH) actually resolves. A missing provider would otherwise only
 * surface at boot — in e2e, or in production.
 *
 * AuthGuard is overridden rather than wired: it lives in the @Global AuthModule
 * and its onModuleInit reaches for a JWKS endpoint. That the controller *is*
 * guarded is asserted in web-search.controller.spec.ts.
 */
async function compile(env: Record<string, string> = {}): Promise<TestingModule> {
  return Test.createTestingModule({
    imports: [
      ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => env] }),
      WebSearchModule,
    ],
  })
    .overrideGuard(AuthGuard)
    .useValue({ canActivate: () => true })
    .compile();
}

describe('WebSearchModule', () => {
  it('resolves the controller, the service, and the fetch binding', async () => {
    const moduleRef = await compile();

    expect(moduleRef.get(WebSearchController)).toBeInstanceOf(WebSearchController);
    expect(moduleRef.get(WebSearchService)).toBeInstanceOf(WebSearchService);
    expect(typeof moduleRef.get<typeof fetch>(WEB_SEARCH_FETCH)).toBe('function');

    await moduleRef.close();
  });

  it('boots with no Brave env at all — the gate is off and the key is absent', async () => {
    const moduleRef = await compile();
    const app = moduleRef.createNestApplication();

    await expect(app.init()).resolves.toBeDefined();

    await app.close();
  });

  it('boots with the gate on and a key present', async () => {
    const moduleRef = await compile({
      BRAVE_SEARCH_ENABLED: 'true',
      BRAVE_SEARCH_API_KEY: 'k',
    });
    const app = moduleRef.createNestApplication();

    await expect(app.init()).resolves.toBeDefined();

    await app.close();
  });
});
