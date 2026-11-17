import { INestApplication, Logger } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { AuthGuard } from '../auth/auth.guard';
import { FactCheckClaimsModule } from '../fact-check-claims/fact-check-claims.module';
import { FACT_CHECK_CLAIMS_FETCH } from '../fact-check-claims/fact-check-claims.service';
import { WebSearchModule } from './web-search.module';
import { WEB_SEARCH_FETCH } from './web-search.service';

/**
 * A 2xx from Brave or Google whose body is not JSON. Brave echoes the query in
 * its body, and the parser's error message quotes the text it failed on, so a
 * malformed body would put the user's query in the logs. Faked at the network
 * edge (the injected fetch).
 */
const LEAK = 'LEAK7';
const QUERY = `${LEAK} what happened`;

const ENV = {
  BRAVE_SEARCH_ENABLED: 'true',
  BRAVE_SEARCH_API_KEY: 'brave-key',
  FACT_CHECK_TOOLS_ENABLED: 'true',
  FACT_CHECK_TOOLS_API_KEY: 'google-key',
};

/** An Error from fetch's realm fails `instanceof Error` here, so read its fields by name. */
function asText(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  if (typeof arg === 'object' && arg !== null && 'stack' in arg) {
    const e = arg as { name?: unknown; message?: unknown; stack?: unknown };
    return `${String(e.name)}: ${String(e.message)} ${String(e.stack)}`;
  }
  return JSON.stringify(arg);
}

/** Every Logger call at every level, as text: the most verbose view. */
function captureLogs(): () => string {
  const lines: string[] = [];
  for (const level of ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const) {
    jest.spyOn(Logger.prototype, level).mockImplementation((...args: unknown[]) => {
      lines.push(args.map(asText).join(' '));
    });
  }
  return () => lines.join('\n');
}

describe('a 2xx search body that is not JSON', () => {
  let app: INestApplication;
  let reply: { type: string; body: string };
  let logs: () => string;

  const edge = jest.fn(
    async () => new Response(reply.body, { status: 200, headers: { 'content-type': reply.type } }),
  );

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true, isGlobal: true, load: [() => ENV] }),
        WebSearchModule,
        FactCheckClaimsModule,
      ],
    })
      .overrideGuard(AuthGuard)
      .useValue({ canActivate: () => true })
      .overrideProvider(WEB_SEARCH_FETCH)
      .useValue(edge)
      .overrideProvider(FACT_CHECK_CLAIMS_FETCH)
      .useValue(edge)
      .compile();
    app = moduleRef.createNestApplication({ logger: false });
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
  });

  beforeEach(() => {
    logs = captureLogs();
  });

  afterEach(() => jest.restoreAllMocks());

  const cases: Array<[string, string, { type: string; body: string }]> = [
    [
      'web search, query echo cut short',
      '/v1/web-search',
      { type: 'application/json', body: `{"query":{"original":${QUERY}},"web":{}}` },
    ],
    [
      'web search, an error page sent with a 200',
      '/v1/web-search',
      { type: 'text/html', body: `<p>${LEAK}</p>` },
    ],
    [
      'fact check, claim text cut short',
      '/v1/fact-check-claims',
      { type: 'application/json', body: `{"claims":[{"text":${QUERY}}]}` },
    ],
    [
      'fact check, an error page sent with a 200',
      '/v1/fact-check-claims',
      { type: 'text/html', body: `<p>${LEAK}</p>` },
    ],
  ];

  it.each(cases)(
    '%s: 502, and no slice of it in a log line or the response',
    async (_, path, r) => {
      reply = r;

      const res = await request(app.getHttpServer()).post(path).send({ query: QUERY });

      expect(edge).toHaveBeenCalled();
      expect(res.status).toBe(502);
      expect(res.text).not.toContain(LEAK);
      expect(logs()).not.toContain(LEAK);
    },
  );
});
