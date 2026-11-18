import { describe, expect, it } from 'vitest';
import { paginate } from '../discord/pagination';
import { buildClubsPageEmbed, buildClubEmbed, CLUB_MEMBER_CAPACITY } from './embed';
import type { BotConfig } from '../config';
import type { ClubSummary, ClubView } from './types';

const CONFIG: Pick<BotConfig, 'emojis' | 'playerProfileUrlTemplate' | 'seasonStartIso'> = {
  emojis: {
    trophies: undefined,
    trophyRange: undefined,
    president: undefined,
    requiredTrophies: undefined,
    members: undefined,
    matches: undefined,
    progression: undefined,
    description: undefined,
  },
  playerProfileUrlTemplate: 'https://brawlify.com/player/{tag}',
  seasonStartIso: '2026-11-02T00:00:00Z',
};

const NOW = new Date('2026-11-18T12:00:00.000Z');

function view(overrides: Partial<ClubView> = {}): ClubView {
  return {
    club: {
      id: 'club-1',
      tag: '2C0Y',
      name: 'Alpha',
      description: 'Club description',
      trophies: 1000,
      requiredTrophies: 500,
      memberCount: 30,
      lastSyncedAt: null,
    },
    roster: [
      { tag: 'G2P9', name: 'Leader', trophies: 900, role: 'president' },
      { tag: 'Q8VR', name: 'Senior', trophies: 700, role: 'senior' },
      { tag: '2C0Y', name: 'Vice', trophies: 600, role: 'vicePresident' },
    ],
    rosterAvailable: true,
    rosterSource: 'live',
    snapshots: [
      {
        id: 's1',
        syncRunId: 'r1',
        capturedAt: '2026-11-01T23:59:00.000Z',
        trophies: 1000,
        memberCount: 30,
        raw: null,
      },
      {
        id: 's2',
        syncRunId: 'r2',
        capturedAt: '2026-11-16T00:00:00.000Z',
        trophies: 1100,
        memberCount: 30,
        raw: null,
      },
      {
        id: 's3',
        syncRunId: 'r3',
        capturedAt: '2026-11-18T00:00:00.000Z',
        trophies: 1200,
        memberCount: 30,
        raw: null,
      },
    ],
    currentTrophies: 1300,
    currentAt: NOW.toISOString(),
    description: 'Club description',
    requiredTrophies: 500,
    latestSyncAt: '2026-11-17T10:00:00.000Z',
    liveStatus: 'live',
    apiIssue: null,
    ...overrides,
  };
}

function summary(index: number): ClubSummary {
  return {
    club: {
      id: `club-${index}`,
      tag: `TAG${index}`,
      name: `Club ${index}`,
      description: null,
      trophies: 1000 + index,
      requiredTrophies: null,
      memberCount: 20,
      lastSyncedAt: null,
    },
    totalTrophies: 1000 + index,
    averageTrophies: 50 + index,
    memberCount: 20,
    latestSyncAt: '2026-11-17T10:00:00.000Z',
  };
}

describe('club embeds', () => {
  it('renders supported sections in the required order', () => {
    const json = buildClubEmbed(view(), CONFIG, NOW).toJSON();
    const names = (json.fields ?? []).map((field) => field.name);

    expect(names).toEqual([
      'Trophies',
      'Trophy Range',
      'President',
      'Required Trophies',
      'Members',
      'Trophy Progression',
      'Description',
    ]);
    expect(json.title).toBe('Alpha • #2C0Y');
    expect(json.fields?.[0]?.value).toContain('Total: 1,300');
    expect(json.fields?.[0]?.value).toContain('Average: 733');
    expect(json.fields?.[2]?.value).toBe('[Leader](https://brawlify.com/player/G2P9)');
    expect(json.fields?.[4]?.value).toContain(`Current: 3 / ${CLUB_MEMBER_CAPACITY}`);
    expect(json.fields?.[4]?.value).toContain('Vice-Presidents: 1');
    expect(json.fields?.[4]?.value).toContain('Seniors: 1');
    expect(json.fields?.[5]?.value).toContain('Today: +100');
    expect(json.fields?.[5]?.value).toContain('Week: +200');
    expect(json.fields?.[5]?.value).toContain('Season: +300');
  });

  it('omits unsupported and unavailable fields instead of showing placeholders', () => {
    const empty = view({
      roster: [],
      rosterAvailable: false,
      snapshots: [],
      currentTrophies: null,
      currentAt: '',
      description: null,
      requiredTrophies: null,
      latestSyncAt: null,
    });
    const json = buildClubEmbed(empty, CONFIG, NOW).toJSON();
    const text = JSON.stringify(json);

    expect(json.fields ?? []).toHaveLength(0);
    expect(text).not.toContain('Unavailable');
    expect(text).not.toContain('Average Matches Played');
    expect(text).not.toContain('Mega Pig');
    expect(text).not.toContain('Type');
  });

  it('keeps long descriptions and titles inside Discord embed limits', () => {
    const long = view({
      club: { ...view().club, name: 'A'.repeat(400) },
      description: 'D'.repeat(5000),
    });
    const json = buildClubEmbed(long, CONFIG, NOW).toJSON();

    expect(json.title?.length).toBeLessThanOrEqual(256);
    for (const field of json.fields ?? []) {
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect(JSON.stringify(json).length).toBeLessThan(6000);
    expect(JSON.stringify(json)).not.toContain('Unavailable');
  });

  it('renders a bounded page of registered clubs with sync timestamps', () => {
    const summaries = Array.from({ length: 12 }, (_, index) => summary(index + 1));
    const page = paginate(summaries, 2, 5);
    const json = buildClubsPageEmbed(summaries, page).toJSON();

    expect(json.fields).toHaveLength(5);
    expect(json.fields?.[0]?.name).toContain('#TAG6');
    expect(json.fields?.[0]?.value).toContain('Total: 1,006');
    expect(json.fields?.[0]?.value).toContain('Average: 56');
    expect(json.fields?.[0]?.value).toContain('Members: 20 / 30');
    const syncSeconds = Math.floor(Date.parse('2026-11-17T10:00:00.000Z') / 1000);
    expect(json.fields?.[0]?.value).toContain(`Last sync: <t:${syncSeconds}:R>`);
    expect(json.footer?.text).toContain('Page 2 / 3');
  });
});
