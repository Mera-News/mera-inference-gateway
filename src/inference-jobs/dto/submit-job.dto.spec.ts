import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate, ValidationError } from 'class-validator';
import { MAX_REQUESTS_PER_JOB, MAX_SHARED_SYSTEM_BYTES, SubmitJobDto } from './submit-job.dto';

/** Recursively collect every constraint key from a ValidationError tree. */
function collectConstraints(errors: ValidationError[]): string[] {
  const keys: string[] = [];
  for (const e of errors) {
    if (e.constraints) {
      keys.push(...Object.keys(e.constraints));
    }
    if (e.children && e.children.length > 0) {
      keys.push(...collectConstraints(e.children));
    }
  }
  return keys;
}

async function check(payload: unknown): Promise<ValidationError[]> {
  return validate(plainToInstance(SubmitJobDto, payload));
}

describe('SubmitJobDto', () => {
  describe('exported constants', () => {
    it('MAX_REQUESTS_PER_JOB equals 5000', () => {
      expect(MAX_REQUESTS_PER_JOB).toBe(5000);
    });

    it('MAX_SHARED_SYSTEM_BYTES equals 65536', () => {
      expect(MAX_SHARED_SYSTEM_BYTES).toBe(65536);
    });
  });

  describe('requests array', () => {
    it('valid minimal payload produces no errors', async () => {
      const errors = await check({ requests: [{ id: 'a', body: {} }] });
      expect(errors).toHaveLength(0);
    });

    it('empty requests array fails arrayMinSize', async () => {
      const errors = await check({ requests: [] });
      const constraints = collectConstraints(errors);
      expect(constraints).toContain('arrayMinSize');
    });

    it('requests with 5001 items fails arrayMaxSize', async () => {
      const errors = await check({
        requests: Array.from({ length: 5001 }, () => ({ id: 'x', body: {} })),
      });
      const constraints = collectConstraints(errors);
      expect(constraints).toContain('arrayMaxSize');
    });
  });

  describe('expoPushToken', () => {
    it('accepts a valid ExponentPushToken[…] value', async () => {
      const errors = await check({
        requests: [{ id: 'a', body: {} }],
        expoPushToken: 'ExponentPushToken[abc]',
      });
      expect(errors).toHaveLength(0);
    });

    it('accepts a valid ExpoPushToken[…] value', async () => {
      const errors = await check({
        requests: [{ id: 'a', body: {} }],
        expoPushToken: 'ExpoPushToken[abc]',
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a garbage token value with matches constraint', async () => {
      const errors = await check({
        requests: [{ id: 'a', body: {} }],
        expoPushToken: 'garbage',
      });
      const constraints = collectConstraints(errors);
      expect(constraints).toContain('matches');
    });

    it('is valid when absent', async () => {
      const errors = await check({ requests: [{ id: 'a', body: {} }] });
      expect(errors).toHaveLength(0);
    });
  });

  describe('sharedSystem', () => {
    it('accepts a string of exactly MAX_SHARED_SYSTEM_BYTES length', async () => {
      const errors = await check({
        requests: [{ id: 'a', body: {} }],
        sharedSystem: 'x'.repeat(MAX_SHARED_SYSTEM_BYTES),
      });
      expect(errors).toHaveLength(0);
    });

    it('rejects a string one byte over MAX_SHARED_SYSTEM_BYTES with maxLength', async () => {
      const errors = await check({
        requests: [{ id: 'a', body: {} }],
        sharedSystem: 'x'.repeat(MAX_SHARED_SYSTEM_BYTES + 1),
      });
      const constraints = collectConstraints(errors);
      expect(constraints).toContain('maxLength');
    });
  });

  describe('nested InferenceRequestDto', () => {
    it('request missing id produces a nested error', async () => {
      const errors = await check({ requests: [{ body: {} }] });
      expect(collectConstraints(errors).length).toBeGreaterThan(0);
    });

    it('request missing body fails isDefined', async () => {
      const errors = await check({ requests: [{ id: 'a' }] });
      const constraints = collectConstraints(errors);
      expect(constraints).toContain('isDefined');
    });
  });

  describe('e2eeSession', () => {
    it('a non-object value fails isObject', async () => {
      const errors = await check({
        requests: [{ id: 'a', body: {} }],
        e2eeSession: 'notanobject',
      });
      const constraints = collectConstraints(errors);
      expect(constraints).toContain('isObject');
    });

    it('a valid object with X-Signing-Algo produces no errors', async () => {
      const errors = await check({
        requests: [{ id: 'a', body: {} }],
        e2eeSession: { 'X-Signing-Algo': 'ed' },
      });
      expect(errors).toHaveLength(0);
    });
  });
});
