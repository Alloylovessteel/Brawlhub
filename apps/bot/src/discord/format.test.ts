import { describe, expect, it } from 'vitest';
import {
  cleanTag,
  escapeMarkdown,
  formatEmoji,
  formatInteger,
  formatPlayerLink,
} from './format';

describe('embed formatting helpers', () => {
  it('formats integers with thousands separators', () => {
    expect(formatInteger(1234567)).toBe('1,234,567');
    expect(formatInteger(0)).toBe('0');
    expect(formatInteger(null)).toBeNull();
    expect(formatInteger(Number.NaN)).toBeNull();
  });

  it('normalises tags for URLs and display', () => {
    expect(cleanTag(' #2ug9ugqjy ')).toBe('2UG9UGQJY');
  });

  it('renders configurable custom emojis only for valid snowflakes', () => {
    expect(formatEmoji('123456789012345678', 'trophy')).toBe('<:trophy:123456789012345678>');
    expect(formatEmoji('abc')).toBe('');
    expect(formatEmoji(undefined)).toBe('');
  });

  it('links player names when a profile template is configured', () => {
    expect(formatPlayerLink('Zen', '#2UG9UGQJY', 'https://example.com/player/{tag}'))
      .toBe('[Zen](https://example.com/player/2UG9UGQJY)');
  });

  it('keeps player names plain when no template is configured', () => {
    expect(formatPlayerLink('Zen', '#2UG9UGQJY', undefined)).toBe('Zen');
  });

  it('escapes markdown in player names', () => {
    expect(formatPlayerLink('A|B', '#TAG', undefined)).toBe('A\\|B');
    expect(escapeMarkdown('a_b*c')).toBe('a\\_b\\*c');
  });
});
