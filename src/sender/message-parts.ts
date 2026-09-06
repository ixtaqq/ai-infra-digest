/** Plan complete HTML messages, including continuation labels and reopened tags. */
export function planMessageParts(text: string, limit = 4096): string[] {
  if (text.length <= limit) return [text];
  // Reserve enough space even for large part counts. Count raw UTF-16 units,
  // which is conservative relative to Telegram's post-entity text limit.
  const budget = limit - 64;
  if (budget < 32) throw new RangeError("Message limit is too small");
  const stack: { name: string; open: string }[] = [];
  const parts: string[] = [];
  let current = "";
  let hasContent = false;
  const closing = () => [...stack].reverse().map(tag => `</${tag.name}>`).join("");
  const flush = () => {
    if (!hasContent) throw new Error("HTML markup exceeds message limit");
    parts.push(current + closing());
    current = stack.map(tag => tag.open).join("");
    hasContent = false;
  };
  // Tags, entities and Unicode code points are indivisible tokens.
  for (const token of text.match(/<[^>]*>|&(?:#[0-9]+|#x[0-9a-f]+|[a-z]+);|[\s\S]/giu) || []) {
    const tag = token.match(/^<(\/)?([a-z][\w-]*)(?:\s[^>]*)?>$/i);
    const extraClose = tag && !tag[1] ? `</${tag[2]}>`.length : 0;
    if (current.length + token.length + closing().length + extraClose > budget) flush();
    if (current.length + token.length + closing().length + extraClose > budget) {
      throw new Error("HTML token exceeds message limit");
    }
    if (tag) {
      if (tag[1]) {
        if (stack.at(-1)?.name !== tag[2]) throw new Error("Unbalanced Telegram HTML");
        stack.pop();
      } else stack.push({ name: tag[2], open: token });
    } else hasContent = true;
    current += token;
  }
  if (stack.length) throw new Error("Unbalanced Telegram HTML");
  if (current) parts.push(current);
  return parts.map((part, i) => i === 0 ? part : `📄 Part ${i + 1}/${parts.length}\n\n${part}`);
}
