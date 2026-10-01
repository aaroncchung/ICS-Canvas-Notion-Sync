/** True when `index` falls between the halves of a surrogate pair. */
export function isSurrogateBoundary(content: string, index: number): boolean {
  const high = content.charCodeAt(index - 1);
  const low = content.charCodeAt(index);
  return high >= 0xd800 && high <= 0xdbff && low >= 0xdc00 && low <= 0xdfff;
}

/**
 * `content.slice(start, end)` for non-negative bounds, narrowed so that neither end keeps half of
 * a surrogate pair. Notion rejects text with a lone surrogate, so every cut of text it may store
 * goes through here.
 */
export function sliceText(content: string, start: number, end = content.length): string {
  const from = isSurrogateBoundary(content, start) ? start + 1 : start;
  const to = isSurrogateBoundary(content, end) ? end - 1 : end;
  return content.slice(from, Math.max(from, to));
}

/** The first `limit` UTF-16 units of `content`, or one fewer when the cut would split an emoji. */
export function truncateText(content: string, limit: number): string {
  return sliceText(content, 0, limit);
}
