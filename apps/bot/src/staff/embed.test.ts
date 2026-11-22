import type { Permission, Role } from '@brawlhub/shared';
import { describe, expect, it } from 'vitest';
import { paginate } from '../discord/pagination';
import { buildStaffListEmbed, buildStaffOverviewEmbed } from './embed';
import type { StaffListView, StaffMember, StaffRoleEntry } from './types';

const NOW = new Date('2026-11-18T12:00:00.000Z');
const PERMISSIONS: readonly Permission[] = [
  'clubs:read',
  'clubs:write',
  'players:read',
  'sync:run',
  'members:verify',
  'staff:manage',
  'competitions:manage',
  'blacklists:manage',
  'audit:read',
  'notifications:send',
];

function role(overrides: Partial<StaffRoleEntry> = {}): StaffRoleEntry {
  return {
    scope: 'global',
    role: 'admin',
    clubId: null,
    clubTag: null,
    clubName: null,
    grantedAt: '2026-11-01T00:00:00.000Z',
    ...overrides,
  };
}

function member(overrides: Partial<StaffMember> = {}): StaffMember {
  return {
    profileId: 'profile-1',
    discordUserId: '111111111111111111',
    discordUsername: 'Owner#0001',
    roles: [role()],
    highestGlobalRole: 'admin',
    permissions: ['clubs:read', 'staff:manage'],
    ...overrides,
  };
}

function view(entries: readonly StaffMember[]): StaffListView {
  return {
    entries,
    globalCount: entries.filter((entry) => entry.roles.some((item) => item.scope === 'global')).length,
    clubCount: entries.filter((entry) => entry.roles.some((item) => item.scope === 'club')).length,
    generatedAt: NOW,
  };
}

type RenderedEmbed = ReturnType<typeof buildStaffOverviewEmbed>;

function text(embed: RenderedEmbed): string {
  const json = embed.toJSON();
  return [
    json.title ?? '',
    json.description ?? '',
    json.footer?.text ?? '',
    ...(json.fields ?? []).map((field) => `${field.name} ${field.value}`),
  ].join('\n');
}

function totalCharacters(embed: RenderedEmbed): number {
  const json = embed.toJSON();
  return (
    (json.title?.length ?? 0) +
    (json.description?.length ?? 0) +
    (json.footer?.text.length ?? 0) +
    (json.author?.name?.length ?? 0) +
    (json.fields ?? []).reduce((sum, field) => sum + field.name.length + field.value.length, 0)
  );
}

describe('staff embeds', () => {
  it('explains the global staff:manage restriction in the overview', () => {
    const embed = buildStaffOverviewEmbed(NOW);
    const body = text(embed);
    expect(body).toContain('/staff list');
    expect(body).toContain('global staff');
    expect(body).toContain('staff:manage');
    expect(body).toContain('global and club role assignments');
    expect(embed.toJSON().timestamp).toBe(NOW.toISOString());
  });

  it('renders identities, scopes, permissions, status and counts', () => {
    const entries = [
      member(),
      member({
        profileId: 'profile-2',
        discordUserId: '222222222222222222',
        discordUsername: null,
        roles: [role({ scope: 'club', role: 'staff', clubId: 'club-1', clubTag: 'ALPHA', clubName: 'Alpha' })],
        highestGlobalRole: null,
        permissions: ['clubs:read', 'members:verify'],
      }),
    ];
    const embed = buildStaffListEmbed(view(entries), paginate(entries, 1, 10), NOW);
    const body = text(embed);

    expect(body).toContain('Page 1/1');
    expect(body).toContain('**Total staff entries:** 2');
    expect(body).toContain('**Global assignments:** 1');
    expect(body).toContain('**Club assignments:** 1');
    expect(body).toContain('Owner#0001');
    expect(body).toContain('Global Admin');
    expect(body).toContain('Discord ID 222222222222222222');
    expect(body).toContain('Club Staff — #ALPHA Alpha');
    expect(body).toContain('staff:manage');
    expect(body).toContain('Active role assignment');
    expect(totalCharacters(embed)).toBeLessThanOrEqual(6000);
  });

  it('truncates long values and stays inside Discord field and total limits', () => {
    const longPermissions: Permission[] = Array.from(
      { length: 2_000 },
      (_value, index) => PERMISSIONS[index % PERMISSIONS.length] ?? 'clubs:read',
    );
    const entries = Array.from({ length: 30 }, (_value, index) =>
      member({
        profileId: `profile-${index}`,
        discordUserId: `${100000000000000000 + index}`,
        discordUsername: 'u'.repeat(3_000),
        roles: [
          role({
            scope: 'club',
            role: 'owner' as Role,
            clubId: `club-${index}`,
            clubTag: 't'.repeat(500),
            clubName: 'c'.repeat(3_000),
          }),
        ],
        highestGlobalRole: null,
        permissions: longPermissions,
      }),
    );
    const embed = buildStaffListEmbed(view(entries), paginate(entries, 1, 30), NOW);
    const json = embed.toJSON();

    expect(json.fields).toBeDefined();
    expect((json.fields ?? []).length).toBeLessThanOrEqual(25);
    for (const field of json.fields ?? []) {
      expect(field.name.length).toBeLessThanOrEqual(256);
      expect(field.value.length).toBeLessThanOrEqual(1024);
    }
    expect((json.description ?? '').length).toBeLessThanOrEqual(4096);
    expect(totalCharacters(embed)).toBeLessThanOrEqual(6000);
    expect(text(embed)).toContain('…');
  });

  it('renders a clear empty state', () => {
    const empty = view([]);
    const embed = buildStaffListEmbed(empty, paginate(empty.entries, 1, 5), NOW);
    expect(text(embed)).toContain('No registered staff found.');
    expect(embed.toJSON().fields ?? []).toHaveLength(0);
    expect(embed.toJSON().timestamp).toBe(NOW.toISOString());
  });
});
