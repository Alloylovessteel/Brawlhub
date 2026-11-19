// One-off sync runner. Usage: npm run sync:run [--guild <discord-guild-id>]
// Loads the root .env so server-side credentials are available to @brawlhub/sync.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { runSync, runSyncForAllGuilds } from '@brawlhub/sync';

loadEnv({ path: resolve(process.cwd(), '.env') });

const argv = process.argv.slice(2);
let guildId = process.env.DISCORD_GUILD_ID?.trim() ?? '';
for (let index = 0; index < argv.length; index += 1) {
  const arg = argv[index] ?? '';
  if (arg === '--guild') {
    guildId = (argv[index + 1] ?? '').trim();
    index += 1;
    continue;
  }
  if (arg.startsWith('--guild=')) {
    guildId = arg.slice('--guild='.length).trim();
  }
}

const result =
  guildId.length > 0 ? await runSync({ guildId }) : await runSyncForAllGuilds();
console.log(JSON.stringify(result, null, 2));

const failed = Array.isArray(result)
  ? result.some((entry) => entry.status === 'failed')
  : result.status === 'failed';
if (failed) {
  process.exit(1);
}
