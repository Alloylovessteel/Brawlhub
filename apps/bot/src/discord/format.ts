/** Small, pure helpers for safe Discord embed formatting. */

/** Escape characters that would otherwise alter Discord markdown. */
export function escapeMarkdown(value: string): string {
  return value.replace(/([\\`*_~|>`])/g, '\\$1');
}

/** Format an integer with thousands separators. Returns null for unusable values. */
export function formatInteger(value: number | null | undefined): string | null {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return null;
  }
  return Math.trunc(value).toLocaleString('en-US');
}

/** Normalise a Brawl Stars tag for use in a URL or display. */
export function cleanTag(value: string): string {
  return value.trim().replace(/^#+/, '').toUpperCase();
}

/** Render a Discord custom emoji from a configurable snowflake ID. */
export function formatEmoji(id: string | undefined, name = 'brawlhub'): string {
  return id === undefined || !/^\d{17,20}$/.test(id) ? '' : `<:${name}:${id}>`;
}

/**
 * Render a player name as a markdown link when a profile URL template is
 * configured. The template must contain `{tag}`.
 */
function formatTaggedLink(
  name: string,
  tag: string,
  urlTemplate: string | undefined,
): string {
  const safeName = escapeMarkdown(name);
  if (urlTemplate === undefined || !urlTemplate.includes('{tag}')) {
    return safeName;
  }

  const encodedTag = encodeURIComponent(cleanTag(tag));
  return `[${safeName}](${urlTemplate.replaceAll('{tag}', encodedTag)})`;
}

export function formatPlayerLink(
  name: string,
  tag: string,
  urlTemplate: string | undefined,
): string {
  return formatTaggedLink(name, tag, urlTemplate);
}

/** Render a club name as a markdown link only when a club URL template is configured. */
export function formatClubLink(
  name: string,
  tag: string,
  urlTemplate: string | undefined,
): string {
  return formatTaggedLink(name, tag, urlTemplate);
}
