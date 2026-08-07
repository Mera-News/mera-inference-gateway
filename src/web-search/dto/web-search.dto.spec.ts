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

  it('rejects a missing query', async () => {
    const errors = await check({});
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('isString');
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

    expect(Object.keys(dto)).toEqual(['query']);
    expect(dto.query).toBe('climate');
  });
});
