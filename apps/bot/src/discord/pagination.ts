import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type ButtonInteraction,
} from 'discord.js';

export interface Page<T> {
  readonly items: readonly T[];
  readonly page: number;
  readonly pageCount: number;
  readonly total: number;
  readonly start: number;
  readonly end: number;
}

/** Split a list into a bounded, one-based page. */
export function paginate<T>(items: readonly T[], page: number, pageSize: number): Page<T> {
  const safePageSize = Math.max(1, Math.floor(pageSize));
  const total = items.length;
  const pageCount = Math.max(1, Math.ceil(total / safePageSize));
  const safePage = Math.min(Math.max(1, Math.floor(page)), pageCount);
  const start = (safePage - 1) * safePageSize;
  const end = Math.min(start + safePageSize, total);

  return {
    items: items.slice(start, end),
    page: safePage,
    pageCount,
    total,
    start: total === 0 ? 0 : start + 1,
    end,
  };
}

/** Build a stable custom ID for a pagination button. */
export function paginationCustomId(commandName: string, page: number): string {
  return `${commandName}:page:${Math.max(1, Math.floor(page))}`;
}

/** Parse a pagination custom ID, returning null when it belongs to another command. */
export function parsePaginationCustomId(
  customId: string,
  commandName: string,
): number | null {
  const prefix = `${commandName}:page:`;
  if (!customId.startsWith(prefix)) {
    return null;
  }
  const page = Number(customId.slice(prefix.length));
  return Number.isInteger(page) && page > 0 ? page : null;
}

/** Build Previous/Next controls. Disabled buttons are omitted from the row. */
export function buildPaginationRow(
  commandName: string,
  page: number,
  pageCount: number,
): ActionRowBuilder<ButtonBuilder> | null {
  const safePage = Math.min(Math.max(1, Math.floor(page)), Math.max(1, pageCount));
  const buttons: ButtonBuilder[] = [];

  if (safePage > 1) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(paginationCustomId(commandName, safePage - 1))
        .setLabel('Previous')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  if (safePage < pageCount) {
    buttons.push(
      new ButtonBuilder()
        .setCustomId(paginationCustomId(commandName, safePage + 1))
        .setLabel('Next')
        .setStyle(ButtonStyle.Secondary),
    );
  }

  return buttons.length === 0 ? null : new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
}

/** True when a button interaction targets this command's pagination. */
export function isPaginationButton(interaction: ButtonInteraction, commandName: string): boolean {
  return parsePaginationCustomId(interaction.customId, commandName) !== null;
}
