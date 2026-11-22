/** Small markdown helpers for consistent, skimmable Discord embed screens. */

export function mdBold(value: string): string {
  return `**${value}**`;
}

export function mdCode(value: string): string {
  return `\`${value}\``;
}

export function mdList(items: readonly string[], bullet = '•'): string {
  return items.map((item) => `${bullet} ${item}`).join('\n');
}

export function mdSection(title: string, body: string): string {
  return `${mdBold(title)}\n${body}`;
}

export function mdParagraphs(...paragraphs: readonly string[]): string {
  return paragraphs.filter((paragraph) => paragraph.length > 0).join('\n\n');
}

export function mdKeyValue(label: string, value: string): string {
  const normalized = label.endsWith(':') ? label : `${label}:`;
  return `${mdBold(normalized)} ${value}`;
}

export function mdKeyValueList(entries: readonly (readonly [string, string])[]): string {
  return entries.map(([label, value]) => mdKeyValue(label, value)).join('\n');
}

/** Bold the label in existing `Label: value` lines without changing the text. */
export function mdLabelLines(lines: readonly string[]): string {
  return lines
    .map((line) => {
      const separator = line.indexOf(':');
      if (separator <= 0) return line;
      return `${mdBold(line.slice(0, separator + 1))}${line.slice(separator + 1)}`;
    })
    .join('\n');
}
