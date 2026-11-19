import type { AnySelectMenuInteraction, ButtonInteraction } from 'discord.js';

/** Message component interactions routed by command custom-id prefixes. */
export type CommandComponentInteraction = ButtonInteraction | AnySelectMenuInteraction;
