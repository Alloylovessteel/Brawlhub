import { describe, expect, it } from 'vitest';
import { buildReportEmbed } from './embed';
import { currentReportPeriod } from './period';
import type { ReportData } from './service';

const PERIOD = currentReportPeriod(new Date('2026-11-20T00:00:05Z'), 'daily');

function dataWithClubs(count: number): ReportData {
  const clubSummaries = Array.from({ length: count }, (_, index) => ({
    clubId: `club-${index}`,
    tag: `#TAG${index}`.repeat(20),
    name: `Club ${index} `.repeat(60),
    joins: index,
    leaves: index + 1,
    transfers: index + 2,
    roleChanges: index + 3,
    capacityOpens: index + 4,
    capacityCloses: index + 5,
  }));
  return {
    period: PERIOD,
    clubSummaries,
    totals: {
      clubs: clubSummaries.length,
      joins: 42,
      leaves: 7,
      transfers: 3,
      roleChanges: 12,
      capacityOpens: 2,
      capacityCloses: 1,
    },
  };
}

describe('buildReportEmbed', () => {
  it('uses the guild label and period key in the title', () => {
    const embed = buildReportEmbed({
      data: dataWithClubs(1),
      guildLabel: 'BrawlHub Guild',
      now: new Date('2026-11-20T00:00:05Z'),
    });
    const json = embed.toJSON();

    expect(json.title).toContain('Daily club report');
    expect(json.title).toContain('BrawlHub Guild');
    expect(json.title).toContain(PERIOD.periodKey);
    expect(json.footer?.text).toBe('Stored BrawlHub sync history • fixed UTC boundaries • not live');
    expect(json.fields?.[0]).toMatchObject({ name: 'Totals', inline: false });
    expect(json.fields?.[1]?.inline).toBe(true);
    expect(json.fields?.[1]?.value).toContain('Joins: 0');
  });

  it('keeps long club lists inside Discord embed limits', () => {
    const embed = buildReportEmbed({
      data: dataWithClubs(30),
      guildLabel: 'A guild name '.repeat(50),
      now: new Date('2026-11-20T00:00:05Z'),
    });
    const json = embed.toJSON();

    expect(json.fields?.length).toBeLessThanOrEqual(25);
    expect(json.title?.length).toBeLessThanOrEqual(256);
    expect(json.fields?.every((field) => field.name.length <= 256 && field.value.length <= 1024)).toBe(
      true,
    );
    expect(JSON.stringify(json).length).toBeLessThanOrEqual(6000);
  });

  it('never adds ranks, live status or other invented fields', () => {
    const json = buildReportEmbed({
      data: dataWithClubs(2),
      guildLabel: null,
      now: new Date('2026-11-20T00:00:05Z'),
    }).toJSON();
    const serialized = JSON.stringify(json);

    expect(serialized).not.toMatch(/rank|online status|map rotation|blacklist/i);
    expect(serialized).toContain('Capacity opens');
  });
});
