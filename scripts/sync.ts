// One-off sync runner. Usage: npm run sync:run
// Loads the root .env so server-side credentials are available to @brawlhub/sync.
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { runSync } from '@brawlhub/sync';

loadEnv({ path: resolve(process.cwd(), '.env') });

const result = await runSync();
console.log(JSON.stringify(result, null, 2));

if (result.status === 'failed') {
  process.exit(1);
}
