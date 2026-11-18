import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} from 'discord.js';

export type ConfirmationAction = 'confirm' | 'cancel';

export interface ConfirmationRef {
  readonly kind: ConfirmationAction;
  readonly nonce: string;
}

export function buildConfirmationRow(
  commandName: string,
  nonce: string,
): ActionRowBuilder<ButtonBuilder> {
  return new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`${commandName}:confirm:${nonce}`)
      .setLabel('Confirm')
      .setStyle(ButtonStyle.Success),
    new ButtonBuilder()
      .setCustomId(`${commandName}:cancel:${nonce}`)
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  );
}

export function parseConfirmationCustomId(
  customId: string,
  commandName: string,
): ConfirmationRef | null {
  const [name, action, nonce] = customId.split(':');
  if (
    name !== commandName ||
    (action !== 'confirm' && action !== 'cancel') ||
    nonce === undefined ||
    nonce === ''
  ) {
    return null;
  }
  return { kind: action, nonce };
}
