import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ButtonInteraction, ChatInputCommandInteraction } from 'discord.js';
import type { EventKind, EventSlotView, EventView } from '../events/types';

const mocks = vi.hoisted(() => ({ loadEventView: vi.fn() }));
vi.mock('../events/service', () => ({ loadEventView: mocks.loadEventView }));

import { eventsCommandData, handleEvents, handleEventsComponent } from './events';

function makeSlot(index: number): EventSlotView {
  return {
    slotId: index,
    modeLabel: 'Brawl Ball',
    rawMode: 'brawlBall',
    mapName: `Map ${index}`,
    eventId: 15000026,
    startAt: '2026-11-19T08:00:00.000Z',
    endAt: '2026-11-19T20:00:00.000Z',
    mapImageUrl: null,
    modeImageUrl: null,
    modeColor: null,
  };
}

function makeView(kind: EventKind, count = 1): EventView {
  return {
    kind,
    slots: Array.from({ length: count }, (_, index) => makeSlot(index + 1)),
    fetchedAt: '2026-11-19T12:00:00.000Z',
    apiIssue: null,
  };
}

function chat(subcommand: string): ChatInputCommandInteraction {
  const interaction = {
    replied: false,
    deferred: false,
    options: { getSubcommand: vi.fn(() => subcommand) },
    deferReply: vi.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ChatInputCommandInteraction;
}

function button(customId: string): ButtonInteraction {
  const interaction = {
    customId,
    replied: false,
    deferred: false,
    deferUpdate: vi.fn(async () => undefined),
    editReply: vi.fn(async () => undefined),
    reply: vi.fn(async () => undefined),
    followUp: vi.fn(async () => undefined),
  };
  return interaction as unknown as ButtonInteraction;
}

function payload(
  interaction: ChatInputCommandInteraction | ButtonInteraction,
  method: 'reply' | 'editReply' | 'followUp',
): any {
  return (interaction[method] as ReturnType<typeof vi.fn>).mock.calls[0]?.[0] as any;
}

beforeEach(() => {
  mocks.loadEventView.mockReset();
  mocks.loadEventView.mockImplementation(async (kind: EventKind) => makeView(kind, 2));
});

describe('/events', () => {
  it('registers active and upcoming subcommands', () => {
    const json = eventsCommandData.toJSON();
    expect(json.name).toBe('events');
    expect(json.options?.map((option: any) => option.name)).toEqual(['active', 'upcoming']);
  });

  it('defers and shows the active rotation by default', async () => {
    const interaction = chat('active');

    await handleEvents(interaction);

    expect(interaction.deferReply).toHaveBeenCalledOnce();
    expect(mocks.loadEventView).toHaveBeenCalledWith('active');
    const edit = payload(interaction, 'editReply');
    expect(edit.embeds).toHaveLength(1);
    expect(edit.embeds[0].toJSON().title).toBe('Active Events');
    expect(edit.allowedMentions).toEqual({ parse: [] });
    expect(edit.components[0].components[0].data.custom_id).toBe('events:page:2:active');
  });

  it('loads the upcoming rotation when requested', async () => {
    const interaction = chat('upcoming');

    await handleEvents(interaction);

    expect(mocks.loadEventView).toHaveBeenCalledWith('upcoming');
    expect(payload(interaction, 'editReply').embeds[0].toJSON().title).toBe('Upcoming Events');
  });

  it('renders a later page while preserving the event kind', async () => {
    const interaction = button('events:page:2:upcoming');

    await handleEventsComponent(interaction);

    expect(interaction.deferUpdate).toHaveBeenCalledOnce();
    expect(mocks.loadEventView).toHaveBeenCalledWith('upcoming');
    const edit = payload(interaction, 'editReply');
    expect(edit.content).toBeNull();
    expect(edit.embeds[0].toJSON().footer.text).toContain('Page 2 / 2');
  });

  it('ignores unrelated component IDs', async () => {
    const interaction = button('help:page:2');

    await handleEventsComponent(interaction);

    expect(interaction.deferUpdate).not.toHaveBeenCalled();
    expect(mocks.loadEventView).not.toHaveBeenCalled();
  });
});
