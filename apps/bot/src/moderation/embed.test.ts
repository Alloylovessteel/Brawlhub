import { describe, expect, it } from 'vitest';
import { paginate } from '../discord/pagination';
import type {
  AddBlacklistResult,
  BlacklistEntry,
  BlacklistListView,
} from './types';
import {
  buildBlacklistAddConfirmationEmbed,
  buildBlacklistAddedEmbed,
  buildBlacklistListEmbed,
  buildBlacklistRemovedEmbed,
} from './embed';

const CONFIG = { playerProfileUrlTemplate: 'https://example.test/player/{tag}' };
const NOW = new Date('2026-11-18T12:00:00.000Z');
const CREATED_AT = '2026-11-18T10:00:00.000Z';
const REMOVED_AT = '2026-11-18T11:00:00.000Z';
const STAFF_DISCORD = '111111111111111111';

function entry(overrides: Partial<BlacklistEntry> = {}): BlacklistEntry {
  return {
    id: 'blacklist-1',
    playerId: 'player-1',
    playerTag: '2C0Y',
    playerName: 'Alpha',
    reason: 'Spamming chat',
    createdByProfileId: 'profile-1',
    createdByDiscordId: STAFF_DISCORD,
    createdAt: CREATED_AT,
    expiresAt: null,
    removedAt: null,
    ...overrides,
  };
}

function view(entries: readonly BlacklistEntry[]): BlacklistListView {
  return { entries, generatedAt: NOW };
}

function text(embed: ReturnType<typeof buildBlacklistListEmbed>): string {
  const json = embed.toJSON();
  return [
    json.title ?? '',
    json.description ?? '',
    json.footer?.text ?? '',
    ...(json.fields ?? []).map((field) => `${field.name} ${field.value}`),
  ].join('\n');
}

function totalLength(embed: ReturnType<typeof buildBlacklistListEmbed>): number {
  return JSON.stringify(embed.toJSON()).length;
}

describe('moderation embeds', () => {
  it('shows the player, reason, responsible staff and created date in the list', () => {
    const entries = [entry()];
    const embed = buildBlacklistListEmbed(view(entries), paginate(entries, 1, 10), CONFIG, NOW);
    const body = text(embed);

    expect(body).toContain('Alpha');
    expect(body).toContain('#2C0Y');
    expect(body).toContain('Spamming chat');
    expect(body).toContain(STAFF_DISCORD);
    expect(body).toContain('<t:');
    expect(embed.toJSON().color).toBe(0x5865_f2);
  });

  it('keeps long reasons inside Discord field limits', () => {
    const longReason = 'x'.repeat(600);
    const result: AddBlacklistResult = {
      id: 'blacklist-1',
      player: { id: 'player-1', tag: '2C0Y', name: 'Alpha' },
      reason: longReason,
      createdAt: CREATED_AT,
    };

    const added = buildBlacklistAddedEmbed(result, STAFF_DISCORD, NOW);
    const confirmation = buildBlacklistAddConfirmationEmbed(result.player, longReason, STAFF_DISCORD, NOW);

    for (const embed of [added, confirmation]) {
      const json = embed.toJSON();
      for (const field of json.fields ?? []) {
        expect(field.value.length).toBeLessThanOrEqual(1024);
        expect(field.name.length).toBeLessThanOrEqual(256);
      }
      expect(totalLength(embed)).toBeLessThanOrEqual(6000);
    }
  });

  it('keeps a page with many long entries inside the total embed limit', () => {
    const entries = Array.from({ length: 60 }, (_, index) =>
      entry({
        id: `blacklist-${index}`,
        playerTag: '2C0Y',
        playerName: `Player ${index}`,
        reason: 'y'.repeat(500),
      }),
    );
    const embed = buildBlacklistListEmbed(view(entries), paginate(entries, 1, 20), CONFIG, NOW);
    const json = embed.toJSON();

    expect(json.description?.length).toBeLessThanOrEqual(4000);
    expect(totalLength(embed)).toBeLessThanOrEqual(6000);
    expect(text(embed)).toContain('of 60');
  });

  it('marks the add confirmation as ephemeral and not yet applied', () => {
    const player = { id: 'player-1', tag: '2C0Y', name: 'Alpha' };
    const body = text(
      buildBlacklistAddConfirmationEmbed(player, 'Cheating', STAFF_DISCORD, NOW),
    );

    expect(body.toLowerCase()).toContain('ephemeral');
    expect(body).toContain('not applied until Confirm');
    expect(body).toContain('Alpha');
    expect(body).toContain('#2C0Y');
    expect(body).toContain('Cheating');
    expect(body).toContain(STAFF_DISCORD);
    expect(body).not.toContain('was added to the active blacklist');
  });

  it('renders success and removal embeds with IDs and Discord timestamps', () => {
    const result: AddBlacklistResult = {
      id: 'blacklist-1',
      player: { id: 'player-1', tag: '2C0Y', name: 'Alpha' },
      reason: 'Spamming chat',
      createdAt: CREATED_AT,
    };
    const added = text(buildBlacklistAddedEmbed(result, STAFF_DISCORD, NOW));
    expect(added).toContain('Alpha');
    expect(added).toContain('#2C0Y');
    expect(added).toContain('Spamming chat');
    expect(added).toContain(STAFF_DISCORD);
    expect(added).toContain('<t:');

    const removed = text(buildBlacklistRemovedEmbed({ id: 'blacklist-1', removedAt: REMOVED_AT }, NOW));
    expect(removed).toContain('blacklist-1');
    expect(removed).toContain('<t:');
  });

  it('handles an empty list without inventing rows', () => {
    const body = text(buildBlacklistListEmbed(view([]), paginate([], 1, 10), CONFIG, NOW));
    expect(body).toContain('No active blacklists.');
  });
});
