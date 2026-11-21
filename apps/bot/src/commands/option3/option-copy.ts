import {
  ApplicationCommandOptionType,
  SlashCommandSubcommandBuilder,
  SlashCommandSubcommandGroupBuilder,
} from 'discord.js';

type AnyBuilder = {
  [key: string]: any;
};

/** Any slash-command builder that can serialize itself to command JSON. */
export type SlashCommandSource = { toJSON: () => { options?: unknown } };

type RawOption = {
  type: number;
  name: string;
  description: string;
  required?: boolean;
  options?: RawOption[];
  [key: string]: any;
};

/** Returns the raw JSON options of an existing command definition. */
export function sourceOptions(data: SlashCommandSource): RawOption[] {
  return ((data.toJSON().options ?? []) as RawOption[]).filter(Boolean);
}

function applyCommon(builder: AnyBuilder, option: RawOption): AnyBuilder {
  builder.setName(option.name).setDescription(option.description);
  if (option.required === true) {
    builder.setRequired(true);
  }
  return builder;
}

function applyChoices(builder: AnyBuilder, option: RawOption): AnyBuilder {
  if (Array.isArray(option.choices) && option.choices.length > 0) {
    builder.addChoices(...option.choices);
  }
  return builder;
}

/** Copies one non-subcommand option from raw JSON into a builder. */
export function appendLeafOption(builder: AnyBuilder, option: RawOption): void {
  switch (option.type) {
    case ApplicationCommandOptionType.String:
      builder.addStringOption((target: AnyBuilder) => {
        let optionBuilder = applyCommon(target, option);
        if (option.autocomplete === true) optionBuilder.setAutocomplete(true);
        if (option.min_length !== undefined) optionBuilder.setMinLength(option.min_length);
        if (option.max_length !== undefined) optionBuilder.setMaxLength(option.max_length);
        return applyChoices(optionBuilder, option);
      });
      return;
    case ApplicationCommandOptionType.Integer:
      builder.addIntegerOption((target: AnyBuilder) => {
        let optionBuilder = applyCommon(target, option);
        if (option.min_value !== undefined) optionBuilder.setMinValue(option.min_value);
        if (option.max_value !== undefined) optionBuilder.setMaxValue(option.max_value);
        return applyChoices(optionBuilder, option);
      });
      return;
    case ApplicationCommandOptionType.Number:
      builder.addNumberOption((target: AnyBuilder) => {
        let optionBuilder = applyCommon(target, option);
        if (option.min_value !== undefined) optionBuilder.setMinValue(option.min_value);
        if (option.max_value !== undefined) optionBuilder.setMaxValue(option.max_value);
        return applyChoices(optionBuilder, option);
      });
      return;
    case ApplicationCommandOptionType.Boolean:
      builder.addBooleanOption((target: AnyBuilder) => applyCommon(target, option));
      return;
    case ApplicationCommandOptionType.User:
      builder.addUserOption((target: AnyBuilder) => applyCommon(target, option));
      return;
    case ApplicationCommandOptionType.Role:
      builder.addRoleOption((target: AnyBuilder) => applyCommon(target, option));
      return;
    case ApplicationCommandOptionType.Mentionable:
      builder.addMentionableOption((target: AnyBuilder) => applyCommon(target, option));
      return;
    case ApplicationCommandOptionType.Channel:
      builder.addChannelOption((target: AnyBuilder) => {
        const optionBuilder = applyCommon(target, option);
        if (Array.isArray(option.channel_types) && option.channel_types.length > 0) {
          optionBuilder.addChannelTypes(...option.channel_types);
        }
        return optionBuilder;
      });
      return;
    case ApplicationCommandOptionType.Attachment:
      builder.addAttachmentOption((target: AnyBuilder) => applyCommon(target, option));
      return;
    default:
      throw new Error(`Unsupported slash option type ${String(option.type)} for ${option.name}`);
  }
}

/** Copies one raw subcommand into a builder, optionally renaming it. */
export function appendSubcommand(
  builder: AnyBuilder,
  option: RawOption,
  rename?: string,
): void {
  builder.addSubcommand((target: AnyBuilder) => {
    target.setName(rename ?? option.name).setDescription(option.description);
    for (const child of option.options ?? []) {
      if (
        child.type === ApplicationCommandOptionType.Subcommand ||
        child.type === ApplicationCommandOptionType.SubcommandGroup
      ) {
        continue;
      }
      appendLeafOption(target, child);
    }
    return target;
  });
}

/** Copies several raw subcommands into a builder with optional renaming. */
export function appendSubcommands(
  builder: AnyBuilder,
  options: readonly RawOption[],
  rename?: (name: string) => string,
): void {
  for (const option of options) {
    if (option.type !== ApplicationCommandOptionType.Subcommand) {
      continue;
    }
    appendSubcommand(builder, option, rename?.(option.name));
  }
}

/** Copies the subcommands of an existing subcommand group into a builder. */
export function appendGroupSubcommands(
  builder: AnyBuilder,
  group: RawOption | undefined,
  rename?: (name: string) => string,
): void {
  if (group === undefined) {
    return;
  }
  appendSubcommands(builder, group.options ?? [], rename);
}

/** Builds a subcommand containing the leaf options of an existing command. */
export function subcommandWithOptions(
  data: SlashCommandSource,
  name: string,
  description: string,
): SlashCommandSubcommandBuilder {
  const subcommand = new SlashCommandSubcommandBuilder().setName(name).setDescription(description);
  for (const option of sourceOptions(data)) {
    if (
      option.type === ApplicationCommandOptionType.Subcommand ||
      option.type === ApplicationCommandOptionType.SubcommandGroup
    ) {
      continue;
    }
    appendLeafOption(subcommand, option);
  }
  return subcommand;
}

/** Builds a subcommand group containing an existing command's direct subcommands. */
export function groupWithSubcommands(
  data: SlashCommandSource,
  name: string,
  description: string,
  rename?: (name: string) => string,
): SlashCommandSubcommandGroupBuilder {
  const group = new SlashCommandSubcommandGroupBuilder().setName(name).setDescription(description);
  appendSubcommands(group, sourceOptions(data), rename);
  return group;
}

/** Finds a subcommand group in an existing command definition. */
export function findSourceGroup(data: SlashCommandSource, name: string): RawOption | undefined {
  return sourceOptions(data).find(
    (option) =>
      option.type === ApplicationCommandOptionType.SubcommandGroup && option.name === name,
  );
}

/** Finds a direct subcommand in an existing command definition. */
export function findSourceSubcommand(data: SlashCommandSource, name: string): RawOption | undefined {
  return sourceOptions(data).find(
    (option) => option.type === ApplicationCommandOptionType.Subcommand && option.name === name,
  );
}

/** Copies a direct subcommand out of an existing command, optionally renaming it. */
export function subcommandFromSource(
  data: SlashCommandSource,
  sourceName: string,
  name: string,
  description: string,
): SlashCommandSubcommandBuilder {
  const source = findSourceSubcommand(data, sourceName);
  const builder = new SlashCommandSubcommandBuilder().setName(name).setDescription(description);
  for (const child of source?.options ?? []) {
    if (
      child.type === ApplicationCommandOptionType.Subcommand ||
      child.type === ApplicationCommandOptionType.SubcommandGroup
    ) {
      continue;
    }
    appendLeafOption(builder, child);
  }
  return builder;
}

/**
 * Copies one subcommand out of an existing subcommand group, optionally
 * renaming it. Leaf options (and their autocomplete settings) are preserved.
 */
export function subcommandFromGroup(
  data: SlashCommandSource,
  groupName: string,
  sourceName: string,
  name: string,
  description: string,
): SlashCommandSubcommandBuilder {
  const group = findSourceGroup(data, groupName);
  const source = group?.options?.find(
    (option) =>
      option.type === ApplicationCommandOptionType.Subcommand && option.name === sourceName,
  );
  const builder = new SlashCommandSubcommandBuilder().setName(name).setDescription(description);
  for (const child of source?.options ?? []) {
    if (
      child.type === ApplicationCommandOptionType.Subcommand ||
      child.type === ApplicationCommandOptionType.SubcommandGroup
    ) {
      continue;
    }
    appendLeafOption(builder, child);
  }
  return builder;
}
