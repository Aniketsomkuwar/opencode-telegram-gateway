const FENCE = /^\s*(```|~~~)\s*([\w+-]*)\s*$/;

/**
 * Split text so that no part exceeds `limit` characters.
 * Boundaries are preferred at blank lines, then newlines, then spaces, and a cut
 * is never left inside a fenced code block: the block is closed and reopened.
 */
export function splitMessage(input: string, limit = 4000): string[] {
  const text = String(input ?? '');
  if (text.length <= limit) return [text];

  const parts: string[] = [];
  const lines = text.split('\n');
  let buffer = '';
  let fence: string | null = null;

  const flush = (): void => {
    if (!buffer.trim()) {
      buffer = '';
      return;
    }
    if (fence) {
      const closed = `${buffer}\n\`\`\``;
      parts.push(closed.length <= limit ? closed : buffer);
      buffer = fence;
    } else {
      parts.push(buffer);
      buffer = '';
    }
  };

  for (const line of lines) {
    const fenceMatch = FENCE.exec(line);
    const candidate = buffer ? `${buffer}\n${line}` : line;

    if (candidate.length <= limit) {
      buffer = candidate;
      if (fenceMatch) fence = fence ? null : line.trim().split(/\s+/)[0] + (fenceMatch[2] ? fenceMatch[2] : '');
      continue;
    }

    flush();

    if (line.length + buffer.length + 1 <= limit) {
      buffer = buffer ? `${buffer}\n${line}` : line;
      if (fenceMatch) fence = fence ? null : line.trim();
      continue;
    }

    // A single line is longer than the limit: hard-split it, keeping fences balanced.
    let rest = line;
    while (rest.length > 0) {
      const overhead = (fence ? fence.length + 1 : 0) + 4;
      const room = Math.max(200, limit - buffer.length - overhead - 1);
      if (rest.length <= room) {
        buffer = buffer ? `${buffer}\n${rest}` : rest;
        break;
      }
      const slice = rest.slice(0, room);
      const cut = Math.max(slice.lastIndexOf(' '), slice.lastIndexOf(','), slice.lastIndexOf(';'));
      const piece = cut > room * 0.6 ? slice.slice(0, cut) : slice;
      buffer = buffer ? `${buffer}\n${piece}` : piece;
      rest = rest.slice(piece.length).replace(/^[ \t]+/, '');
      flush();
      if (!rest) break;
    }
  }

  if (buffer.trim()) {
    if (fence && !buffer.trimEnd().endsWith('```')) parts.push(`${buffer}\n\`\`\``);
    else parts.push(buffer);
  }
  return parts.map((part) => part.trimEnd()).filter((part) => part.length > 0);
}

/** True when the text contains an unbalanced code fence. */
export function hasOpenFence(text: string): boolean {
  let open = false;
  for (const line of text.split('\n')) {
    if (FENCE.test(line)) open = !open;
  }
  return open;
}
