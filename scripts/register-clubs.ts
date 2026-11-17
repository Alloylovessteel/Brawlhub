// Register real club tags before running sync.
// Usage: npm run clubs:register -- '#TAG1' '#TAG2'
import { config as loadEnv } from 'dotenv';
import { resolve } from 'node:path';
import { registerClubs } from '@brawlhub/sync';

loadEnv({ path: resolve(process.cwd(), '.env') });

const tags = process.argv.slice(2);
const result = await registerClubs(tags);
console.log(JSON.stringify(result, null, 2));

// The empty-tag entry is an advisory about the supported 11–20 club range,
// not a failed registration. Only real tag failures are fatal.
const hardRejections = result.rejected.filter((item) => item.tag !== '');
if (result.registered === 0 && hardRejections.length > 0) {
  process.exit(1);
}
