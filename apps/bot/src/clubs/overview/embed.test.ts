import { describe, expect, it } from 'vitest';
import type { BotConfig } from '../../config';
import type { ClubRecord, ClubSummary } from '../types';
import {
  OVERVIEW_ALL_CLUBS_LIMIT,
  OVERVIEW_FIELDS_PER_EMBED,
  OVERVIEW_MAX_CLUBS,
  OVERVIEW_MAX_EMBEDS,
  OVERVIEW_MAX_SELECTIONS,
  buildClubOverviewCustomId,
  buildClubOverviewEmbed,
  buildClubOverviewEmbeds,
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

  it('shows every club across multiple embeds while select options stay capped at 25', () => {
    const summaries = Array.from({ length: 30 }, (_, index) => summary(index, 1000 + index));
    const embeds = buildClubOverviewEmbeds({
      summaries,
      guildLabel: null,
      now: NOW,
      config: CONFIG,
    });
    const data = embeds.map((embed) => embed.toJSON());

    expect(sortOverviewSummaries(summaries)[0]?.club.name).toBe('Club 29');
    expect(embeds).toHaveLength(2);
    expect(data[0]?.fields).toHaveLength(OVERVIEW_FIELDS_PER_EMBED);
    expect(data[1]?.fields).toHaveLength(5);
    expect(data[0]?.title).toContain('(1/2)');
    expect(data[1]?.title).toContain('(2/2)');
    expect(data[0]?.footer?.text).not.toContain('Showing top');
    expect(data.flatMap((item) => (item.fields ?? []).map((field) => field.name))).toHaveLength(30);

    const select = buildClubOverviewSelect(summaries, GUILD_ID);
    expect(select?.components).toHaveLength(1);
    const menu = select?.components[0] as {
      custom_id: string;
      options: unknown[];
      min_values: number;
      max_values: number;
      placeholder: string;
    };
    expect(menu.custom_id).toBe(buildClubOverviewCustomId(GUILD_ID));
    expect(menu.options).toHaveLength(OVERVIEW_MAX_CLUBS);
    expect(menu.min_values).toBe(1);
    expect(menu.max_values).toBe(OVERVIEW_MAX_SELECTIONS);
    expect(menu.placeholder).toBe(`Choose 1-${OVERVIEW_MAX_SELECTIONS} Clubs`);
  });

  it('caps at Discord message limits and reports clubs beyond that', () => {
    const total = OVERVIEW_ALL_CLUBS_LIMIT + 5;
    const summaries = Array.from({ length: total }, (_, index) => summary(index, 1000 + index));
    const embeds = buildClubOverviewEmbeds({
      summaries,
      guildLabel: null,
      now: NOW,
      config: CONFIG,
    });
    const fields = embeds.reduce(
      (count, embed) => count + (embed.toJSON().fields?.length ?? 0),
      0,
    );

    expect(embeds).toHaveLength(OVERVIEW_MAX_EMBEDS);
    expect(fields).toBe(OVERVIEW_ALL_CLUBS_LIMIT);
    expect(embeds[0]?.toJSON().footer?.text).toContain(
      `Showing first ${OVERVIEW_ALL_CLUBS_LIMIT} of ${total} clubs`,
    );
  });

  it('lets members select several clubs when fewer than the cap are shown', () => {
    const select = buildClubOverviewSelect([summary(1, 1000), summary(2, 2000)], GUILD_ID);
    const menu = select?.components[0] as { min_values: number; max_values: number; placeholder: string };

    expect(menu.min_values).toBe(1);
    expect(menu.max_values).toBe(2);
    expect(menu.placeholder).toBe('Choose 1-2 Clubs');
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
