// Register real club tags for a Discord guild before running sync.
// Usage: npm run clubs:register -- --guild <discord-guild-id> '#TAG1' '#TAG2'
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { registerClubs } from '@brawlhub/sync';

loadEnv({ path: resolve(process.cwd(), '.env') });

const argv = process.argv.slice(2);
let guildId = process.env.DISCORD_GUILD_ID?.trim() ?? '';
const tags: string[] = [];
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? '';
  if (arg === '--guild') {
    guildId = (argv[index + 1] ?? '').trim();
    index += 1;
    continue;
  }
  if (arg.startsWith('--guild=')) {
    guildId = arg.slice('--guild='.length).trim();
    continue;
  }
  tags.push(arg);
}

if (guildId.length === 0) {
  console.error('A Discord guild id is required: pass --guild <id> or set DISCORD_GUILD_ID.');
  process.exit(1);
}

const result = await registerClubs(tags, guildId);
console.log(JSON.stringify(result, null, 2));

if (result.rejected.length > 0) {
  process.exit(1);
}
