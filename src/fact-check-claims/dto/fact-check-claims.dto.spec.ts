import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { FactCheckClaimsRequestDto } from './fact-check-claims.dto';

async function check(payload: unknown) {
  return validate(plainToInstance(FactCheckClaimsRequestDto, payload), { whitelist: true });
}

describe('FactCheckClaimsRequestDto', () => {
  it('accepts a bare query', async () => {
    await expect(check({ query: 'vaccines cause autism' })).resolves.toHaveLength(0);
  });

  it('rejects a missing query', async () => {
    const errors = await check({});
    expect(errors).toHaveLength(1);
    expect(Object.keys(errors[0].constraints ?? {})).toContain('isString');
  });

  it.each([[42], [null], [{ q: 'x' }], [['a']]])(
    'rejects a non-string query (%p)',
    async (value) => {
      await expect(check({ query: value })).resolves.toHaveLength(1);
    },
  );

  // An ABSENT languageCode is a first-class request, not a defaulted one: the
  // app retries an empty locale-scoped lookup with it unset, because the
  // ClaimReview corpus skews heavily English.
  it('accepts an absent languageCode', async () => {
    await expect(check({ query: 'a claim' })).resolves.toHaveLength(0);
  });

  it.each(['en', 'hi', 'pt-BR', 'zh-CN', 'fil'])('accepts languageCode %p', async (code) => {
    await expect(check({ query: 'a claim', languageCode: code })).resolves.toHaveLength(0);
  });

  it.each(['e', 'english-language-name', '../../etc', 'en_US', '<script>'])(
    'rejects a malformed languageCode (%p)',
    async (code) => {
      await expect(check({ query: 'a claim', languageCode: code })).resolves.toHaveLength(1);
    },
  );

  it('coerces a numeric-string maxAgeDays, because the global pipe transforms', async () => {
    const dto = plainToInstance(FactCheckClaimsRequestDto, { query: 'a claim', maxAgeDays: '30' });
    await expect(validate(dto, { whitelist: true })).resolves.toHaveLength(0);
    expect(dto.maxAgeDays).toBe(30);
  });

  it.each([0, -1, 4000, 1.5, 'soon'])('rejects an out-of-range maxAgeDays (%p)', async (value) => {
    await expect(check({ query: 'a claim', maxAgeDays: value })).resolves.toHaveLength(1);
  });

  it('carries nothing but the three declared fields — whitelisting strips the rest', async () => {
    const dto = plainToInstance(FactCheckClaimsRequestDto, {
      query: 'a claim',
      languageCode: 'en',
      userId: 'u1',
      articleId: 'a1',
      facts: ['secret'],
    });

    // `whitelist: true` is what the global ValidationPipe applies. It is the
    // mechanism that stops an article id or a user id riding along on a route
    // whose entire privacy claim is "the index sees the claim and nothing else".
    await validate(dto, { whitelist: true });

    // `maxAgeDays` is materialised (as undefined) by @Type even when absent —
    // what matters is that nothing UNDECLARED survives.
    expect(Object.keys(dto).sort()).toEqual(['languageCode', 'maxAgeDays', 'query']);
    expect(dto).not.toHaveProperty('userId');
    expect(dto).not.toHaveProperty('articleId');
    expect(dto).not.toHaveProperty('facts');
  });
});
