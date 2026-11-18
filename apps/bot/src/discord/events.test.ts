import { EventEmitter } from 'node:events';
import type { Client, GuildMember, Role } from 'discord.js';
import { describe, expect, it } from 'vitest';
import {
  buildMemberUpdateChange,
  buildRoleDeleteChange,
  buildRoleUpdateChange,
  registerDiscordAuthorizationEvents,
  type DiscordAuthorizationChange,
} from './events';

interface RoleInput {
  readonly guildId: string;
  readonly id: string;
  readonly name?: string;
  readonly position?: number;
  readonly permissions?: bigint;
}

function makeRole(input: RoleInput): Role {
  return {
    guild: { id: input.guildId },
    id: input.id,
    name: input.name ?? 'role',
    position: input.position ?? 0,
    permissions: { bitfield: input.permissions ?? 0n },
  } as unknown as Role;
}

function makeMember(guildId: string, userId: string, roleIds: string[]): GuildMember {
  return {
    guild: { id: guildId },
    user: { id: userId },
    roles: { cache: { keys: () => roleIds[Symbol.iterator]() } },
  } as unknown as GuildMember;
}

describe('Discord authorization event changes', () => {
  it('detects role position, permission and name changes', () => {
    const change = buildRoleUpdateChange(
      makeRole({ guildId: 'guild-1', id: 'role-1', name: 'old', position: 5, permissions: 1n }),
      makeRole({ guildId: 'guild-1', id: 'role-1', name: 'new', position: 6, permissions: 3n })
    );

    expect(change).toEqual({
      type: 'guild_role_update',
      guildId: 'guild-1',
      roleId: 'role-1',
      nameChanged: true,
      positionChanged: true,
      permissionsChanged: true,
    });
  });

  it('captures a deleted role position and permission bitfield', () => {
    const change = buildRoleDeleteChange(
      makeRole({ guildId: 'guild-1', id: 'role-1', position: 12, permissions: 8n })
    );

    expect(change).toEqual({
      type: 'guild_role_delete',
      guildId: 'guild-1',
      roleId: 'role-1',
      position: 12,
      permissionBitfield: '8',
    });
  });

  it('computes added and removed member roles deterministically', () => {
    const change = buildMemberUpdateChange(
      makeMember('guild-1', 'user-1', ['role-c', 'role-b', 'role-a']),
      makeMember('guild-1', 'user-1', ['role-d', 'role-a'])
    );

    expect(change).toEqual({
      type: 'guild_member_update',
      guildId: 'guild-1',
      userId: 'user-1',
      rolesAdded: ['role-d'],
      rolesRemoved: ['role-b', 'role-c'],
      roleCount: 2,
    });
  });
});

describe('registerDiscordAuthorizationEvents', () => {
  it('reports only changes from the configured guild', () => {
    const emitter = new EventEmitter() as unknown as Client;
    const changes: DiscordAuthorizationChange[] = [];

    registerDiscordAuthorizationEvents(emitter, 'client-guild', (change) => {
      changes.push(change);
    });

    emitter.emit(
      'guildRoleUpdate',
      makeRole({ guildId: 'other-guild', id: 'role-1' }),
      makeRole({ guildId: 'other-guild', id: 'role-1', position: 1 })
    );
    emitter.emit(
      'guildRoleDelete',
      makeRole({ guildId: 'client-guild', id: 'role-2', position: 3, permissions: 4n })
    );
    emitter.emit(
      'guildMemberUpdate',
      makeMember('client-guild', 'user-1', ['role-a']),
      makeMember('client-guild', 'user-1', ['role-a', 'role-b'])
    );

    expect(changes.map((change) => change.type)).toEqual([
      'guild_role_delete',
      'guild_member_update',
    ]);
  });
});
