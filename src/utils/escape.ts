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
 */
export function stripHtmlTags(text: string): string {
  return text.replace(/<[^>]*>/g, "");
}
