import type {
  AutocompleteInteraction,
  ChatInputCommandInteraction,
} from 'discord.js';

export interface LegacyRoute {
  /** Legacy subcommand group expected by the original handler. */
  readonly group?: string | null;
  /** Legacy subcommand expected by the original handler. */
  readonly subcommand?: string | null;
}

type MutableProxyTarget = object;

/**
 * Wraps an object so selected properties are replaced while every method stays
 * bound to the original instance. This lets existing handlers keep reading the
 * old subcommand names without modifying their business logic.
 */
function proxied<T extends MutableProxyTarget>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(original, property) {
      if (property in overrides) {
        return overrides[property as string];
      }
      const value = Reflect.get(original, property, original);
      return typeof value === 'function' ? value.bind(original) : value;
    },
  });
}

/**
 * Presents an Option 3 chat-input interaction to an existing handler as the
 * legacy command shape it expects.
 */
export function asLegacyChatInput(
  interaction: ChatInputCommandInteraction,
  route: LegacyRoute,
): ChatInputCommandInteraction {
  const originalOptions = interaction.options;
  const options = proxied(originalOptions, {
    getSubcommandGroup: () => route.group ?? null,
    getSubcommand: () => route.subcommand ?? originalOptions.getSubcommand(false),
  });
  return proxied(interaction, { options });
}

/**
 * Presents an Option 3 autocomplete interaction to an existing handler with
 * the legacy subcommand name it expects.
 */
export function asLegacyAutocomplete(
  interaction: AutocompleteInteraction,
  subcommand: string | null,
): AutocompleteInteraction {
  const options = proxied(interaction.options, {
    getSubcommandGroup: () => null,
    getSubcommand: () => subcommand,
  });
  return proxied(interaction, { options });
}
