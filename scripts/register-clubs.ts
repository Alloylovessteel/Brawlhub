// Register real club tags before running sync.
// Usage: npm run clubs:register -- '#TAG1' '#TAG2'
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { registerClubs } from '@brawlhub/sync';

loadEnv({ path: resolve(process.cwd(), '.env') });

const tags = process.argv.slice(2);
const result = await registerClubs(tags);
console.log(JSON.stringify(result, null, 2));

if (result.rejected.length > 0) {
  process.exit(1);
}
