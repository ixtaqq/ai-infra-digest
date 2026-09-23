"use strict";
const readerConfig = window.GOLDIRHAM_SUPABASE_CONFIG || {};
const element = id => document.getElementById(id);
const textNode = (tag, text, className) => {
  const node = document.createElement(tag); node.textContent = text || '';
  if (className) node.className = className;
  return node;
};
const readerQuery = (table, opts) => {
  if (!readerConfig.url || !readerConfig.key) throw new Error('The briefing is temporarily unavailable. Please try again later.');
  return GoldirhamData.query(readerConfig.url, readerConfig.key, table, opts);
};
function sourceLink(url, label) {
  try {
    const parsed = new URL(url);
    if (!['https:', 'http:'].includes(parsed.protocol)) return textNode('span', 'Source link unavailable');
    const link = textNode('a', label); link.href = parsed.href; link.target = '_blank'; link.rel = 'noopener noreferrer'; return link;
  } catch { return textNode('span', 'Source link unavailable'); }
}
function storyCard(story) {
  const card = textNode('article', '', 'story');
  card.append(textNode('p', [story.category, story.source, story.impact].filter(Boolean).join(' · '), 'meta'));
  card.append(textNode('h3', story.title)); card.append(textNode('p', story.summary));
  if (story.reason) card.append(textNode('p', story.reason));
  if (story.bearCase) { const counter = textNode('div', '', 'counter'); counter.append(textNode('strong', 'Counterargument'), textNode('p', story.bearCase)); card.append(counter); }
  card.append(sourceLink(story.url, 'Read the source ↗'));
  const companies = textNode('p', '', 'meta');
  for (const ticker of story.affectedStocks || []) {
    if (!/^[A-Z]{1,6}([.-][A-Z]{1,2})?$/.test(ticker)) continue;
    const link = textNode('a', ticker); link.href = `?ticker=${encodeURIComponent(ticker)}#company`; companies.append(link);
  }
  card.append(companies); return card;
}
async function loadEdition() {
  element('retry').hidden = true; element('status').textContent = 'Loading the latest briefing…';
  try {
    const [edition] = await readerQuery('public_editions', { order: 'publication_date.desc', limit: 1 });
    if (!edition) { element('status').textContent = 'The first edition has not been published yet. Please check back later.'; return; }
    element('date').textContent = `Edition ${edition.publication_date}`; element('date').dateTime = edition.publication_date;
    element('summary').textContent = edition.summary; element('outlook').textContent = edition.market_outlook;
    element('stories').replaceChildren(...edition.articles.map(storyCard)); element('edition').hidden = false;
    const age = Date.now() - Date.parse(edition.published_at);
    element('status').textContent = age > 36 * 3600000 ? 'This is the latest available edition. A newer briefing has not yet been published.' : `Published ${new Date(edition.published_at).toLocaleString()}`;
  } catch (error) { element('status').textContent = error.message; element('retry').hidden = false; }
}
let companyRevision = 0;
async function loadCompany(ticker) {
  ticker = ticker.trim().toUpperCase();
  if (!/^[A-Z]{1,6}([.-][A-Z]{1,2})?$/.test(ticker)) { element('company-status').textContent = 'Enter a valid company ticker, such as NVDA.'; return; }
  const revision = ++companyRevision;
  element('ticker').value = ticker; element('company-status').textContent = `Loading ${ticker} evidence…`; element('evidence').replaceChildren();
  const url = new URL(location.href); url.searchParams.set('ticker', ticker); history.replaceState(null, '', url);
  const since = new Date(Date.now() - 90 * 86400000).toISOString();
  const requests = [
    ['Coverage from the last 90 days', 'articles', { select: 'title,url,source,summary,reason,bear_case,created_at', order: 'created_at.desc,id.desc', limit: 100, params: { affected_stocks: `cs.{${ticker}}`, created_at: `gte.${since}` } }],
    ['Filing extracts', 'sec_filings', { order: 'filing_date.desc,id.desc', limit: 20, params: { ticker: `eq.${ticker}` } }],
    ['Thesis history', 'ticker_thesis_history', { order: 'week_of.desc', limit: 12, params: { ticker: `eq.${ticker}` } }],
    ['Latest price snapshot', 'stock_prices', { order: 'date.desc', limit: 1, params: { ticker: `eq.${ticker}` } }],
  ];
  const results = await Promise.allSettled(requests.map(([, table, opts]) => readerQuery(table, opts)));
  if (revision !== companyRevision) return;
  element('company-status').textContent = `${ticker} — dated evidence, newest first. Interpretations may change as new sources arrive.`;
  results.forEach((result, index) => {
    const section = textNode('section', '', 'story'); section.append(textNode('h3', requests[index][0]));
    if (result.status === 'rejected') section.append(textNode('p', 'This evidence could not load. Submit the ticker again to retry.'));
    else if (!result.value.length) section.append(textNode('p', 'No evidence is available in this view.'));
    else {
      const rows = result.value;
      if (rows.length === requests[index][2].limit && index !== 3) section.append(textNode('p', `Showing the latest ${rows.length} records. More may exist in the research desk.`));
      for (const row of rows) {
        const item = textNode('details', '');
        item.append(textNode('summary', `${row.filing_date || row.week_of || row.date || row.created_at?.slice(0,10)} · ${row.title || row.form_type || ticker}`));
        const fields = index === 0 ? ['summary','reason','bear_case'] : index === 1 ? ['impact_rationale','capex_source','ai_revenue_source','guidance_text'] : index === 2 ? ['bull_case','bear_case','key_drivers'] : ['price','change_percent'];
        for (const field of fields) if (row[field] != null) item.append(textNode('p', `${field.replaceAll('_',' ')}: ${Array.isArray(row[field]) ? row[field].join('; ') : row[field]}`));
        const link = row.url || row.primary_document_url;
        if (link) item.append(sourceLink(link, 'View source ↗'));
        section.append(item);
      }
    }
    element('evidence').append(section);
  });
}
element('retry').addEventListener('click', loadEdition);
element('company-form').addEventListener('submit', event => { event.preventDefault(); void loadCompany(element('ticker').value); });
void loadEdition();
const initialTicker = new URL(location.href).searchParams.get('ticker');
if (initialTicker) void loadCompany(initialTicker);
