import type { ChatInputCommandInteraction } from 'discord.js';
import { findVerifiedPlayerForDiscordUser } from '../verification/index.js';

export type MeSubcommand = 'profile' | 'image';

export type MeTagResolution =
  | { readonly kind: 'ok'; readonly tag: string }
  | { readonly kind: 'no-verified' }
  | { readonly kind: 'lookup-error' };

/**
 * Resolve the optional `/me` tag. Both subcommands deliberately share the
 * same verified-account behaviour as the original `/me` command.
 */
export async function resolveMeTag(
  interaction: ChatInputCommandInteraction,
  subcommand: MeSubcommand,
): Promise<MeTagResolution> {
  const supplied = interaction.options.getString('tag')?.trim() ?? '';
  if (supplied !== '') return { kind: 'ok', tag: supplied };

  try {
    const verified = await findVerifiedPlayerForDiscordUser(interaction.user.id);
    if (verified === null) return { kind: 'no-verified' };
    return { kind: 'ok', tag: verified.tag };
  } catch {
    return { kind: 'lookup-error' };
  }
}

/** Safe, user-facing message for a failed verified-account lookup. */
export function meTagErrorMessage(
  resolution: Exclude<MeTagResolution, { readonly kind: 'ok' }>,
  subcommand: MeSubcommand,
): string {
  if (resolution.kind === 'no-verified') {
    return (
      'You do not have a verified Brawl Stars player yet. Use ' +
      '`/members accounts verify tag:YOURTAG` to link one, or pass `tag:` to ' +
      `\`/me ${subcommand}\`.`
    );
  }
  return (
    'Could not read your verified player right now. Please try again or pass ' +
    `\`tag:\` to \`/me ${subcommand}\`.`
  );
}
