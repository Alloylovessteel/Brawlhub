import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./me-utils.js', () => ({
  resolveMeTag: vi.fn(),
  meTagErrorMessage: vi.fn(() => 'verification error'),
}));

vi.mock('../images/chart-service.js', () => ({
  loadOrRenderChart: vi.fn(),
  chartFailureMessage: vi.fn(() => 'chart unavailable'),
}));

import { loadOrRenderChart } from '../images/chart-service.js';
import { resolveMeTag } from './me-utils.js';
import { handleMeChart } from './me-chart.js';

function interaction(overrides: Record<string, unknown> = {}) {
  return {
    guildId: 'guild-1',
    channelId: 'channel-1',
    user: { id: 'user-1' },
    options: {
      getString: vi.fn((name: string) => (name === 'period' ? null : null)),
    },
    deferReply: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    replied: false,
    deferred: true,
    ...overrides,
  };
}

describe('handleMeChart', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveMeTag).mockResolvedValue({ kind: 'ok', tag: 'PLAYER1' } as never);
    vi.mocked(loadOrRenderChart).mockResolvedValue({
      kind: 'ok',
      image: {
        png: Buffer.from('png'),
        fileName: 'chart.png',
        width: 1200,
        height: 700,
      },
    } as never);
  });

  it('posts a public PNG attachment with mentions disabled and no components', async () => {
    const mock = interaction();
    await handleMeChart(mock as never, 'trophies');

    expect(mock.deferReply).toHaveBeenCalledWith();
    const payload = (mock.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload.files).toHaveLength(1);
    expect(payload.components).toEqual([]);
    expect(payload.allowedMentions).toEqual({ parse: [] });
    expect(payload.flags).toBeUndefined();
    expect(loadOrRenderChart).toHaveBeenCalledWith(
      expect.objectContaining({
        guildId: 'guild-1',
        kind: 'player',
        tag: 'PLAYER1',
        option: 'trophies',
        period: '30d',
      }),
    );
  });

  it('shows an explicit failure when the chart cannot be built', async () => {
    vi.mocked(loadOrRenderChart).mockResolvedValue({
      kind: 'failure',
      failure: { kind: 'not-found', tag: 'PLAYER1' },
    } as never);
    const mock = interaction();
    await handleMeChart(mock as never, 'trophies');

    const payload = (mock.editReply as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    expect(payload.content).toBe('chart unavailable');
    expect(payload.files).toBeUndefined();
  });
});
