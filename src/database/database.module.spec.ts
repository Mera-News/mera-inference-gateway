/**
 * database.module.spec.ts
 *
 * Uses the CAPTURE-THE-FACTORY pattern: we mock @nestjs/mongoose so that
 * MongooseModule.forRootAsync records the useFactory into a module-scoped
 * capture object instead of doing real I/O.  Importing DatabaseModule then
 * triggers its decorator (which calls the mocked forRootAsync), and our
 * tests can invoke the captured factory directly with a mock ConfigService.
 */

const mockCapture: Record<string, any> = {};

jest.mock('@nestjs/mongoose', () => ({
  MongooseModule: {
    forRootAsync: (opts: any) => {
      // The real factory is the function we want to test.
      mockCapture.mongoFactory = opts.useFactory;
      return { module: class MongooseRootStub {} };
    },
    forFeature: () => ({ module: class MongooseFeatureStub {} }),
  },
  InjectModel: () => () => {},
  Prop: () => () => {},
  Schema: () => () => {},
  SchemaFactory: {
    createForClass: () => ({}),
  },
}));

// Import the real module AFTER the mock is set up so the decorator runs and
// calls the mocked forRootAsync, which captures the factory.
import { DatabaseModule } from './database.module';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal ConfigService stub: vals[k] if key present, otherwise fallback. */
const cfg = (vals: Record<string, unknown>) => ({
  get: (k: string, fb?: unknown) => (k in vals ? vals[k] : fb),
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DatabaseModule – Mongoose useFactory', () => {
  it('DatabaseModule is defined', () => {
    expect(DatabaseModule).toBeDefined();
  });

  it('factory was captured (sanity)', () => {
    expect(typeof mockCapture.mongoFactory).toBe('function');
  });

  it('returns correct options with minimum config (default maxPoolSize=3)', () => {
    const result = mockCapture.mongoFactory(cfg({ INFERENCE_MONGODB_URI: 'mongodb://x' }));
    expect(result).toMatchObject({
      uri: 'mongodb://x',
      maxPoolSize: 3,
      minPoolSize: 0,
      maxIdleTimeMS: 30_000,
      serverSelectionTimeoutMS: 10_000,
    });
  });

  it('respects INFERENCE_MONGODB_MAX_POOL_SIZE override', () => {
    const result = mockCapture.mongoFactory(
      cfg({ INFERENCE_MONGODB_URI: 'mongodb://x', INFERENCE_MONGODB_MAX_POOL_SIZE: 10 }),
    );
    expect(result.maxPoolSize).toBe(10);
  });

  it('throws when INFERENCE_MONGODB_URI is missing', () => {
    expect(() => mockCapture.mongoFactory(cfg({}))).toThrow(/INFERENCE_MONGODB_URI/);
  });

  it('throws when INFERENCE_MONGODB_URI is an empty string', () => {
    expect(() => mockCapture.mongoFactory(cfg({ INFERENCE_MONGODB_URI: '' }))).toThrow(
      /INFERENCE_MONGODB_URI/,
    );
  });
});
