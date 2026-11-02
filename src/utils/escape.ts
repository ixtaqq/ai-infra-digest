/** Escape text for safe interpolation into Telegram HTML-parse-mode messages. */
export function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Strip HTML tags from untrusted external text (RSS titles/content). Applied at
 * collection time as defense-in-depth: escapeHtml() at render time is the primary
 * defense, but this ensures markup from a hostile feed never survives into the AI
 * prompt or downstream storage in the first place, even if it's echoed back
 * verbatim by the model or reaches a call site that forgets to escape.
 *
 * Scans once with a stack of open "<" positions. Removing a tag can expose another
 * (<<b>script>), and re-running a regex until stable is quadratic on hostile feeds.
 */
export function stripHtmlTags(text: string): string {
  const kept: string[] = [];
  const opens: number[] = [];
  const startsTag = (open: number) => {
    const name = kept[open + 1] === "/" ? kept[open + 2] : kept[open + 1];
    return name !== undefined && /[a-zA-Z]/.test(name);
  };
  for (const char of text) {
    if (char === ">") {
      const open = opens.pop();
      if (open !== undefined && startsTag(open)) {
        kept.length = open;
        continue;
      }
      opens.length = 0;
    } else if (char === "<") {
      opens.push(kept.length);
    }
    kept.push(char);
  }
  return kept.join("");
}
