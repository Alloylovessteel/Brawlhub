import packageMetadata from '../../../../package.json';

const COMMIT_ENV_NAMES = ['BRAWLHUB_COMMIT', 'GIT_COMMIT', 'COMMIT_SHA'] as const;
const COMMIT_PATTERN = /^[0-9a-f]{7,40}$/i;

export const APPLICATION_VERSION: string = packageMetadata.version;

/** Return a validated, non-sensitive build label. */
export function applicationVersionLabel(): string {
  for (const name of COMMIT_ENV_NAMES) {
    const raw = process.env[name]?.trim();
    if (raw !== undefined && COMMIT_PATTERN.test(raw)) {
      return `v${APPLICATION_VERSION} (${raw.slice(0, 12)})`;
    }
  }
  return `v${APPLICATION_VERSION}`;
}
