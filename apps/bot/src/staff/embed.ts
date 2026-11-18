import { EmbedBuilder } from 'discord.js';
import { fitEmbedToDiscordLimits } from '../clubs/embed';
import { escapeMarkdown, formatInteger } from '../discord/format';
import type { Page } from '../discord/pagination';
import type { StaffListView, StaffMember, StaffRoleEntry } from './types';

const EMBED_COLOR = 0x5865_f2;
const MAX_FIELDS = 25;
const PERMISSION_VALUE_LIMIT = 300;

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum - 1)}…`;
}

function count(value: number): string {
  return formatInteger(value) ?? '0';
}

function roleLabel(role: StaffRoleEntry['role']): string {
  return role.charAt(0).toUpperCase() + role.slice(1);
}

function scopeText(entry: StaffRoleEntry): string {
  if (entry.scope === 'global') return `Global ${roleLabel(entry.role)}`;
  const name = entry.clubName === null ? 'Unnamed club' : escapeMarkdown(entry.clubName);
  const club = entry.clubTag === null ? name : `#${escapeMarkdown(entry.clubTag)} ${name}`;
  return `Club ${roleLabel(entry.role)} — ${club}`;
}

function identityText(member: StaffMember): string {
  return member.discordUsername === null
    ? `Discord ID ${member.discordUserId}`
    : escapeMarkdown(member.discordUsername);
}

function memberField(member: StaffMember): { readonly name: string; readonly value: string } {
  const identity = identityText(member);
  const scopes = member.roles.length === 0
    ? 'No staff roles'
    : member.roles.map(scopeText).join('; ');
  const permissions = member.permissions.length === 0
    ? 'None'
    : truncate(member.permissions.join(', '), PERMISSION_VALUE_LIMIT);
  return {
    name: truncate(identity, 256),
    value: truncate(
      `Identity: ${identity}\nScope: ${scopes}\nPermissions: ${permissions}\nStatus: Active role assignment`,
      1024,
    ),
  };
}

/** Entry point for `/staff`: explains who can use `/staff list` and what it shows. */
export function buildStaffOverviewEmbed(now: Date = new Date()): EmbedBuilder {
  return new EmbedBuilder()
    .setColor(EMBED_COLOR)
    .setTitle('Staff')
    .setDescription(
      'Use `/staff list` to review registered staff. Access is restricted to global staff ' +
        'with the `staff:manage` permission. The list shows both global and club role assignments.',
    )
    .setTimestamp(now)
    .setFooter({ text: 'Role presence is the active status; no separate status flag is stored.' });
}

/** Compact, bounded page of staff members and their resolved assignments. */
export function buildStaffListEmbed(
  view: StaffListView,
  page: Page<StaffMember>,
  now: Date = new Date(),
): EmbedBuilder {
  const summary = [
    `Page ${page.page}/${page.pageCount} (${page.start}–${page.end} of ${page.total})`,
    `Total staff entries: ${count(view.entries.length)}`,
    `Global assignments: ${count(view.globalCount)} • Club assignments: ${count(view.clubCount)}`,
  ].join('\n');

  const fields: { name: string; value: string }[] = [];
  const hasOverflow = page.items.length > MAX_FIELDS;
  const visibleCount = Math.min(page.items.length, MAX_FIELDS - (hasOverflow ? 1 : 0));
  for (const member of page.items.slice(0, visibleCount)) fields.push(memberField(member));
  if (hasOverflow) {
    fields.push({
      name: 'Additional entries',
      value: `${count(page.items.length - visibleCount)} staff members on this page are not shown.`,
    });
  }

  const description = view.entries.length === 0 ? 'No registered staff found.' : summary;
  return fitEmbedToDiscordLimits(
    new EmbedBuilder()
      .setColor(EMBED_COLOR)
      .setTitle('Staff list')
      .setDescription(truncate(description, 4000))
      .addFields(fields)
      .setTimestamp(now)
      .setFooter({ text: 'Club roles are shown for visibility; staff:manage requires a global role.' }),
  );
}
