import { describe, expect, it } from 'vitest';
import {
  mdBold,
  mdCode,
  mdKeyValue,
  mdKeyValueList,
  mdLabelLines,
  mdList,
  mdParagraphs,
  mdSection,
} from './embed-format';

describe('embed formatting helpers', () => {
  it('builds compact markdown primitives', () => {
    expect(mdBold('Title')).toBe('**Title**');
    expect(mdCode('#8Q0L2G2')).toBe('`#8Q0L2G2`');
    expect(mdKeyValue('Status:', 'Active')).toBe('**Status:** Active');
  });

  it('builds bullet and section layouts', () => {
    expect(mdList(['one', 'two'])).toBe('• one\n• two');
    expect(mdSection('Details', '• one')).toBe('**Details**\n• one');
    expect(mdParagraphs('first', '', 'second')).toBe('first\n\nsecond');
  });

  it('formats key/value lines without dropping text', () => {
    expect(mdKeyValueList([['Tag', '#ABC'], ['Members', '12']])).toBe(
      '**Tag:** #ABC\n**Members:** 12',
    );
    expect(mdLabelLines(['Start: today', 'No label here'])).toBe(
      '**Start:** today\nNo label here',
    );
  });
});
