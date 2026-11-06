import { HttpException } from '@nestjs/common';
import { ComposeFileRelay } from './compose-file';

const COMMIT = 'a'.repeat(40);
const FILE = 'prod/small-models.yaml';

function statusOf(work: Promise<unknown>): Promise<number> {
  return work.then(
    () => 0,
    (error: HttpException) => error.getStatus(),
  );
}

describe('ComposeFileRelay', () => {
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(global, 'fetch').mockImplementation(async () => new Response('a: 1\n'));
  });

  afterEach(() => jest.restoreAllMocks());

  it('fetches only the pinned repo at the exact commit and refuses redirects', async () => {
    const body = await new ComposeFileRelay().fetchFile(COMMIT, FILE);

    expect(body.toString()).toBe('a: 1\n');
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(`https://raw.githubusercontent.com/nearai/cvm-compose-files/${COMMIT}/${FILE}`);
    expect(init.redirect).toBe('error');
  });

  it('returns the bytes untouched', async () => {
    const bytes = Buffer.from('café: न\n');
    fetchMock.mockResolvedValue(new Response(bytes));

    expect((await new ComposeFileRelay().fetchFile(COMMIT, FILE)).equals(bytes)).toBe(true);
  });

  it.each([
    ['short commit', 'abc', FILE],
    ['uppercase commit', 'A'.repeat(40), FILE],
    ['outside prod', COMMIT, 'experiments/a.yaml'],
    ['path traversal', COMMIT, 'prod/../secret.yaml'],
    ['not yaml', COMMIT, 'prod/a.sh'],
    ['repeated parameter', [COMMIT, COMMIT], FILE],
    ['missing file', COMMIT, undefined],
  ])('answers 400 with no upstream call for %s', async (_name, commit, file) => {
    expect(await statusOf(new ComposeFileRelay().fetchFile(commit, file))).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('serves a commit from memory after the first fetch', async () => {
    const relay = new ComposeFileRelay();
    await relay.fetchFile(COMMIT, FILE);
    await relay.fetchFile(COMMIT, FILE);

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('evicts the oldest file past its bound', async () => {
    const relay = new ComposeFileRelay();
    for (let i = 0; i < 9; i += 1) await relay.fetchFile(COMMIT, `prod/${i}.yaml`);
    await relay.fetchFile(COMMIT, 'prod/8.yaml');
    expect(fetchMock).toHaveBeenCalledTimes(9);

    await relay.fetchFile(COMMIT, 'prod/0.yaml');
    expect(fetchMock).toHaveBeenCalledTimes(10);
  });

  it('answers 502 and caches nothing when upstream refuses', async () => {
    const relay = new ComposeFileRelay();
    fetchMock.mockResolvedValueOnce(new Response('secret upstream text', { status: 404 }));
    expect(await statusOf(relay.fetchFile(COMMIT, FILE))).toBe(502);

    await relay.fetchFile(COMMIT, FILE);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('answers 502 when upstream cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));
    expect(await statusOf(new ComposeFileRelay().fetchFile(COMMIT, FILE))).toBe(502);
  });

  it('refuses a body over 1 MB, declared or not', async () => {
    const big = Buffer.alloc(1024 * 1024 + 1);
    fetchMock.mockResolvedValueOnce(
      new Response('x', { headers: { 'content-length': String(big.length) } }),
    );
    expect(await statusOf(new ComposeFileRelay().fetchFile(COMMIT, FILE))).toBe(502);

    fetchMock.mockResolvedValueOnce(new Response(big));
    expect(await statusOf(new ComposeFileRelay().fetchFile(COMMIT, FILE))).toBe(502);
  });

  it('never answers 429 when the instance cap is reached, and cached files stay served', async () => {
    const relay = new ComposeFileRelay();
    await relay.fetchFile(COMMIT, FILE);
    for (let i = 0; i < 59; i += 1) await relay.fetchFile(COMMIT, `prod/n${i}.yaml`);
    expect(await statusOf(relay.fetchFile(COMMIT, 'prod/over.yaml'))).toBe(503);
    expect(fetchMock).toHaveBeenCalledTimes(60);

    expect((await relay.fetchFile(COMMIT, 'prod/n58.yaml')).toString()).toBe('a: 1\n');
  });
});
