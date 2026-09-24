import type { Article } from "../collector/rss";

export function selectSourceDiverseArticles(articles: Article[], limit = 35): Article[] {
  const groups = new Map<string, Article[]>();
  for (const article of [...articles].sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())) {
    const group = groups.get(article.source) ?? [];
    group.push(article); groups.set(article.source, group);
  }
  const selected: Article[] = [];
  const queues = [...groups.values()];
  while (selected.length < limit && queues.some(queue => queue.length)) {
    for (const queue of queues) {
      const article = queue.shift();
      if (article) selected.push(article);
      if (selected.length >= limit) break;
    }
  }
  return selected;
}
