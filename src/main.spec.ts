/**
 * main.spec.ts
 *
 * Tests the bootstrap() function in main.ts by mocking every external
 * dependency so that importing the module runs bootstrap() end-to-end
 * without starting a real server or needing any env vars.
 *
 * Strategy
 * ────────
 * 1. jest.mock() calls are hoisted to the top of the file by babel-jest /
 *    ts-jest, so they run before any import.
 * 2. For each test we:
 *    a. Set `configVals` to control what ConfigService.get() returns.
 *    b. Call jest.resetModules() to discard the cached main.ts module.
 *    c. Dynamically `import('./main')` which re-executes `void bootstrap()`.
 *    d. Await a microtask flush so the async bootstrap completes.
 *    e. Assert on the fake app's method calls.
 */

// ── Hoisted top-level state shared by all mocks ───────────────────────────────

/** Overridden per test; ConfigService.get() reads from here. */
let configVals: Record<string, unknown> = {};

/** Holds the fake app instance that NestFactory.create() resolves to. */
let fakeApp: ReturnType<typeof makeFakeApp>;

/** Holds the basicAuth mock fn so we can assert on its call args. */
let basicAuthMock: jest.Mock;

/** Holds the compression mock fn so we can capture the filter option. */
let compressionMock: jest.Mock & { filter: jest.Mock };

// ── Mock: @nestjs/core ────────────────────────────────────────────────────────
jest.mock('@nestjs/core', () => ({
  NestFactory: { create: jest.fn() },
}));

// ── Mock: ./app.module  (avoids pulling the entire DI graph) ─────────────────
jest.mock('./app.module', () => ({ AppModule: class AppModule {} }));

// ── Mock: expo-server-sdk  (reached via the app.module import graph) ─────────
jest.mock('expo-server-sdk', () => {
  const isExpoPushToken = () => false;
  class Expo {
    static isExpoPushToken = isExpoPushToken;
    chunkPushNotifications = () => [];
    sendPushNotificationsAsync = async () => [];
    constructor(_o?: unknown) {}
  }
  return { Expo };
});

// ── Mock: dotenv ──────────────────────────────────────────────────────────────
jest.mock('dotenv', () => ({ config: jest.fn() }));

// ── Mock: nestjs-pino  (so we can identify the Logger token) ─────────────────
jest.mock('nestjs-pino', () => ({
  Logger: class Logger {},
  LoggerModule: {
    forRoot: () => ({ module: class {} }),
    forRootAsync: () => ({ module: class {} }),
  },
  InjectPinoLogger: () => () => {},
}));

// ── Mock: helmet ──────────────────────────────────────────────────────────────
jest.mock('helmet', () => ({
  __esModule: true,
  default: () => (_req: unknown, _res: unknown, next: (() => void) | undefined) => next?.(),
}));

// ── Mock: compression  (assigned lazily so tests can capture options) ─────────
jest.mock('compression', () => {
  const filterFn = jest.fn(() => true);
  const fn: jest.Mock & { filter: jest.Mock } = Object.assign(
    jest.fn((_opts?: unknown) => (_req: unknown, _res: unknown, n?: () => void) => n?.()),
    { filter: filterFn },
  );
  return { __esModule: true, default: fn };
});

// ── Mock: express-basic-auth ──────────────────────────────────────────────────
jest.mock('express-basic-auth', () => ({
  __esModule: true,
  default: jest.fn(() => (_req: unknown, _res: unknown, n?: () => void) => n?.()),
}));

// ── Mock: express ─────────────────────────────────────────────────────────────
jest.mock('express', () => ({
  json: jest.fn(() => 'json-mw'),
  urlencoded: jest.fn(() => 'url-mw'),
}));

// ── Mock: ./filters/http-exception.filter ────────────────────────────────────
jest.mock('./filters/http-exception.filter', () => ({
  HttpExceptionFilter: jest.fn().mockImplementation(() => ({})),
}));

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeFakeApp() {
  const fakeLogger = { log: jest.fn() };
  const fakeConfigService = {
    get: jest.fn((key: string, fallback?: unknown) => {
      if (key in configVals) return configVals[key];
      return fallback;
    }),
  };

  // A single object that satisfies both the Logger and ConfigService shapes.
  // app.get() is called twice in main.ts: first for Logger, then for ConfigService.
  // We distinguish by call order (first call → logger, second → config service).
  let getCallCount = 0;
  const app = {
    get: jest.fn(() => {
      getCallCount++;
      if (getCallCount === 1) return fakeLogger;
      return fakeConfigService;
    }),
    use: jest.fn(),
    useLogger: jest.fn(),
    enableShutdownHooks: jest.fn(),
    useGlobalPipes: jest.fn(),
    useGlobalFilters: jest.fn(),
    enableCors: jest.fn(),
    listen: jest.fn().mockResolvedValue(undefined),
    _logger: fakeLogger,
    _configService: fakeConfigService,
    _resetGetCallCount: () => {
      getCallCount = 0;
    },
  };
  return app;
}

/** Re-run bootstrap() by resetting module registry and re-importing main. */

async function runBootstrap() {
  jest.resetModules();
  // Re-wire NestFactory.create to return our fresh fake app. ts-jest compiles
  // to CommonJS under `module: nodenext`, so we use require() — a dynamic
  // import() would be emitted as a real ESM import and fail under jest's VM.
  const { NestFactory } = require('@nestjs/core');
  fakeApp = makeFakeApp();
  (NestFactory.create as jest.Mock).mockResolvedValue(fakeApp);

  // Capture fresh references to the other mocks (the factories run fresh each
  // time the module registry is reset, so re-requiring yields current handles).
  basicAuthMock = require('express-basic-auth').default as jest.Mock;
  compressionMock = require('compression').default as jest.Mock & {
    filter: jest.Mock;
  };

  // Import main.ts — this executes `void bootstrap()` at module load time.
  require('./main');

  // Flush the microtask queue so the async bootstrap() completes.
  await new Promise<void>((resolve) => setImmediate(resolve));
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('main.ts bootstrap()', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    configVals = {};
  });

  // ── 1. Credentials present ─────────────────────────────────────────────────
  describe('when Bull Board credentials are configured', () => {
    beforeEach(async () => {
      configVals = {
        BULLBOARD_ADMIN_USERNAME: 'u',
        BULLBOARD_ADMIN_PASSWORD: 'p',
        PORT: 8080,
      };
      await runBootstrap();
    });

    it('registers basic-auth middleware on /queues', () => {
      const useCallsWithQueuesPath = fakeApp.use.mock.calls.filter((args) => args[0] === '/queues');
      expect(useCallsWithQueuesPath.length).toBeGreaterThanOrEqual(1);
    });

    it('calls basicAuth with correct users object', () => {
      // Find the basicAuth call that set up user credentials.
      expect(basicAuthMock).toHaveBeenCalledWith(expect.objectContaining({ users: { u: 'p' } }));
    });

    it('app.listen is called with port 8080', () => {
      expect(fakeApp.listen).toHaveBeenCalledWith(8080);
    });

    it('logs the startup message', () => {
      expect(fakeApp._logger.log).toHaveBeenCalledWith(expect.stringContaining('8080'));
    });
  });

  // ── 2. Credentials absent → fail-closed 503 ────────────────────────────────
  describe('when Bull Board credentials are absent', () => {
    beforeEach(async () => {
      configVals = { PORT: 8080 };
      await runBootstrap();
    });

    it('registers a /queues handler that returns 503', () => {
      const queuesCall = fakeApp.use.mock.calls.find((args) => args[0] === '/queues');
      expect(queuesCall).toBeDefined();

      const handler = queuesCall![1] as (req: unknown, res: unknown) => void;

      // Build a minimal Express-style response spy
      const res: { status: jest.Mock; send: jest.Mock } = {
        status: jest.fn().mockReturnThis(),
        send: jest.fn(),
      };

      handler({}, res);

      expect(res.status).toHaveBeenCalledWith(503);
      expect(res.send).toHaveBeenCalledWith('Bull Board disabled');
    });
  });

  // ── 3. Compression filter ──────────────────────────────────────────────────
  describe('compression filter option', () => {
    beforeEach(async () => {
      configVals = { PORT: 8080 };
      await runBootstrap();
    });

    it('returns false for /v1/chat/completions', () => {
      // The compression mock was called with an options object containing filter.
      const compressionCallArgs = compressionMock.mock.calls[0];
      expect(compressionCallArgs).toBeDefined();
      const opts = compressionCallArgs[0] as {
        filter?: (req: { path: string }, res: unknown) => boolean;
      };
      expect(opts.filter).toBeDefined();

      const result = opts.filter!({ path: '/v1/chat/completions' }, {});
      expect(result).toBe(false);
    });

    it('delegates to compression.filter for other paths', () => {
      const compressionCallArgs = compressionMock.mock.calls[0];
      const opts = compressionCallArgs[0] as {
        filter?: (req: { path: string }, res: unknown) => boolean;
      };

      const fakeReq = { path: '/other' };
      const fakeRes = {};
      opts.filter!(fakeReq, fakeRes);

      // The real compression.filter (mocked to return true) should have been called.
      expect(compressionMock.filter).toHaveBeenCalledWith(fakeReq, fakeRes);
    });
  });

  // ── 4. Default PORT fallback ───────────────────────────────────────────────
  describe('when PORT is not set', () => {
    beforeEach(async () => {
      configVals = {
        BULLBOARD_ADMIN_USERNAME: 'admin',
        BULLBOARD_ADMIN_PASSWORD: 'secret',
      };
      await runBootstrap();
    });

    it('listens on default port 8080', () => {
      // ConfigService.get('PORT', 8080) should fall through to fallback 8080.
      expect(fakeApp.listen).toHaveBeenCalledWith(8080);
    });

    it('logs success message with port 8080', () => {
      expect(fakeApp._logger.log).toHaveBeenCalledWith(expect.stringContaining('8080'));
    });
  });

  // ── 5. Core bootstrap wiring (sanity checks for the happy path) ───────────
  describe('core wiring', () => {
    beforeEach(async () => {
      configVals = { PORT: 3333 };
      await runBootstrap();
    });

    it('calls app.enableShutdownHooks()', () => {
      expect(fakeApp.enableShutdownHooks).toHaveBeenCalled();
    });

    it('calls app.useGlobalPipes()', () => {
      expect(fakeApp.useGlobalPipes).toHaveBeenCalled();
    });

    it('calls app.useGlobalFilters()', () => {
      expect(fakeApp.useGlobalFilters).toHaveBeenCalled();
    });

    it('calls app.enableCors()', () => {
      expect(fakeApp.enableCors).toHaveBeenCalled();
    });

    it('calls app.useLogger()', () => {
      expect(fakeApp.useLogger).toHaveBeenCalled();
    });
  });
});
