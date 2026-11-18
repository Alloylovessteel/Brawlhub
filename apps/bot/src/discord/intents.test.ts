import { GatewayIntentBits } from 'discord.js';
import { describe, expect, it } from 'vitest';
import { getGatewayIntents } from './intents';

describe('Discord Gateway intents', () => {
  it('requests only Guilds and the privileged GuildMembers intent', () => {
    expect(getGatewayIntents()).toEqual([GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers]);
  });

  it('does not request unrelated privileged intents', () => {
    const intents = getGatewayIntents();

    expect(intents).not.toContain(GatewayIntentBits.GuildPresences);
    expect(intents).not.toContain(GatewayIntentBits.MessageContent);
    expect(intents).not.toContain(GatewayIntentBits.GuildMessageReactions);
    expect(intents).not.toContain(GatewayIntentBits.DirectMessages);
  });
});
