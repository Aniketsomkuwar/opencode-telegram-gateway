const TABLE_RULE = /^\s*\|?[\s:|-]*-[\s:|-]*\|?[\s:|-]*$/;

export function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, '');
}

/** Telegram has no table rendering: turn table rows into readable bullets. */
export function formatForTelegram(input: string): string {
  const out: string[] = [];
  for (const line of stripAnsi(String(input ?? '')).replace(/\r\n/g, '\n').split('\n')) {
    if (TABLE_RULE.test(line) && line.includes('-') && line.includes('|')) continue;
    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line
        .trim()
        .replace(/^\|/, '')
        .replace(/\|$/, '')
        .split('|')
        .map((cell) => cell.trim())
        .filter(Boolean);
      if (cells.length >= 2) {
        out.push(`- ${cells[0]}: ${cells.slice(1).join(' / ')}`);
        continue;
      }
    }
    out.push(line);
  }
  return out
    .join('\n')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Escape characters that legacy Markdown treats as formatting. */
export function escapeMd(text: unknown): string {
  return String(text ?? '').replace(/[*_`[\]]/g, (character) => `\\${character}`);
}

/** Escape MarkdownV2 special characters. */
export function escapeMdV2(text: unknown): string {
  return String(text ?? '').replace(/[_*[\]()~`>#+\-=|{}.!\\]/g, (character) => `\\${character}`);
}

export function codeBlock(text: string, language = ''): string {
  const fence = text.includes('```') ? '````' : '```';
  return `${fence}${language}\n${text}\n${fence}`;
}
