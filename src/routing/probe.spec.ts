import { probeProfile } from './probe';

describe('probeProfile', () => {
  const originalFetch = global.fetch;
  const fetchMock = jest.fn();
  beforeEach(() => {
    global.fetch = fetchMock;
    fetchMock.mockReset();
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  const ok = (body: string) => ({
    ok: true,
    text: async () => body,
    json: async () => JSON.parse(body),
  });

  it('passes when attestation and an 8-token completion both answer, with a fixed prompt', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/attestation/') ? ok('{"a":1}') : ok('{"choices":[{"message":{}}]}'),
    );
    expect(await probeProfile('redpill/qwen3.8-27b', 'k')).toBe(true);
    const urls = fetchMock.mock.calls.map((c) => c[0] as string);
    expect(urls).toContain('https://tee.redpill.ai/v1/attestation/report?model=qwen%2Fqwen3.8-27b');
    const post = fetchMock.mock.calls.find((c) => c[1]?.method === 'POST')!;
    expect(post[0]).toBe('https://tee.redpill.ai/v1/chat/completions');
    const sent = JSON.parse(post[1].body);
    expect(sent).toMatchObject({ model: 'qwen/qwen3.8-27b', max_tokens: 8, stream: false });
    expect(sent.messages).toHaveLength(1);
    expect(post[1].headers.Authorization).toBe('Bearer k');
  });

  it('fails on an upstream 5xx, an empty attestation, no choices, or a throw', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/attestation/') ? ok('{"a":1}') : { ok: false },
    );
    expect(await probeProfile('near/qwen3.8-27b', 'k')).toBe(false);

    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/attestation/') ? ok('') : ok('{"choices":[{}]}'),
    );
    expect(await probeProfile('near/qwen3.8-27b', 'k')).toBe(false);

    fetchMock.mockImplementation(async (url: string) =>
      url.includes('/attestation/') ? ok('{"a":1}') : ok('{"choices":[]}'),
    );
    expect(await probeProfile('near/qwen3.8-27b', 'k')).toBe(false);

    fetchMock.mockRejectedValue(new Error('timeout'));
    expect(await probeProfile('near/qwen3.8-27b', 'k')).toBe(false);
  });
});
