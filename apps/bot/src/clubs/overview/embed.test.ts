import { describe, expect, it } from 'vitest';
import type { BotConfig } from '../../config';
import type { ClubRecord, ClubSummary } from '../types';
import {
  OVERVIEW_MAX_CLUBS,
  buildClubOverviewCustomId,
  buildClubOverviewEmbed,
  buildClubOverviewSelect,
  parseClubOverviewCustomId,
  sortOverviewSummaries,
} from './embed';

const GUILD_ID = '1488531664962326571';
const NOW = new Date('2026-11-20T08:44:00.000Z');

const CONFIG: Pick<
  BotConfig,
  'emojis' | 'playerProfileUrlTemplate' | 'clubProfileUrlTemplate'
> = {
  emojis: {
    trophies: undefined,
    trophyRange: undefined,
    president: undefined,
    requiredTrophies: undefined,
    members: undefined,
    matches: undefined,
    progression: undefined,
    description: undefined,
    ranked: undefined,
    rank: undefined,
    rankMythic: undefined,
    rankLegendary: undefined,
    rankMasters: undefined,
    rankPro: undefined,
    megaPig: undefined,
    wins: undefined,
    online: undefined,
  },
  playerProfileUrlTemplate: undefined,
  clubProfileUrlTemplate: undefined,
};

function club(index: number, trophies: number): ClubRecord {
  return {
    id: `club-${index}`,
    tag: `TAG${index}`,
    name: `Club ${index}`,
    description: '',
    trophies,
    requiredTrophies: 30000 + index,
    memberCount: 30,
    lastSyncedAt: '2026-11-20T08:20:00.000Z',
  };
}

function summary(index: number, trophies: number): ClubSummary {
  return {
    club: club(index, trophies),
    totalTrophies: trophies,
    averageTrophies: 100_000,
    memberCount: 30,
    latestSyncAt: '2026-11-20T08:20:00.000Z',
    leader: { name: `Leader ${index}`, tag: `LEAD${index}` },
    trophyRange: { low: 40_000, high: 160_000 },
    rankedRange: { low: 'DIAMOND I', high: 'MYTHIC II' },
    megaPigEstimate: null,
    activeMembers24h: 3,
  };
}

describe('club overview embed', () => {
  it('builds one inline field per club, sorted by trophies', () => {
    const embed = buildClubOverviewEmbed({
      summaries: [summary(1, 1000), summary(2, 3000)],
      guildLabel: 'Krew',
      now: NOW,
      config: CONFIG,
    });
    const data = embed.toJSON();

    expect(data.title).toBe('Overview from Krew | Club Stats');
    expect(data.fields).toHaveLength(2);
    expect(data.fields?.every((field) => field.inline === true)).toBe(true);
    expect(data.fields?.[0]?.name).toBe('Club 2 • #TAG2');
    expect(data.fields?.[0]?.value).toContain('3,000');
    expect(data.footer?.text).toContain('Updating every 30 minutes');
    expect(data.footer?.text).toContain('not exposed by the Brawl Stars API');
  });

  it('caps fields and select options at 25 and reports the remainder', () => {
    const summaries = Array.from({ length: 30 }, (_, index) => summary(index, 1000 + index));
    const embed = buildClubOverviewEmbed({
      summaries,
      guildLabel: null,
      now: NOW,
      config: CONFIG,
    });
    const data = embed.toJSON();

    expect(sortOverviewSummaries(summaries)[0]?.club.name).toBe('Club 29');
    expect(data.fields).toHaveLength(OVERVIEW_MAX_CLUBS);
    expect(data.footer?.text).toContain('Showing top 25 of 30 clubs');

    const select = buildClubOverviewSelect(summaries, GUILD_ID);
    expect(select?.components).toHaveLength(1);
    const menu = select?.components[0] as { custom_id: string; options: unknown[] };
    expect(menu.custom_id).toBe(buildClubOverviewCustomId(GUILD_ID));
    expect(menu.options).toHaveLength(OVERVIEW_MAX_CLUBS);
  });

  it('omits the select menu when there are no registered clubs', () => {
    expect(buildClubOverviewSelect([], GUILD_ID)).toBeNull();
  });

  it('round-trips the guild-scoped custom ID', () => {
    const customId = buildClubOverviewCustomId(GUILD_ID);
    expect(parseClubOverviewCustomId(customId)).toBe(GUILD_ID);
    expect(parseClubOverviewCustomId('clubs:page:2')).toBeNull();
    expect(parseClubOverviewCustomId('clubs:overview:')).toBeNull();
  });

  it('shows only enabled sections', () => {
    const embed = buildClubOverviewEmbed({
      summaries: [summary(1, 1000)],
      guildLabel: null,
      now: NOW,
      config: CONFIG,
      fields: ['clubTrophies'],
    });
    const data = embed.toJSON();

    expect(data.fields?.[0]?.value).toContain('1,000');
    expect(data.fields?.[0]?.value).not.toContain('Leader 1');
    expect(data.fields?.[0]?.value).not.toContain('active 24h');
  });

  it('preserves stored order when orderByTrophies is disabled', () => {
    const summaries = [summary(1, 1000), summary(2, 3000)];
    const embed = buildClubOverviewEmbed({
      summaries,
      guildLabel: null,
      now: NOW,
      config: CONFIG,
      fields: ['clubTrophies', 'members'],
    });
    const data = embed.toJSON();

    expect(data.fields?.[0]?.name).toBe('Club 1 • #TAG1');
    expect(sortOverviewSummaries(summaries, ['clubTrophies', 'members'])[0]?.club.name).toBe('Club 1');

    const select = buildClubOverviewSelect(summaries, GUILD_ID, ['clubTrophies', 'members']);
    const menu = select?.components[0] as { options: { label: string }[] };
    expect(menu.options[0]?.label).toContain('Club 1');
  });

  it('shows the server icon only when the field is enabled', () => {
    const base = {
      summaries: [summary(1, 1000)],
      guildLabel: null,
      now: NOW,
      config: CONFIG,
      guildIconUrl: 'https://example.com/icon.png',
    };

    const withIcon = buildClubOverviewEmbed({
      ...base,
      fields: ['serverIcon', 'clubTrophies'],
    }).toJSON();
    expect(withIcon.thumbnail?.url).toBe('https://example.com/icon.png');

    const withoutIcon = buildClubOverviewEmbed({
      ...base,
      fields: ['clubTrophies'],
    }).toJSON();
    expect(withoutIcon.thumbnail).toBeUndefined();
  });

  it('labels the stored Mega Pig value as an estimate', () => {
    const withMega = summary(1, 1000);
    const megaSummary = {
      ...withMega,
      megaPigEstimate: {
        matches: 4,
        wins: 3,
        trophyChange: 0,
        sampleSize: 4,
        windowStart: NOW.toISOString(),
        windowEnd: NOW.toISOString(),
      },
    };
    const embed = buildClubOverviewEmbed({
      summaries: [megaSummary],
      guildLabel: null,
      now: NOW,
      config: CONFIG,
      fields: ['megaPigEstimate'],
    }).toJSON();

    expect(embed.fields?.[0]?.value).toContain('3/4 (est.)');
  });
});
