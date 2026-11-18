#!/usr/bin/env node
// Safely update one KEY=value entry in a local env file.
// Usage: node scripts/set-env-value.mjs DATABASE_URL
// The value is prompted for with echo disabled when running in a TTY.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const key = process.argv[2];
if (key === undefined || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
  console.error('Usage: node scripts/set-env-value.mjs ENV_KEY');
  process.exit(1);
}

const fileArgumentIndex = process.argv.indexOf('--file');
const envPath =
  fileArgumentIndex >= 0 && process.argv[fileArgumentIndex + 1] !== undefined
    ? path.resolve(process.argv[fileArgumentIndex + 1])
    : path.join(ROOT, '.env');

function readHiddenValue(prompt) {
  return new Promise((resolve, reject) => {
    process.stdout.write(prompt);

    if (!process.stdin.isTTY || typeof process.stdin.setRawMode !== 'function') {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      rl.question('', (answer) => {
        rl.close();
        resolve(answer);
      });
      return;
    }

    const stdin = process.stdin;
    let value = '';
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding('utf8');

    const finish = () => {
      stdin.setRawMode(false);
      stdin.pause();
      stdin.off('data', onData);
      process.stdout.write('\n');
      resolve(value);
    };

    const onData = (chunk) => {
      const text = String(chunk);
      for (const char of text) {
        if (char === '\r' || char === '\n') {
          finish();
          return;
        }
        if (char === '\u0003') {
          stdin.setRawMode(false);
          stdin.pause();
          process.stdout.write('\n');
          reject(new Error('Cancelled'));
          return;
        }
        if (char === '\u0008' || char === '\u007f') {
          value = value.slice(0, -1);
          continue;
        }
        if (char < ' ') {
          continue;
        }
        value += char;
      }
    };

    stdin.on('data', onData);
  });
}

async function main() {
  let value;
  let source = 'prompt';

  if (process.env.NEW_VALUE !== undefined) {
    value = process.env.NEW_VALUE;
    source = 'NEW_VALUE';
  } else if (process.env.NEW_VALUE_FILE !== undefined) {
    const secretPath = path.resolve(process.env.NEW_VALUE_FILE);
    value = fs.readFileSync(secretPath, 'utf8').replace(/\r?\n$/, '');
    fs.unlinkSync(secretPath);
    source = 'NEW_VALUE_FILE';
  } else {
    value = await readHiddenValue(`New value for ${key} (input hidden): `);
  }

  if (value.trim() === '') {
    throw new Error('Refusing to write an empty value');
  }

  const original = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
  const lines = original.split(/\r?\n/);
  const pattern = new RegExp(`^\\s*${key}\\s*=`);
  let updated = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (pattern.test(lines[i])) {
      lines[i] = `${key}=${value}`;
      updated = true;
      break;
    }
  }

  if (!updated) {
    if (lines.length > 0 && lines.at(-1) === '') {
      lines[lines.length - 1] = `${key}=${value}`;
      lines.push('');
    } else {
      lines.push(`${key}=${value}`);
    }
  }

  const newline = original.includes('\r\n') ? '\r\n' : '\n';
  fs.writeFileSync(envPath, lines.join(newline), { encoding: 'utf8', mode: 0o600 });
  console.log(`Updated ${key} in ${path.relative(ROOT, envPath)} from ${source} (value hidden).`);
}

main().catch((error) => {
  console.error(`[env] ${error instanceof Error ? error.message : 'Unknown error'}`);
  process.exit(1);
});
