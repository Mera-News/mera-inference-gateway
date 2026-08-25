import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { WebSearchRequestDto } from './web-search.dto';

async function check(payload: unknown) {
  return validate(plainToInstance(WebSearchRequestDto, payload), { whitelist: true });
}

describe('WebSearchRequestDto', () => {
  it('accepts a string query', async () => {
    await expect(check({ query: 'climate summit' })).resolves.toHaveLength(0);
  });

  it('accepts a queries array', async () => {
    await expect(check({ queries: ['a', 'b'] })).resolves.toHaveLength(0);
  });

  // An empty body is SCHEMA-valid and the controller rejects it. The
  // "exactly one of query/queries" rule cannot be written as a decorator
  // without a custom validator, and the answer has to be a sentence the caller
  // can act on rather than a constraint name.
  it('leaves an empty body to the controller', async () => {
    await expect(check({})).resolves.toHaveLength(0);
  });

  it.each([[42], [null], [[7]]])('rejects a non-string-array queries (%p)', async (value) => {
    const errors = await check({ queries: value });
    expect(errors).toHaveLength(1);
  });

  it(`rejects more than the batch ceiling`, async () => {
    const errors = await check({ queries: ['a', 'b', 'c', 'd', 'e'] });
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('arrayMaxSize');
  });

  it.each([[42], [null], [{ q: 'x' }], [['a']]])(
    'rejects a non-string query (%p)',
    async (value) => {
      const errors = await check({ query: value });
      expect(errors).toHaveLength(1);
    },
  );

  it('carries nothing but `query` — whitelisting strips anything else the client sends', async () => {
    const dto = plainToInstance(WebSearchRequestDto, {
      query: 'climate',
      userId: 'u1',
      facts: ['secret'],
    });

    // `whitelist: true` is what the global ValidationPipe applies; it deletes
    // every property the DTO does not declare, so no user identity or persona
    // data can ride along on this route even if a client sends it.
    await validate(dto, { whitelist: true });

    expect(Object.keys(dto).sort()).toEqual(['queries', 'query']);
    expect(dto.query).toBe('climate');
    expect(dto.queries).toBeUndefined();
  });
});
