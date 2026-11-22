import { describe, expect, it } from 'vitest';
import {
  computeDesiredTierKeys,
  countProfileBrawlers,
  DEFAULT_TIER_KEYS,
  parseClubRankKey,
  parseRankedTierKey,
  ROLE_KINDS,
  ROLE_KIND_LABELS,
  thresholdTierKey,
} from './tiers.js';

describe('auto role kinds', () => {
  it('exposes exactly the ten supported kinds with their labels', () => {
    expect(ROLE_KINDS.map((entry) => entry.kind)).toEqual([
      'verify',
      'trophy',
      'solo_win',
      'duo_win',
      'vs_win',
      'brawler',
      'level',
      'ranked',
      'club',
      'fame',
    ]);
    expect(ROLE_KINDS.map((entry) => entry.label)).toEqual([
      'Verify',
      'Trophy',
      'Solo Win',
      'Duo Win',
      '3vs3 Win',
      'Brawler',
      'Level',
      'Ranked League',
      'Club',
      'Fame',
    ]);
    expect(Object.keys(ROLE_KIND_LABELS)).toHaveLength(10);
    expect(DEFAULT_TIER_KEYS.ranked).toEqual([
      'BRONZE',
      'SILVER',
      'GOLD',
      'DIAMOND',
      'MYTHIC',
      'LEGENDARY',
      'MASTERS',
      'PRO',
    ]);
    expect(DEFAULT_TIER_KEYS.club).toEqual(['senior', 'vicePresident', 'president']);
  });
});

describe('threshold tiers', () => {
  it('grants the highest configured tier at or below the official value', () => {
    const tiers = ['5000', '10000', '20000', '30000', '50000'];
    expect(thresholdTierKey(tiers, 21_450)).toBe('20000');
    expect(thresholdTierKey(tiers, 50_000)).toBe('50000');
    expect(thresholdTierKey(tiers, 4_999)).toBeNull();
    expect(thresholdTierKey(tiers, null)).toBeNull();
  });

  it('uses only the configured tier keys', () => {
    expect(computeDesiredTierKeys('trophy', { trophies: 22_000 }, ['10000', '20000'])).toEqual([
      '20000',
    ]);
    expect(computeDesiredTierKeys('solo_win', { soloVictories: 600 })).toEqual(['500']);
    expect(computeDesiredTierKeys('duo_win', { duoVictories: 99 })).toEqual([]);
    expect(computeDesiredTierKeys('vs_win', { vsVictories: 1_200 })).toEqual(['1000']);
    expect(computeDesiredTierKeys('level', { level: 72 })).toEqual(['70']);
    expect(computeDesiredTierKeys('fame', { fame: 12_000 })).toEqual(['10000']);
    expect(computeDesiredTierKeys('brawler', { brawlerCount: 31 })).toEqual(['30']);
  });
});

describe('official-derived non-numeric tiers', () => {
  it('parses ranked names exactly like the ranked role service', () => {
    expect(parseRankedTierKey('DIAMOND II')).toBe('DIAMOND');
    expect(parseRankedTierKey('legendary i')).toBe('LEGENDARY');
    expect(parseRankedTierKey('UNKNOWN')).toBeNull();
    expect(computeDesiredTierKeys('ranked', { rankedRankName: 'GOLD III' })).toEqual(['GOLD']);
    expect(
      computeDesiredTierKeys('ranked', { rankedRankName: 'GOLD III' }, ['DIAMOND', 'PRO']),
    ).toEqual([]);
  });

  it('uses the highest official club rank available in the guild config', () => {
    expect(parseClubRankKey('vicePresident')).toBe('vicePresident');
    expect(parseClubRankKey('Vice President')).toBe('vicePresident');
    expect(computeDesiredTierKeys('club', { clubRoles: ['member', 'senior'] })).toEqual(['senior']);
    expect(computeDesiredTierKeys('club', { clubRoles: ['senior', 'president'] })).toEqual([
      'president',
    ]);
    expect(computeDesiredTierKeys('club', { clubRoles: ['vicePresident'] }, ['senior'])).toEqual([
      'senior',
    ]);
    expect(computeDesiredTierKeys('club', { clubRoles: ['member'] })).toEqual([]);
  });

  it('only grants verification when the player is actually a verified main', () => {
    expect(computeDesiredTierKeys('verify', { verified: true })).toEqual(['verified']);
    expect(computeDesiredTierKeys('verify', { verified: false })).toEqual([]);
    expect(computeDesiredTierKeys('verify', {})).toEqual([]);
  });
});

describe('stored official brawler roster', () => {
  it('counts distinct owned brawlers without calling an API', () => {
    expect(
      countProfileBrawlers({
        brawlers: [
          { id: 16000000, name: 'Shelly' },
          { id: 16000000, name: 'Shelly' },
          { id: 16000001, name: 'Colt' },
          { name: '' },
        ],
      }),
    ).toBe(2);
    expect(countProfileBrawlers({})).toBeNull();
    expect(countProfileBrawlers(null)).toBeNull();
  });
});
