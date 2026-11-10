jest.mock('./probe', () => ({ probeProfile: jest.fn() }));
import { probeProfile } from './probe';
import { ProbeProcessor } from './probe.processor';
import type { RoutingService } from './routing.service';

describe('ProbeProcessor', () => {
  const routing = { keyFor: jest.fn(), recordProbe: jest.fn() };
  const proc = () => new ProbeProcessor(routing as unknown as RoutingService);
  beforeEach(() => {
    jest.resetAllMocks();
    routing.keyFor.mockReturnValue('key');
  });

  it('hands the probe result for the job profile to recordProbe', async () => {
    (probeProfile as jest.Mock).mockResolvedValue(false);
    await proc().process({ data: { profile: 'near/qwen3.8-27b' } } as never);
    expect(probeProfile).toHaveBeenCalledWith('near/qwen3.8-27b', 'key');
    expect(routing.recordProbe).toHaveBeenCalledWith('near/qwen3.8-27b', false);
  });

  it('skips an unknown profile and a provider with no key', async () => {
    await proc().process({ data: { profile: 'x/y' } } as never);
    routing.keyFor.mockReturnValue('');
    await proc().process({ data: { profile: 'redpill/qwen3.8-27b' } } as never);
    expect(probeProfile).not.toHaveBeenCalled();
    expect(routing.recordProbe).not.toHaveBeenCalled();
  });
});
