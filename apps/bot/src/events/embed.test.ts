import { describe, expect, it } from 'vitest';
import { buildEventPageEmbed, paginateEvents } from './embed';
import type { EventSlotView, EventView } from './types';

const slot: EventSlotView = {
  slotId: 1,
  modeLabel: 'Brawl Ball',
  rawMode: 'brawlBall',
  mapName: 'Pinhole Punt',
  eventId: 15000026,
  startAt: '2026-11-19T08:00:00.000Z',
  endAt: '2026-11-19T20:00:00.000Z',
  mapImageUrl: 'https://cdn.example.test/maps/15000026.png',
  modeImageUrl: 'https://cdn.example.test/modes/48000005.png',
  modeColor: '#9ab1fd',
};

function view(overrides: Partial<EventView> = {}): EventView {
  return {
    kind: 'active',
    slots: [slot],
    fetchedAt: '2026-11-19T12:00:00.000Z',
    apiIssue: null,
    ...overrides,
  };
}

describe('buildEventPageEmbed', () => {
  it('shows one detailed event with official data and static images', () => {
    const eventView = view();
    const embed = buildEventPageEmbed(eventView, paginateEvents(eventView, 1)).toJSON();

    expect(embed.title).toBe('Active Events');
    expect(embed.image?.url).toBe(slot.mapImageUrl);
    expect(embed.thumbnail?.url).toBe(slot.modeImageUrl);
    const fields = embed.fields ?? [];
    expect(fields).toContainEqual({ name: 'Game Mode', value: 'Brawl Ball', inline: true });
    expect(fields).toContainEqual({ name: 'Map', value: 'Pinhole Punt', inline: true });
    expect(fields.some((field) => field.name === 'Starts' && field.value.includes('<t:'))).toBe(true);
    expect(fields.some((field) => field.value.includes('win-rate'))).toBe(true);
    expect(JSON.stringify(embed).length).toBeLessThan(6000);
  });

  it('explains an empty result instead of inventing events', () => {
    const embed = buildEventPageEmbed(view({ slots: [] }), paginateEvents(view({ slots: [] }), 1)).toJSON();
    expect(embed.description).toContain('no active events');
  });

  it('reports an official API outage clearly', () => {
    const failed = view({ slots: [], apiIssue: 'unavailable' });
    const embed = buildEventPageEmbed(failed, paginateEvents(failed, 1)).toJSON();
    expect(embed.description).toContain('official Brawl Stars API could not be reached');
  });

  it('handles missing static assets without failing', () => {
    const plain: EventSlotView = {
      ...slot,
      mapImageUrl: null,
      modeImageUrl: null,
      modeColor: null,
    };
    const eventView = view({ kind: 'upcoming', slots: [plain] });
    const embed = buildEventPageEmbed(eventView, paginateEvents(eventView, 1)).toJSON();
    expect(embed.title).toBe('Upcoming Events');
    expect(embed.image).toBeUndefined();
    expect(embed.thumbnail).toBeUndefined();
    expect(embed.fields?.some((field) => field.name === 'Map')).toBe(true);
  });
});
