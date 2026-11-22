import { describe, expect, it } from 'vitest';
import { buildClubLogEventEmbed, buildClubLogsConfigEmbed } from './embed';
import type { ClubLogConfig, ClubLogEvent } from './types';

const GUILD_ID = '123456789012345678';
const LOG: ClubLogConfig = {
  id: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd',
  guildId: GUILD_ID,
  clubId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
  clubTag: 'ALPHA',
  clubName: 'Alpha',
  channelId: '111111111111111222',
  periods: ['today'],
};

function event(overrides: Partial<ClubLogEvent> = {}): ClubLogEvent {
  return {
    kind: 'membership',
    id: 'e1',
    clubId: LOG.clubId,
    playerTag: 'PLAYER',
    playerName: 'Player',
    description: '#PLAYER joined #ALPHA',
    detectedAt: '2026-11-20T12:00:00.000Z',
    ...overrides,
  };
}

/** Compare the information in a value without depending on markdown wrappers. */
function plain(value: string | undefined | null): string {
  return (value ?? '').replace(/\*\*/g, '').replace(/`/g, '');
}

function contentLength(json: {
  title?: string;
  description?: string;
  fields?: readonly { name: string; value: string }[];
  footer?: { text: string };
}): number {
  return (
    (json.title?.length ?? 0) +
    (json.description?.length ?? 0) +
    (json.footer?.text.length ?? 0) +
    (json.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

describe('buildClubLogsConfigEmbed', () => {
  it('lists this guild’s logs with club tags and channel mentions', () => {
    const embed = buildClubLogsConfigEmbed({
      guildId: GUILD_ID,
      logs: [
        LOG,
        {
          ...LOG,
          id: 'log-2',
          clubTag: 'BRAVO',
          clubName: 'Bravo',
          channelId: '333',
          periods: ['week', 'season'],
        },
      ],
      notice: 'Club log configured.',
    });
    const json = embed.toJSON();

    expect(plain(json.description)).toContain(GUILD_ID);
    expect(json.fields?.map((field) => plain(field.value))).toEqual([
      'Club log configured.',
      '<#111111111111111222> • Today',
      '<#333> • This Week, This Season',
    ]);
    expect(json.fields?.map((field) => field.name)).toEqual([
      'Update',
      'Alpha (#ALPHA)',
      'Bravo (#BRAVO)',
    ]);
    expect(contentLength(json as never)).toBeLessThanOrEqual(6000);
  });

  it('states when a guild has no logs', () => {
    const json = buildClubLogsConfigEmbed({ guildId: GUILD_ID, logs: [] }).toJSON();
    expect(json.description).toContain('No club logs');
    expect(json.description).toContain(GUILD_ID);
  });
});

describe('buildClubLogEventEmbed', () => {
  it('renders stored events with timestamps and the stored-history footer', () => {
    const embed = buildClubLogEventEmbed({
      log: LOG,
      events: [
        event(),
        event({
          kind: 'role',
          id: 'e2',
          description: 'Player (64,809 🏆) was demoted to Member.',
          detectedAt: '2026-11-20T12:05:00.000Z',
        }),
        event({
          kind: 'capacity',
          id: 'e3',
          playerTag: null,
          description: 'Club full (30/30)',
          detectedAt: '2026-11-20T12:10:00.000Z',
        }),
      ],
      now: new Date('2026-11-20T12:15:00.000Z'),
    });
    const json = embed.toJSON();

    expect(json.title).toBe('#ALPHA club log');
    expect(json.footer?.text).toBe('From stored BrawlHub sync history • not live');
    expect(json.fields).toHaveLength(3);
    expect(json.fields?.map((field) => field.name)).toEqual([
      expect.stringContaining('Membership'),
      expect.stringContaining('Role updated'),
      expect.stringContaining('Capacity'),
    ]);
    expect(json.fields?.[1]?.value).toContain('Player (64,809 🏆) was demoted to Member.');
    const expectedTimestamp = `<t:${Math.floor(Date.parse('2026-11-20T12:05:00.000Z') / 1000)}:f>`;
    expect(json.fields?.[1]?.value).toContain(expectedTimestamp);
  });

  it('truncates long and numerous events within Discord limits', () => {
    const events = Array.from({ length: 30 }, (_, index) =>
      event({ id: `e${index}`, description: 'X'.repeat(4000), detectedAt: `2026-11-20T12:${String(index % 60).padStart(2, '0')}:00.000Z` }),
    );
    const json = buildClubLogEventEmbed({
      log: LOG,
      events,
      now: new Date('2026-11-20T12:30:00.000Z'),
    }).toJSON();

    expect(json.fields).toHaveLength(25);
    for (const field of json.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(contentLength(json as never)).toBeLessThanOrEqual(6000);
  });
});
