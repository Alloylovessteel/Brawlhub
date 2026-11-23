import { createTrustedClient } from '@brawlhub/database';
import {
  customRoleNameSchema,
  discordIdSchema,
  isBuiltinRole,
  permissionSchema,
  type Role,
} from '@brawlhub/shared';
import { NextResponse, type NextRequest } from 'next/server';
import { z } from 'zod';
import { jsonError, requireApiGlobalPermission, sameOriginGuard } from '@/lib/api/guards';
import { checkRateLimit } from '@/lib/api/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const targetSchema = z
  .string()
  .regex(/^(?:builtin:(?:owner|admin|staff|member)|custom:[0-9a-fA-F-]{36})$/);

const requestSchema = z.discriminatedUnion('action', [
  z.object({
    action: z.literal('create'),
    guildId: discordIdSchema,
    name: customRoleNameSchema,
    description: z.string().trim().max(200).optional().default(''),
    permissions: z.array(permissionSchema).min(1),
  }),
  z.object({
    action: z.literal('update'),
    guildId: discordIdSchema,
    customRoleId: z.uuid(),
    name: customRoleNameSchema,
    description: z.string().trim().max(200).optional().default(''),
    permissions: z.array(permissionSchema).min(1),
  }),
  z.object({
    action: z.literal('delete'),
    guildId: discordIdSchema,
    customRoleId: z.uuid(),
  }),
  z.object({
    action: z.literal('map'),
    guildId: discordIdSchema,
    discordRoleId: discordIdSchema,
    target: targetSchema,
  }),
  z.object({
    action: z.literal('unmap'),
    guildId: discordIdSchema,
    discordRoleId: discordIdSchema,
  }),
]);

type RequestData = z.infer<typeof requestSchema>;

function redirectToAdmin(request: NextRequest, status: 'success' | 'error'): NextResponse {
  const url = new URL('/dashboard/admin', request.nextUrl.origin);
  url.searchParams.set('customRoles', status);
  url.searchParams.set('tab', 'custom-roles');
  return NextResponse.redirect(url, 303);
}

function formDataToInput(formData: FormData): Record<string, unknown> {
  return {
    action: formData.get('action'),
    guildId: formData.get('guildId'),
    name: formData.get('name') ?? '',
    description: formData.get('description') ?? '',
    permissions: formData.getAll('permissions'),
    customRoleId: formData.get('customRoleId') ?? '',
    discordRoleId: formData.get('discordRoleId'),
    target: formData.get('target') ?? '',
  };
}

interface MappingTarget {
  builtin: Role | null;
  customRoleId: string | null;
}

function parseTarget(value: string): MappingTarget | null {
  if (value.startsWith('builtin:')) {
    const role = value.slice('builtin:'.length);
    return isBuiltinRole(role) ? { builtin: role, customRoleId: null } : null;
  }
  const customRoleId = z.uuid().safeParse(value.slice('custom:'.length));
  return customRoleId.success ? { builtin: null, customRoleId: customRoleId.data } : null;
}

function validateTarget(value: string): string | null {
  const parsed = parseTarget(value);
  if (parsed === null) return 'Select a valid built-in or custom role.';
  return null;
}

async function applyRequest(
  input: RequestData,
  actorProfileId: string,
  db: ReturnType<typeof createTrustedClient>,
): Promise<void> {
  const actorAudit = {
    actor_profile_id: actorProfileId,
    target_type: 'guild_custom_role',
    guild_id: input.guildId,
  };

  if (input.action === 'create') {
    const saved = await db
      .from('guild_custom_roles')
      .insert({
        guild_id: input.guildId,
        name: input.name,
        description: input.description === '' ? null : input.description,
        permissions: input.permissions,
        created_by: actorProfileId,
      })
      .select('id')
      .maybeSingle();
    if (saved.error !== null && saved.error !== undefined) throw new Error(saved.error.message);
    if (typeof saved.data?.id !== 'string') throw new Error('Custom role was not created');
    const audit = await db.from('audit_logs').insert({
      ...actorAudit,
      action: 'guild.custom_role.created',
      target_id: saved.data.id,
      details: {
        guildId: input.guildId,
        customRoleId: saved.data.id,
        customRoleName: input.name,
        permissions: input.permissions,
      },
    });
    if (audit.error !== null && audit.error !== undefined) throw new Error(audit.error.message);
    return;
  }

  if (input.action === 'update' || input.action === 'delete') {
    const current = await db
      .from('guild_custom_roles')
      .select('id, name')
      .eq('id', input.customRoleId)
      .eq('guild_id', input.guildId)
      .maybeSingle();
    if (current.error !== null && current.error !== undefined) throw new Error(current.error.message);
    if (current.data === null) throw new Error('Custom role not found');

    if (input.action === 'delete') {
      const mappings = await db
        .from('guild_role_mappings')
        .select('id')
        .eq('guild_id', input.guildId)
        .eq('custom_role_id', input.customRoleId);
      if (mappings.error !== null && mappings.error !== undefined) throw new Error(mappings.error.message);
      if ((mappings.data ?? []).length > 0) throw new Error('Custom role is still mapped');
      const removed = await db
        .from('guild_custom_roles')
        .delete()
        .eq('id', input.customRoleId)
        .eq('guild_id', input.guildId);
      if (removed.error !== null && removed.error !== undefined) throw new Error(removed.error.message);
      const audit = await db.from('audit_logs').insert({
        ...actorAudit,
        action: 'guild.custom_role.removed',
        target_id: input.customRoleId,
        details: {
          guildId: input.guildId,
          customRoleId: input.customRoleId,
          customRoleName: current.data.name,
        },
      });
      if (audit.error !== null && audit.error !== undefined) throw new Error(audit.error.message);
      return;
    }

    const saved = await db
      .from('guild_custom_roles')
      .update({
        name: input.name,
        description: input.description === '' ? null : input.description,
        permissions: input.permissions,
      })
      .eq('id', input.customRoleId)
      .eq('guild_id', input.guildId);
    if (saved.error !== null && saved.error !== undefined) throw new Error(saved.error.message);
    const audit = await db.from('audit_logs').insert({
      ...actorAudit,
      action: 'guild.custom_role.updated',
      target_id: input.customRoleId,
      details: {
        guildId: input.guildId,
        customRoleId: input.customRoleId,
        customRoleName: input.name,
        permissions: input.permissions,
      },
    });
    if (audit.error !== null && audit.error !== undefined) throw new Error(audit.error.message);
    return;
  }

  if (input.action === 'map') {
    const target = parseTarget(input.target);
    if (target === null) throw new Error('Invalid mapping target');
    if (target.customRoleId !== null) {
      const customRole = await db
        .from('guild_custom_roles')
        .select('id')
        .eq('id', target.customRoleId)
        .eq('guild_id', input.guildId)
        .maybeSingle();
      if (customRole.error !== null && customRole.error !== undefined) throw new Error(customRole.error.message);
      if (customRole.data === null) throw new Error('Custom role not found in this guild');
    }
    const saved = await db.from('guild_role_mappings').upsert(
      {
        guild_id: input.guildId,
        discord_role_id: input.discordRoleId,
        brawlhub_role: target.builtin,
        custom_role_id: target.customRoleId,
      },
      { onConflict: 'guild_id,discord_role_id' },
    );
    if (saved.error !== null && saved.error !== undefined) throw new Error(saved.error.message);
    const audit = await db.from('audit_logs').insert({
      ...actorAudit,
      action: 'guild.custom_role_mapping.updated',
      target_type: 'guild_role_mapping',
      target_id: `${input.guildId}:${input.discordRoleId}`,
      details: {
        guildId: input.guildId,
        discordRoleId: input.discordRoleId,
        brawlhubRole: target.builtin,
        customRoleId: target.customRoleId,
      },
    });
    if (audit.error !== null && audit.error !== undefined) throw new Error(audit.error.message);
    return;
  }

  const removed = await db
    .from('guild_role_mappings')
    .delete()
    .eq('guild_id', input.guildId)
    .eq('discord_role_id', input.discordRoleId);
  if (removed.error !== null && removed.error !== undefined) throw new Error(removed.error.message);
  const audit = await db.from('audit_logs').insert({
    ...actorAudit,
    action: 'guild.custom_role_mapping.removed',
    target_type: 'guild_role_mapping',
    target_id: `${input.guildId}:${input.discordRoleId}`,
    details: { guildId: input.guildId, discordRoleId: input.discordRoleId },
  });
  if (audit.error !== null && audit.error !== undefined) throw new Error(audit.error.message);
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const originError = sameOriginGuard(request);
  if (originError !== null) return originError;

  const guard = await requireApiGlobalPermission('staff:manage');
  if ('response' in guard) return guard.response;

  const rateLimit = checkRateLimit(`admin-custom-roles:${guard.session.profile!.id}`, 20, 60_000);
  if (!rateLimit.allowed) {
    return jsonError(429, 'rate_limited', 'Too many custom role changes. Please try again shortly.');
  }

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return jsonError(400, 'invalid_request');
  }

  const parsed = requestSchema.safeParse(formDataToInput(formData));
  if (!parsed.success) return redirectToAdmin(request, 'error');
  if (parsed.data.action === 'map' && validateTarget(parsed.data.target) !== null) {
    return redirectToAdmin(request, 'error');
  }

  const db = createTrustedClient();
  try {
    await applyRequest(parsed.data, guard.session.profile!.id, db);
    return redirectToAdmin(request, 'success');
  } catch (error) {
    console.error(
      'Custom role administration failed',
      error instanceof Error ? error.message : 'unknown error',
    );
    return redirectToAdmin(request, 'error');
  }
}
