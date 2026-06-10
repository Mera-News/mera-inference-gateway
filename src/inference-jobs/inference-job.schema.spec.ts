import { InferenceJobSchema } from './inference-job.schema';

/** The mongoose SchemaType surface we introspect (typed loosely on purpose —
 *  mongoose's public types don't expose `defaultValue`/`enumValues`). */
interface IntrospectablePath {
  defaultValue?: unknown;
  enumValues?: string[];
  instance?: string;
  options: Record<string, unknown>;
  getDefault?: () => unknown[];
}

const pathOf = (name: string): IntrospectablePath =>
  InferenceJobSchema.path(name) as unknown as IntrospectablePath;

describe('InferenceJobSchema', () => {
  describe('status path', () => {
    it('has defaultValue === "pending"', () => {
      expect(pathOf('status').defaultValue).toBe('pending');
    });

    it('enum includes all four job statuses', () => {
      const path = pathOf('status');
      const enumValues: string[] =
        path.enumValues ?? (path.options.enum as string[] | undefined) ?? [];
      expect(enumValues).toContain('pending');
      expect(enumValues).toContain('processing');
      expect(enumValues).toContain('completed');
      expect(enumValues).toContain('failed');
    });
  });

  describe('expiresAt path', () => {
    it('has TTL index { expireAfterSeconds: 0 }', () => {
      expect(pathOf('expiresAt').options.index).toEqual({ expireAfterSeconds: 0 });
    });
  });

  describe('userId path', () => {
    it('has index === true', () => {
      expect(pathOf('userId').options.index).toBe(true);
    });
  });

  describe('nullable fields default to null', () => {
    it('expoPushToken defaults to null', () => {
      expect(pathOf('expoPushToken').defaultValue).toBeNull();
    });

    it('sharedSystem defaults to null', () => {
      expect(pathOf('sharedSystem').defaultValue).toBeNull();
    });

    it('completedAt defaults to null', () => {
      expect(pathOf('completedAt').defaultValue).toBeNull();
    });

    it('e2eeSession defaults to null', () => {
      expect(pathOf('e2eeSession').defaultValue).toBeNull();
    });
  });

  describe('array paths', () => {
    it('requests path exists and getDefault() returns []', () => {
      const path = pathOf('requests');
      expect(path).toBeDefined();
      if (typeof path.getDefault === 'function') {
        expect(path.getDefault()).toEqual([]);
      } else {
        expect(path.instance).toMatch(/Array/i);
      }
    });

    it('results path exists and getDefault() returns []', () => {
      const path = pathOf('results');
      expect(path).toBeDefined();
      if (typeof path.getDefault === 'function') {
        expect(path.getDefault()).toEqual([]);
      } else {
        expect(path.instance).toMatch(/Array/i);
      }
    });
  });
});
