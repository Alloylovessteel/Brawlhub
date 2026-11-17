#!/usr/bin/env node
// Verifies that private credential values are absent from built browser assets.
// Usage: npm run verify:secrets (run after npm run build).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STATIC_DIR = path.join(ROOT, 'apps', 'web', '.next', 'static');
const ENV_FILE = path.join(ROOT, '.env');

const PRIVATE_VARS = [
  'SUPABASE_SERVICE_ROLE_KEY',
  'DATABASE_URL',
  'BRAWL_STARS_API_KEY',
  'SYNC_SECRET',
  'DISCORD_TOKEN',
  'DISCORD_CLIENT_SECRET',
];

function loadDotEnv(filePath) {
  const values = {};
  let contents;
  try {
    contents = fs.readFileSync(filePath, 'utf8');
  } catch {
    return values;
  }

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const match = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match) continue;
    let value = match[2].trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    } else {
      const commentAt = value.indexOf(' #');
      if (commentAt !== -1) value = value.slice(0, commentAt).trim();
    }
    values[match[1]] = value;
  }
  return values;
}

function walk(directory) {
  if (!fs.existsSync(directory)) return [];
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...walk(fullPath));
    else if (entry.isFile()) files.push(fullPath);
  }
  return files;
}

const env = loadDotEnv(ENV_FILE);
const secrets = PRIVATE_VARS.map((name) => ({
  name,
  value: process.env[name]?.trim() || env[name]?.trim() || '',
})).filter(({ value }) => value.length >= 8 && !value.startsWith('your-'));

const assets = walk(STATIC_DIR);
if (assets.length === 0) {
  console.error('[verify:secrets] No browser assets found. Run npm run build first.');
  process.exit(1);
}

const findings = [];
for (const asset of assets) {
  const contents = fs.readFileSync(asset, 'utf8');
  for (const secret of secrets) {
    if (contents.includes(secret.value)) {
      findings.push(`${secret.name} in ${path.relative(ROOT, asset)}`);
    }
  }
}

if (findings.length > 0) {
  console.error('[verify:secrets] Private credential values found in browser assets:');
  for (const finding of findings) console.error(`  - ${finding}`);
  process.exit(1);
}

console.log(
  `[verify:secrets] OK: scanned ${assets.length} browser assets; no private credential values found.`,
);
