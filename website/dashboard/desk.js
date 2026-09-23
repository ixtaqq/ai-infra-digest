/* ══════════════════════════════════════════════════
       JavaScript — Goldirham Dashboard
       ══════════════════════════════════════════════════ */

    // Vercel generates this small config artifact at build time from deployment
    // environment variables. It is intentionally absent from Git so client keys
    // never become repository content; RLS remains the browser security boundary.
    const DEFAULT_SUPABASE_CONFIG = Object.freeze(
      typeof window !== 'undefined' && window.GOLDIRHAM_SUPABASE_CONFIG
        ? window.GOLDIRHAM_SUPABASE_CONFIG
        : { url: '', key: '' }
    );
    function isSafeClientKey(key) {
      if (/^sb_publishable_[A-Za-z0-9_]+$/.test(key || '')) return true;
      try {
        const part = String(key).split('.')[1];
        if (!part) return false;
        const normalized = part.replace(/-/g, '+').replace(/_/g, '/');
        const payload = JSON.parse(atob(normalized + '='.repeat((4 - normalized.length % 4) % 4)));
        return payload.role === 'anon';
      } catch {
        return false;
      }
    }
    function isSafeSupabaseUrl(url) {
      try { return new URL(url).protocol === 'https:'; } catch { return false; }
    }
    function readSupabaseConfig() {
      try {
        const storedUrl = (localStorage.getItem('supabase_url') || '').trim().replace(/\/$/, '');
        const storedKey = (localStorage.getItem('supabase_anon_key') || '').trim();
        if (isSafeSupabaseUrl(storedUrl) && isSafeClientKey(storedKey)) return { url: storedUrl, key: storedKey };
      } catch {}
      return DEFAULT_SUPABASE_CONFIG;
    }
    const SUPABASE_CONFIG = readSupabaseConfig();
    let SUPABASE_URL = SUPABASE_CONFIG.url;
    let SUPABASE_ANON_KEY = SUPABASE_CONFIG.key;
    let charts = {};
    let stockPriceDataCache = [];
    let allArticlesCache = [];
    let allSectors = [];
    let searchDebounceTimer = null;
    let articlePage = 0;
    let articleRevision = 0;
    let dashboardRevision = 0;
    const ARTICLES_PAGE_SIZE = 20;
    const ARTICLE_SELECT = 'id,title,url,source,impact,impact_score,effective_score,ranking_explanation,is_sec_filing,category,affected_stocks,summary,reason,bear_case,thumbs_up,thumbs_down,created_at';
    const DAILY_METRICS_SELECT = 'date,total_articles_processed,total_stocks_tracked,sectors_active,feeds_healthy,feeds_failing,total_tokens_used,estimated_cost,total_capex_announced,top_sector,top_ticker,digest_status,created_at,sec_filings_processed,sec_capex_total,sec_ai_revenue_total,trending_json,trending_entities';
    const FEEDBACK_DAILY_SELECT = 'feedback_date,total_votes,rating_sum,rating_1_count,rating_2_count,rating_3_count,rating_4_count,rating_5_count,comment_count,updated_at';
    let allFetchedArticles = [];
    let hasMoreArticles = true;
    let articleSearchQuery = '';
    let articleSearchTotal = null;
    let dashboardPartialErrors = [];

    let activeFilters = (() => {
      try { return { sector: null, impact: null, search: '', ...JSON.parse(localStorage.getItem('savedFilters') || '{}') }; }
      catch { return { sector: null, impact: null, search: '' }; }
    })();
    function saveFilters() {
      try { localStorage.setItem('savedFilters', JSON.stringify(activeFilters)); } catch {}
    }

    const SECTION_ANCHORS = {
      overview: 'section-overview',
      pipeline: 'section-pipeline',
      stocks: 'section-stocks',
      sec: 'secSectionCard',
      articles: 'section-articles',
      feedback: 'section-feedback',
    };
    function switchSection(id, el) {
      document.querySelectorAll('.sidebar-link').forEach(l => {
        l.classList.remove('active');
        l.removeAttribute('aria-current');
      });
      if (el) {
        el.classList.add('active');
        el.setAttribute('aria-current', 'location');
      }
      const target = document.getElementById(SECTION_ANCHORS[id]);
      if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }

    // Orange → lime ramp, matching the landing page palette.
    const TICKER_COLORS = [
      '#a44e35', '#70876a', '#9a7850', '#697e85', '#8f6d78',
      '#a28642', '#f59e0b',
      '#ef4444', '#567d77',
      '#d97706', '#71814a',
    ];

    const SECTOR_COLORS = {
      'Chips & GPUs': '#a44e35', 'Cloud & Hyperscalers': '#70876a',
      'Datacenters': '#9a7850', 'Networking': '#697e85',
      'Power & Utilities': '#8f6d78', 'Cooling Infrastructure': '#71814a',
      'AI Models & Labs': '#a28642', 'Semiconductor Manufacturing': '#ef4444',
      'M&A and Partnerships': '#f59e0b', 'Earnings & Guidance': '#d97706',
    };

    if (typeof Chart !== 'undefined') {
      Chart.defaults.font.family = "'Manrope', sans-serif";
      Chart.defaults.font.size = 11;
    }

    // ─── Date / Greeting ──
    function updateGreeting() {
      const now = new Date();
      const days = ['SUNDAY','MONDAY','TUESDAY','WEDNESDAY','THURSDAY','FRIDAY','SATURDAY'];
      const months = ['JANUARY','FEBRUARY','MARCH','APRIL','MAY','JUNE','JULY','AUGUST','SEPTEMBER','OCTOBER','NOVEMBER','DECEMBER'];
      const el = document.getElementById('headerDate');
      if (el) el.textContent = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]} ${now.getFullYear()}`;
      const el2 = document.getElementById('dateRow');
      if (el2) el2.textContent = `${days[now.getDay()]}, ${now.getDate()} ${months[now.getMonth()]}`;
      const h = now.getHours();
      const greet = h < 12 ? 'morning' : h < 17 ? 'afternoon' : 'evening';
      document.querySelectorAll('.greeting-section h1, .header-greeting').forEach(el => {
        const inner = `Good ${greet}, <span class="gold">Analyst</span>.`;
        // the big heading gets the masked rise-in; the compact header one doesn't
        el.innerHTML = el.tagName === 'H1' ? `<span class="rise">${inner}</span>` : inner;
      });
    }
    updateGreeting();

    // ─── Theme toggle ──
    function toggleTheme() {
      const glow = document.getElementById('bgGlow');
      glow.style.opacity = glow.style.opacity === '0' ? '0.5' : '0';
    }

    // ─── Config ──
    function showConfig() {
      const panel = document.getElementById('configPanel');
      const open = panel.style.display === 'none';
      panel.style.display = open ? 'block' : 'none';
      document.getElementById('configToggle')?.setAttribute('aria-expanded', String(open));
      if (!open) return;
      panel.innerHTML = `
        <div class="config-form">
          <h2>Connect your research desk.</h2><p class="config-intro">Bring your Goldirham data into view. Connect a public data source to explore articles, sector activity, and company filings.</p>
          <label for="cfgUrl">Supabase URL</label>
          <input id="cfgUrl" value="${escapeHtml(SUPABASE_URL)}" placeholder="https://xxx.supabase.co" spellcheck="false" autocomplete="url">
          <label for="cfgKey">Anon Public Key</label>
          <input id="cfgKey" type="password" value="${escapeHtml(SUPABASE_ANON_KEY)}" placeholder="eyJhbGciOiJ..." spellcheck="false" autocomplete="off">
          <p id="cfgError" class="note" role="alert" style="display:none;color:var(--danger)"></p>
          <button type="button" data-action="save">Save &amp; Reload</button>
          <p class="note">Use only the public anon or publishable key. RLS protects the read-only dashboard; never enter a service-role key.</p>
        </div>
      `;
    }
    function saveConfig() {
      const url = document.getElementById('cfgUrl').value.trim().replace(/\/$/, '');
      const key = document.getElementById('cfgKey').value.trim();
      const error = document.getElementById('cfgError');
      if (!isSafeSupabaseUrl(url) || !isSafeClientKey(key)) {
        error.textContent = 'Enter an HTTPS Supabase URL and a public anon or publishable key. Service-role keys are blocked.';
        error.style.display = 'block';
        return;
      }
      SUPABASE_URL = url;
      SUPABASE_ANON_KEY = key;
      localStorage.setItem('supabase_url', SUPABASE_URL);
      localStorage.setItem('supabase_anon_key', SUPABASE_ANON_KEY);
      document.getElementById('configPanel').style.display = 'none';
      document.getElementById('configToggle')?.setAttribute('aria-expanded', 'false');
      loadDashboard();
    }

    // ─── Supabase Query ──
    async function supabaseQuery(table, opts = {}) {
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error('The research desk is temporarily unavailable. Please try again later.');
      return opts.allPages
        ? GoldirhamData.allPages(SUPABASE_URL, SUPABASE_ANON_KEY, table, opts)
        : GoldirhamData.query(SUPABASE_URL, SUPABASE_ANON_KEY, table, opts);
    }

    function normalizeSearchQuery(value) {
      return String(value || '')
        .replace(/[^a-z0-9\s._-]/gi, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 80);
    }
    async function fetchArticlePage(query = '', offset = 0) {
      const safeQuery = normalizeSearchQuery(query);
      const safeOffset = Math.max(0, Number(offset) || 0);
      const params = new URLSearchParams({
        select: ARTICLE_SELECT,
        order: 'effective_score.desc.nullslast,impact_score.desc,created_at.desc,id.desc',
        limit: String(ARTICLES_PAGE_SIZE + 1),
        offset: String(safeOffset),
      });
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const url = safeQuery
          ? `${SUPABASE_URL}/rest/v1/rpc/search_articles`
          : `${SUPABASE_URL}/rest/v1/articles?${params.toString()}`;
        const res = await fetch(url, {
          method: safeQuery ? 'POST' : 'GET',
          headers: {
            apikey: SUPABASE_ANON_KEY,
            Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
            ...(safeQuery ? { 'Content-Type': 'application/json' } : {}),
            Prefer: 'count=exact',
          },
          ...(safeQuery ? {
            body: JSON.stringify({
              p_query: safeQuery,
              p_limit: ARTICLES_PAGE_SIZE,
              p_offset: safeOffset,
            }),
          } : {}),
          signal: controller.signal,
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const payload = await res.json();
        if (safeQuery) {
          const articles = Array.isArray(payload?.articles) ? payload.articles : [];
          const total = Number(payload?.total);
          return {
            articles,
            total: Number.isFinite(total) ? total : null,
            hasMore: Number.isFinite(total) ? safeOffset + articles.length < total : articles.length === ARTICLES_PAGE_SIZE,
          };
        }

        const rows = payload;
        const page = Array.isArray(rows) ? rows : [];
        const contentRange = res.headers.get('content-range') || '';
        const totalPart = contentRange.split('/')[1];
        const total = totalPart && totalPart !== '*' ? Number(totalPart) : null;
        const articles = page.slice(0, ARTICLES_PAGE_SIZE);
        return {
          articles,
          total: Number.isFinite(total) ? total : null,
          hasMore: page.length > ARTICLES_PAGE_SIZE || (Number.isFinite(total) ? safeOffset + articles.length < total : page.length === ARTICLES_PAGE_SIZE),
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    // ─── Helpers ──
    function fmtNum(n) { return (n||0).toLocaleString(); }
    // On the happy path these return a formatted date with no markup. The
    // catch branch hands back the raw DB value, and most call sites drop the
    // result straight into innerHTML — so escape the fallback, not the format.
    function fmtDate(d) { try { return new Date(d).toLocaleDateString('en-MY',{timeZone:'Asia/Kuala_Lumpur'}); } catch { return escapeHtml(d); } }
    function fmtShortDate(d) { try { const dt=new Date(d); return dt.toLocaleDateString('en-MY',{timeZone:'Asia/Kuala_Lumpur',month:'short',day:'numeric'}); } catch { return escapeHtml(d); } }
    function sentimentClass(i) { return i==='Bullish'?'sentiment-bullish':i==='Bearish'?'sentiment-bearish':'sentiment-neutral'; }
    function sentimentArrow(i) { return i==='Bullish'?'▲':i==='Bearish'?'▼':'▬'; }
    function fmtPct(n) { return (n>=0?'+':'')+(n||0).toFixed(1)+'%'; }
    function trClass(n) { return n>0?'trend-up':n<0?'trend-down':'trend-flat'; }
    function escapeHtml(s) { return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
    function safeHref(url) { return /^https?:\/\//i.test(url || '') ? escapeHtml(url) : '#'; }

    function chartGridColor() { return getComputedStyle(document.documentElement).getPropertyValue('--border').trim(); }
    function chartTextColor() { return getComputedStyle(document.documentElement).getPropertyValue('--text-dim').trim(); }

    function createGlassTooltip() {
      return {
        backgroundColor: 'rgba(12,8,5,0.94)',
        borderColor: 'rgba(164,78,53,0.35)',
        borderWidth: 1, padding: 11, cornerRadius: 8,
        titleColor: '#f4efe9',
        titleFont: { family: "'IBM Plex Mono', monospace", size: 11 },
        bodyColor: 'rgba(244,239,233,0.75)',
        bodyFont: { family: "'IBM Plex Mono', monospace", size: 11 },
        boxPadding: 6, usePointStyle: true,
      };
    }
    function setChartFallback(id, text) {
      const fallback = document.getElementById(id);
      if (fallback) fallback.textContent = text;
      const canvas = fallback?.previousElementSibling;
      if (canvas) canvas.setAttribute('aria-label', text);
    }
    function chartsUnavailable(id) {
      if (typeof Chart !== 'undefined') return false;
      setChartFallback(id, 'Charts are unavailable right now; use the accessible data summaries below.');
      return true;
    }

    // ─── KPI Animate ──
    function animateValue(el, start, end, duration = 900) {
      if (!el || isNaN(end) || end <= 0) return;
      const isFloat = !Number.isInteger(end);
      const range = end - start;
      let startTime = null;
      function step(timestamp) {
        if (!startTime) startTime = timestamp;
        const progress = Math.min((timestamp - startTime) / duration, 1);
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = start + range * eased;
        el.textContent = isFloat ? current.toFixed(1) : Math.round(current).toLocaleString();
        if (progress < 1) requestAnimationFrame(step);
      }
      el.textContent = '0';
      requestAnimationFrame(step);
    }

    function animateKPIValues() {
      document.querySelectorAll('.kpi-card').forEach((card, i) => {
        const valueEl = card.querySelector('.kpi-value');
        if (!valueEl) return;
        const raw = valueEl.textContent.replace(/,/g, '').trim();
        if (raw === '—' || raw === '0') return;
        const num = parseFloat(raw);
        if (isNaN(num) || num <= 0) return;
        setTimeout(() => { animateValue(valueEl, 0, num, 900); }, 100 + i * 80);
      });
    }

    // ─── Top Sectors ──
    function renderTopSectors(sectors) {
      const el = document.getElementById('topSectors');
      if (!sectors || !sectors.length) {
        if (el) el.innerHTML = '<div style="font-size:11px;color:var(--text-dim);padding:10px 0">No sector data</div>';
        return;
      }
      const g = {};
      sectors.forEach(s => { if (!g[s.sector]) g[s.sector] = 0; g[s.sector] += s.article_count || 0; });
      const sorted = Object.entries(g).sort((a, b) => b[1] - a[1]).slice(0, 5);
      const max = sorted[0]?.[1] || 1;
      if (el) {
        el.innerHTML = sorted.map(([name, count]) => {
          const pct = (count / max * 100).toFixed(0);
          const color = SECTOR_COLORS[name] || 'var(--gold)';
          return `<div class="plan-row">
            <span class="plan-name" style="font-size:10px">${escapeHtml(name)}</span>
            <div class="plan-bar-wrap"><div class="plan-bar" style="width:${pct}%;background:linear-gradient(90deg,${color},${color}88)"></div></div>
            <span class="plan-amount" style="font-size:10px">${count}</span>
          </div>`;
        }).join('');
      }
    }

    // ─── Main Load ──
    async function queryDashboardData(label, table, opts, errors) {
      try {
        return await supabaseQuery(table, opts);
      } catch (error) {
        errors.push({
          label,
          message: error?.name === 'AbortError' ? 'Request timed out' : (error?.message || 'Request failed'),
        });
        return [];
      }
    }
    function renderPartialLoadErrors(errors) {
      const el = document.getElementById('partialLoadErrors');
      if (!el) return;
      dashboardPartialErrors = errors;
      if (!errors.length) {
        el.hidden = true;
        el.textContent = '';
        return;
      }
      el.innerHTML = `<strong>Some dashboard data could not load.</strong><ul>${errors.map(error => `<li>${escapeHtml(error.label)}: ${escapeHtml(error.message)}</li>`).join('')}</ul>`;
      el.hidden = false;
    }
    function updatePartialLoadError(label, message = '') {
      const errors = dashboardPartialErrors.filter(error => error.label !== label);
      if (message) errors.push({ label, message });
      renderPartialLoadErrors(errors);
    }
    async function loadDashboard() {
      const loading = document.getElementById('loading');
      const content = document.getElementById('content');
      const msg = document.getElementById('loadingMsg');

      if (document.hidden) return;
      if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
        loading.style.display = 'none';
        content.style.display = 'none';
        loading.style.display = 'block'; msg.textContent = 'The research desk is temporarily unavailable. Please try again later.';
        return;
      }
      const revision = ++dashboardRevision;
      const articleRequest = articleRevision;
      const preserveArticleSearch = Boolean(articleSearchQuery) || allFetchedArticles.length > ARTICLES_PAGE_SIZE;

      loading.style.display = 'block';
      msg.textContent = 'Loading dashboard data...';
      if (!allArticlesCache.length) content.style.display = 'none';

      const days = parseInt(document.querySelector('.chart-tabs button.active')?.dataset?.range || '30');
      const rangeDate = new Date(Date.now() - days * 86400000).toISOString().split('T')[0];

      let slowTimer = setTimeout(() => {
        msg.innerHTML = '⏳ Still connecting...';
      }, 8000);

      try {
        const partialErrors = [];
        const [digests, sectors, stocks, articles, feeds, capex, metrics, feedbackDaily, prices, deliveries, secFilings, theses, thesisHistory, rankingQuality] = await Promise.all([
          queryDashboardData('Digest runs', 'digest_runs', { select: 'id,run_date,status,articles_collected,articles_processed,batches_run,total_tokens_used,duration_seconds,created_at,capabilities,degraded_stages', order: 'run_date', limit: 60, rangeColumn: 'run_date', range: rangeDate }, partialErrors),
          queryDashboardData('Sector activity', 'sector_activity', { select: 'date,sector,article_count,avg_impact_score', order: 'date.desc,sector.asc', allPages: true, range: rangeDate }, partialErrors),
          queryDashboardData('Stock mentions', 'rpc/stock_mentions_summary', { params: { p_since: rangeDate } }, partialErrors),
          queryDashboardData('Articles', 'articles', { select: ARTICLE_SELECT, order: 'effective_score.desc.nullslast,impact_score.desc,created_at.desc,id.desc', limit: ARTICLES_PAGE_SIZE }, partialErrors),
          queryDashboardData('Pipeline health', 'rpc/latest_feed_health', { order: 'feed_name.asc', allPages: true }, partialErrors),
          queryDashboardData('Capex tracking', 'capex_tracking', { order: 'date', limit: 10 }, partialErrors),
          queryDashboardData('Daily metrics', 'daily_metrics', { select: DAILY_METRICS_SELECT, order: 'date', limit: 30, range: rangeDate }, partialErrors),
          queryDashboardData('Daily feedback aggregates', 'digest_feedback_daily', { select: FEEDBACK_DAILY_SELECT, order: 'feedback_date', limit: 30, range: rangeDate, rangeColumn: 'feedback_date' }, partialErrors),
          queryDashboardData('Stock prices', 'stock_prices', { order: 'date.desc,ticker.asc', allPages: true, range: rangeDate }, partialErrors),
          queryDashboardData('Delivery metrics', 'delivery_metrics_daily', { order: 'run_date', limit: 100, range: rangeDate, rangeColumn: 'run_date' }, partialErrors),
          queryDashboardData('SEC filings', 'sec_filings', { order: 'filing_date', limit: 50, range: rangeDate, rangeColumn: 'filing_date' }, partialErrors),
          queryDashboardData('Ticker theses', 'ticker_theses', { order: 'confidence', limit: 10 }, partialErrors),
          // v11 — up to ~10 tracked tickers × recent weeks; one batched fetch,
          // no per-ticker query loop. Sorted client-side (see renderThesesSection).
          queryDashboardData('Thesis history', 'ticker_thesis_history', { limit: 100 }, partialErrors),
          queryDashboardData('Ranking quality', 'ranking_quality_daily', { order: 'date', limit: 30 }, partialErrors),
        ]);

        clearTimeout(slowTimer);
        if (revision !== dashboardRevision) return;
        loading.style.display = 'none';
        content.style.display = 'block';
        renderPartialLoadErrors(partialErrors);
        stockPriceDataCache = prices;

        const hasData = digests.length > 0 || articles.length > 0;
        if (!hasData) {
          document.getElementById('kpiGrid').innerHTML = `
            <div class="no-data-card">
              <div style="font-size:32px;margin-bottom:8px">📡</div>
              <div style="font-size:16px;font-weight:700;margin-bottom:6px">No Data Yet</div>
              <div style="font-size:12px;color:var(--text-dim)">The first briefing is being prepared. Please check back later.</div>
            </div>
          `;
        }

        if (!preserveArticleSearch && articleRequest === articleRevision) {
          articlePage = 0;
          articleRevision++;
          articleSearchQuery = '';
          articleSearchTotal = null;
          allArticlesCache = articles;
          allFetchedArticles = articles;
          hasMoreArticles = articles.length === ARTICLES_PAGE_SIZE;
        } else {
          allArticlesCache = allFetchedArticles;
        }
        allSectors = [...new Set(sectors.map(s => s.sector))];

        renderKPI(digests, sectors, metrics, feedbackDaily);
        setTimeout(animateKPIValues, 300);
        renderSectorChart(sectors);
        renderTopSectors(sectors);
        renderStockChart(stocks);
        renderStockPriceChart(prices);
        renderSectorTrendChart(sectors);
        renderCapexChart(metrics);
        renderFeedbackChart(feedbackDaily);
        renderDigestPerformanceChart(digests, metrics);
        renderTokenChart(metrics);
        renderFilterBar();
        applyFilters();
        renderPipeline(feeds);
        renderTrendingSection(metrics);
        renderFeedbackSection(feedbackDaily);
        renderRankingQuality(rankingQuality);
        renderDeliverySection(deliveries);
        renderSECSection(secFilings);
        renderCapex(capex);
        renderThesesSection(theses, thesisHistory);

        const btn = document.getElementById('loadMoreBtn');
        const info = document.getElementById('paginationInfo');
        if (btn) { btn.style.display = hasMoreArticles ? 'inline-flex' : 'none'; btn.disabled = false; btn.textContent = '⬇️ Load More'; }
        if (info) {
          if (preserveArticleSearch) {
            const total = articleSearchTotal == null ? allFetchedArticles.length : articleSearchTotal;
            info.textContent = hasMoreArticles ? `Showing ${allFetchedArticles.length} of ${total}` : `${allFetchedArticles.length} results`;
          } else {
            info.textContent = hasMoreArticles ? `Showing ${articles.length} articles` : `${articles.length} articles`;
          }
        }

        const glow = document.getElementById('bgGlow');
        glow.style.opacity = '0.3';
        setTimeout(() => glow.style.opacity = '0.5', 100);

      } catch (e) {
        clearTimeout(slowTimer);
        if (revision !== dashboardRevision) return;
        loading.style.display = 'none';
        content.style.display = 'block';
        document.getElementById('kpiGrid').innerHTML = `
          <div class="error-box">
            <p style="font-size:14px;margin-bottom:4px">❌ Connection Error</p>
            <p style="font-size:11px;color:var(--text-dim);margin-bottom:10px">${escapeHtml(e.message || 'Unexpected dashboard error')}</p>
            <button data-action="refresh">Retry</button>
            <button data-action="config" style="margin-left:6px;background:var(--bg-card);color:var(--text);border:1px solid var(--border)">⚙ Fix Config</button>
          </div>
        `;
        renderPartialLoadErrors([{ label: 'Dashboard', message: e.message || 'Unexpected dashboard error' }]);
      }
    }

    // ─── KPI ──
    function renderKPI(digests, sectors, metrics, feedbackDaily) {
      const totalDigests = digests.length;
      const successful = digests.filter(d => d.status === 'success').length;
      const failed = digests.filter(d => d.status === 'failed').length;
      const totalArticles = digests.reduce((s, d) => s + (d.articles_processed || 0), 0);
      const activeSectors = new Set(sectors.map(s => s.sector)).size;
      const totalTokens = digests.reduce((s, d) => s + (d.total_tokens_used || 0), 0);

      const totalSum = (feedbackDaily || []).reduce((sum, row) => sum + Number(row.rating_sum || 0), 0);
      const totalVotes = (feedbackDaily || []).reduce((sum, row) => sum + Number(row.total_votes || 0), 0);
      const avgRating = totalVotes > 0 ? (totalSum / totalVotes).toFixed(1) : '—';

      const latest = digests[0];
      const lastRun = latest ? fmtDate(latest.run_date) : '—';
      let trend = '';
      if (digests.length >= 2) {
        const last = digests[0]?.articles_processed || 0;
        const avg = digests.slice(1).reduce((s, d) => s + (d.articles_processed || 0), 0) / (digests.length - 1) || 1;
        const diff = last - avg;
        const pct = Math.round((diff / avg) * 100);
        trend = `<span class="${trClass(diff)}">${diff >= 0 ? '↑' : '↓'} ${Math.abs(pct)}%</span>`;
      }

      const successRate = totalDigests > 0 ? ((successful / totalDigests) * 100).toFixed(0) : '—';

      document.getElementById('kpiGrid').innerHTML = `
        <div class="kpi-card">
          <div class="kpi-label">Digest Runs</div>
          <div class="kpi-value">${totalDigests}</div>
          <div class="kpi-change up"><span style="color:var(--bullish)">●</span> ${successRate}% success <span class="sub">· ${failed} failed</span></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Articles Analyzed</div>
          <div class="kpi-value"><span class="gold">${fmtNum(totalArticles)}</span></div>
          <div class="kpi-change up">Last: ${lastRun} <span class="sub">${trend}</span></div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Sectors Active</div>
          <div class="kpi-value">${activeSectors}</div>
          <div class="kpi-change up">of 10 total</div>
        </div>
        <div class="kpi-card">
          <div class="kpi-label">Avg Feedback</div>
          <div class="kpi-value">${avgRating !== '—' ? avgRating : '—'}</div>
          <div class="kpi-change up">${totalVotes > 0 ? `⭐ ${totalVotes} votes` : '5 ratings needed for summary'}</div>
        </div>
      `;
    }

    // ─── Charts ──
    function renderSectorChart(sectors) {
      if (chartsUnavailable('sectorChartFallback')) return;
      if (charts.sector) charts.sector.destroy();
      const g = {};
      sectors.forEach(s => { if (!g[s.sector]) g[s.sector] = 0; g[s.sector] += s.article_count || 0; });
      const labels = Object.keys(g), data = Object.values(g);
      if (!labels.length) { setChartFallback('sectorChartFallback', 'No sector activity data is available for this range.'); return; }
      const total = data.reduce((s, v) => s + v, 0);
      setChartFallback('sectorChartFallback', `${fmtNum(total)} articles across ${labels.length} sectors. Select a bar to filter the article list.`);
      const el = document.getElementById('sectorChartValue');
      if (el) el.textContent = fmtNum(total);
      const colors = Object.values(SECTOR_COLORS);
      const ctx = document.getElementById('sectorChart').getContext('2d');
      const c = chartTextColor(), gc = chartGridColor();
      const chartLabels = labels;
      charts.sector = new Chart(ctx, {
        type: 'bar',
        data: { labels, datasets: [{ label: 'Articles', data, backgroundColor: colors.slice(0, labels.length), borderRadius: 3, borderSkipped: false }] },
        options: {
          responsive: true,
          onClick: (e, els) => { if (els.length > 0) { const label = chartLabels[els[0].index]; if (label) setFilter('sector', label); } },
          plugins: {
            legend: { display: false },
            tooltip: { ...createGlassTooltip(), callbacks: { label: (ctx) => `${ctx.raw} articles`, afterLabel: (ctx) => { const s = sectors.filter(x => x.sector === ctx.label); return s.length ? `Avg score: ${s[s.length - 1]?.avg_impact_score || '—'}/10` : ''; } } }
          },
          scales: {
            x: { ticks: { color: c, maxRotation: 45 }, grid: { color: gc } },
            y: { ticks: { color: c }, grid: { color: gc }, beginAtZero: true }
          }
        }
      });
    }

    function renderStockChart(stocks) {
      if (chartsUnavailable('stockChartFallback')) return;
      if (charts.stock) charts.stock.destroy();
      const top = stocks.slice(0, 10);
      if (!top.length) { setChartFallback('stockChartFallback', 'No stock mover data is available for this range.'); return; }
      setChartFallback('stockChartFallback', `${top.length} companies ranked by mentions in this range. Bars show their latest daily price change.`);
      const ctx = document.getElementById('stockChart').getContext('2d');
      const c = chartTextColor(), gc = chartGridColor();
      const prices = top.map(s => s.price_change_percent || 0);
      charts.stock = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: top.map(s => s.ticker),
          datasets: [{
            label: 'Price Change %', data: prices,
            backgroundColor: prices.map(p => p >= 0 ? 'rgba(164,78,53,0.45)' : 'rgba(239,68,68,0.5)'),
            borderColor: prices.map(p => p >= 0 ? '#70876a' : '#ef4444'),
            borderWidth: 1, borderRadius: 3, borderSkipped: false
          }]
        },
        options: {
          responsive: true,
          plugins: {
            legend: { display: false },
            tooltip: { ...createGlassTooltip(), callbacks: { afterLabel: (ctx) => { const s = top[ctx.dataIndex]; return `Mentions: ${s.mention_count}\nSentiment: ${(s.avg_sentiment || 0).toFixed(2)}`; } } }
          },
          scales: {
            x: { ticks: { color: c, font: { weight: '600' } }, grid: { color: gc } },
            y: { ticks: { color: c, callback: (v) => v.toFixed(1) + '%' }, grid: { color: gc }, beginAtZero: true }
          }
        }
      });
    }

    function renderStockPriceChart(prices) {
      if (chartsUnavailable('stockPriceChartFallback')) return;
      if (charts.stockPrice) charts.stockPrice.destroy();
      if (!prices.length) { setChartFallback('stockPriceChartFallback', 'No stock price history is available for this range.'); return; }
      const byTicker = {};
      prices.forEach(p => { if (!byTicker[p.ticker]) byTicker[p.ticker] = []; byTicker[p.ticker].push(p); });
      const tickers = Object.keys(byTicker).sort();
      if (!tickers.length) { setChartFallback('stockPriceChartFallback', 'No ticker price history is available for this range.'); return; }
      setChartFallback('stockPriceChartFallback', `${tickers.length} tickers across ${new Set(prices.map(p => p.date)).size} dates. Use the ticker buttons to change the lines.`);
      const toggleEl = document.getElementById('tickerToggle');
      const selectedTickers = JSON.parse(localStorage.getItem('selectedTickers') || '[]');
      const defaultTickers = tickers.map(t => ({ ticker: t, count: byTicker[t].length })).sort((a, b) => b.count - a.count).slice(0, 5).map(t => t.ticker);
      const activeTickers = selectedTickers.length ? selectedTickers : defaultTickers;
      localStorage.setItem('selectedTickers', JSON.stringify(activeTickers));
      toggleEl.innerHTML = tickers.map(t => {
        const active = activeTickers.includes(t);
        const idx = tickers.indexOf(t);
        const color = TICKER_COLORS[idx % TICKER_COLORS.length];
        // ticker comes from the DB — carry it on a data attribute instead of
        // interpolating into an inline handler (see the sector filter pills)
        return `<button data-ticker="${escapeHtml(t)}" style="border-color:${active ? color : 'var(--border)'};background:${active ? color + '22' : 'transparent'};color:${active ? color : 'var(--text-dim)'};font-weight:${active ? '600' : '500'}">${escapeHtml(t)}</button>`;
      }).join('');
      // one delegated listener; the container element is never replaced
      if (!toggleEl.dataset.wired) {
        toggleEl.dataset.wired = '1';
        toggleEl.addEventListener('click', e => {
          const btn = e.target.closest('button[data-ticker]');
          if (btn) toggleTicker(btn.dataset.ticker);
        });
      }
      document.getElementById('tickerBadge').textContent = `${activeTickers.length} shown`;
      const allDates = [...new Set(prices.map(p => p.date))].sort();
      if (!allDates.length) { setChartFallback('stockPriceChartFallback', 'No dated stock prices are available for this range.'); return; }
      const datasets = [];
      activeTickers.forEach((ticker, i) => {
        const tickerPrices = byTicker[ticker] || [];
        const priceMap = {};
        tickerPrices.forEach(p => { priceMap[p.date] = p.price; });
        const data = allDates.map(d => priceMap[d] !== undefined ? priceMap[d] : null);
        const color = TICKER_COLORS[i % TICKER_COLORS.length];
        datasets.push({ label: ticker, data, spanGaps: true, borderColor: color, backgroundColor: color + '11', fill: false, tension: 0.35, pointRadius: 2, pointHoverRadius: 5, pointBackgroundColor: color + '33', pointBorderColor: color, pointBorderWidth: 1 });
      });
      const ctx = document.getElementById('stockPriceChart').getContext('2d');
      const c = chartTextColor(), gc = chartGridColor();
      charts.stockPrice = new Chart(ctx, {
        type: 'line',
        data: { labels: allDates.map(d => fmtShortDate(d)), datasets },
        options: {
          responsive: true, interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: c, boxWidth: 10, padding: 12, usePointStyle: true, pointStyle: 'circle', font: { size: 10 } } },
            tooltip: { ...createGlassTooltip(), callbacks: { label: (ctx) => ctx.raw === null ? `${ctx.dataset.label}: —` : `${ctx.dataset.label}: $${Number(ctx.raw).toFixed(2)}` } }
          },
          scales: {
            x: { ticks: { color: c, maxTicksLimit: 10, maxRotation: 45 }, grid: { color: gc } },
            y: { ticks: { color: c, callback: (v) => '$' + v.toFixed(0) }, grid: { color: gc } }
          }
        }
      });
    }

    function toggleTicker(ticker) {
      const selected = JSON.parse(localStorage.getItem('selectedTickers') || '[]');
      const idx = selected.indexOf(ticker);
      if (idx >= 0) selected.splice(idx, 1); else selected.push(ticker);
      localStorage.setItem('selectedTickers', JSON.stringify(selected));
      if (charts.stockPrice) charts.stockPrice.destroy();
      renderStockPriceChart(stockPriceDataCache);
    }

    function renderSectorTrendChart(sectors) {
      if (chartsUnavailable('sectorTrendChartFallback')) return;
      if (charts.sectorTrend) charts.sectorTrend.destroy();
      if (!sectors.length) { setChartFallback('sectorTrendChartFallback', 'No sector trend data is available for this range.'); return; }
      const byDate = {};
      const allSectors = [...new Set(sectors.map(s => s.sector))].sort();
      sectors.forEach(s => { if (!byDate[s.date]) byDate[s.date] = {}; byDate[s.date][s.sector] = (byDate[s.date][s.sector] || 0) + (s.article_count || 0); });
      const dates = Object.keys(byDate).sort();
      if (!dates.length) { setChartFallback('sectorTrendChartFallback', 'No dated sector trend data is available for this range.'); return; }
      setChartFallback('sectorTrendChartFallback', `${dates.length} dates across ${allSectors.length} sectors.`);
      const datasets = allSectors.map(sector => {
        const color = SECTOR_COLORS[sector] || '#a44e35';
        return { label: sector, data: dates.map(d => byDate[d][sector] || 0), backgroundColor: color + '22', borderColor: color, borderWidth: 1, fill: true, tension: 0.3, pointRadius: 0 };
      });
      const ctx = document.getElementById('sectorTrendChart').getContext('2d');
      const c = chartTextColor(), gc = chartGridColor();
      charts.sectorTrend = new Chart(ctx, {
        type: 'line',
        data: { labels: dates.map(d => fmtShortDate(d)), datasets },
        options: {
          responsive: true, interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { position: 'bottom', labels: { color: c, boxWidth: 10, padding: 8, font: { size: 9 }, usePointStyle: true, pointStyle: 'circle' } },
            tooltip: { ...createGlassTooltip(), callbacks: { label: (ctx) => { const total = ctx.chart.data.datasets.reduce((s, ds) => s + (ds.data[ctx.dataIndex] || 0), 0); const pct = total > 0 ? ((ctx.raw / total) * 100).toFixed(0) : 0; return `${ctx.dataset.label}: ${ctx.raw} articles (${pct}%)`; } } }
          },
          scales: {
            x: { ticks: { color: c, maxTicksLimit: 8, maxRotation: 45 }, grid: { color: gc } },
            y: { stacked: true, ticks: { color: c }, grid: { color: gc }, beginAtZero: true }
          }
        }
      });
    }

    function renderCapexChart(metrics) {
      if (chartsUnavailable('capexChartFallback')) return;
      if (charts.capex) charts.capex.destroy();
      const sorted = (metrics || []).filter(m => (m.sec_capex_total || m.sec_ai_revenue_total || m.total_capex_announced)).sort((a, b) => a.date.localeCompare(b.date));
      if (!sorted.length) { setChartFallback('capexChartFallback', 'No capex or AI spending metrics are available.'); return; }
      setChartFallback('capexChartFallback', `${sorted.length} days of capex and AI revenue metrics from SEC data.`);
      const dates = sorted.map(m => fmtShortDate(m.date));
      const capexData = sorted.map(m => (m.sec_capex_total || m.total_capex_announced || 0));
      const aiRevData = sorted.map(m => (m.sec_ai_revenue_total || 0));
      const ctx = document.getElementById('capexChart').getContext('2d');
      const c = chartTextColor(), gc = chartGridColor();
      const badge = document.getElementById('capexBadge');
      if (badge) badge.textContent = `${sorted.length} days tracked`;
      charts.capex = new Chart(ctx, {
        type: 'bar',
        data: {
          labels: dates,
          datasets: [
            { label: 'Capex ($M)', data: capexData, backgroundColor: 'rgba(164,78,53,0.5)', borderColor: '#a44e35', borderWidth: 1, borderRadius: 3, borderSkipped: false, yAxisID: 'y' },
            { label: 'AI Revenue ($M)', data: aiRevData, backgroundColor: 'rgba(164,78,53,0.35)', borderColor: '#70876a', borderWidth: 1, borderRadius: 3, borderSkipped: false, yAxisID: 'y' },
          ]
        },
        options: {
          responsive: true, interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: c, boxWidth: 10, padding: 12, usePointStyle: true, pointStyle: 'circle', font: { size: 10 } } },
            tooltip: { ...createGlassTooltip(), callbacks: { label: (ctx) => `${ctx.dataset.label}: $${Number(ctx.raw).toLocaleString()}M` } }
          },
          scales: {
            x: { ticks: { color: c, maxTicksLimit: 8, maxRotation: 45 }, grid: { color: gc } },
            y: { ticks: { color: c, callback: (v) => '$' + v.toFixed(0) + 'M' }, grid: { color: gc }, beginAtZero: true }
          }
        }
      });
    }

    function renderFeedbackChart(feedbackDaily) {
      if (chartsUnavailable('feedbackChartFallback')) return;
      if (charts.feedback) charts.feedback.destroy();
      const sorted = (feedbackDaily || []).filter(row => Number(row.total_votes || 0) > 0).sort((a, b) => a.feedback_date.localeCompare(b.feedback_date));
      if (!sorted.length) { setChartFallback('feedbackChartFallback', 'Feedback summaries appear after at least five ratings are received.'); return; }
      const valid = sorted.map(row => ({
        date: fmtShortDate(row.feedback_date),
        avg: Number(row.rating_sum || 0) / Number(row.total_votes || 1),
        votes: Number(row.total_votes || 0),
      })).filter(v => Number.isFinite(v.avg) && v.votes > 0);
      if (valid.length < 2) { setChartFallback('feedbackChartFallback', 'At least two feedback rating points are needed for this chart.'); return; }
      setChartFallback('feedbackChartFallback', `${valid.reduce((s, v) => s + v.votes, 0)} votes across ${valid.length} dated rating points.`);
      const badge = document.getElementById('feedbackBadge');
      if (badge) badge.textContent = `${valid.reduce((s, v) => s + v.votes, 0)} votes`;
      const ctx = document.getElementById('feedbackChart').getContext('2d');
      const c = chartTextColor(), gc = chartGridColor();
      charts.feedback = new Chart(ctx, {
        type: 'line',
        data: {
          labels: valid.map(v => v.date),
          datasets: [
            { label: 'Avg Rating', data: valid.map(v => v.avg), borderColor: '#a44e35', backgroundColor: 'rgba(164,78,53,0.06)', fill: true, tension: 0.35, pointRadius: 3, pointHoverRadius: 6, borderWidth: 2 },
            { label: 'Votes', data: valid.map(v => v.votes), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.06)', fill: true, tension: 0.35, pointRadius: 2, pointHoverRadius: 5, borderWidth: 1, yAxisID: 'y1' },
          ]
        },
        options: {
          responsive: true, interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: c, boxWidth: 10, padding: 12, usePointStyle: true, pointStyle: 'circle', font: { size: 10 } } },
            tooltip: { ...createGlassTooltip(), callbacks: { label: (ctx) => { if (ctx.datasetIndex === 0) return `${'⭐'.repeat(Math.round(ctx.raw))} ${ctx.raw.toFixed(2)}`; return `${ctx.raw} votes`; } } }
          },
          scales: {
            x: { ticks: { color: c, maxTicksLimit: 7, maxRotation: 45 }, grid: { color: gc } },
            y: { ticks: { color: c, min: 1, max: 5 }, grid: { color: gc }, beginAtZero: false },
            y1: { type: 'linear', display: true, position: 'right', ticks: { color: c }, grid: { drawOnChartArea: false }, beginAtZero: true }
          }
        }
      });
    }

    function renderDigestPerformanceChart(digests, metrics) {
      if (chartsUnavailable('digestPerfChartFallback')) return;
      if (charts.digestPerf) charts.digestPerf.destroy();
      if (!digests.length) { setChartFallback('digestPerfChartFallback', 'No digest run performance data is available.'); return; }
      const sorted = [...digests].sort((a, b) => a.run_date.localeCompare(b.run_date));
      setChartFallback('digestPerfChartFallback', `${sorted.length} digest runs. The chart compares articles, tokens, and duration.`);
      const dates = sorted.map(d => fmtShortDate(d.run_date));
      const ctx = document.getElementById('digestPerfChart').getContext('2d');
      const c = chartTextColor(), gc = chartGridColor();
      charts.digestPerf = new Chart(ctx, {
        type: 'line',
        data: {
          labels: dates,
          datasets: [
            { label: 'Articles', data: sorted.map(d => d.articles_processed || 0), borderColor: '#a44e35', backgroundColor: 'rgba(164,78,53,0.06)', fill: true, tension: 0.35, pointRadius: 2, pointHoverRadius: 5, yAxisID: 'y' },
            { label: 'Tokens (K)', data: sorted.map(d => (d.total_tokens_used || 0) / 1000), borderColor: '#f59e0b', backgroundColor: 'rgba(245,158,11,0.06)', fill: true, tension: 0.35, pointRadius: 2, pointHoverRadius: 5, yAxisID: 'y1' },
            { label: 'Duration (s)', data: sorted.map(d => d.duration_seconds || 0), borderColor: '#70876a', backgroundColor: 'rgba(164,78,53,0.07)', fill: true, tension: 0.35, pointRadius: 2, pointHoverRadius: 5, yAxisID: 'y1' },
          ]
        },
        options: {
          responsive: true, interaction: { mode: 'index', intersect: false },
          plugins: {
            legend: { labels: { color: c, boxWidth: 10, padding: 12, usePointStyle: true, pointStyle: 'circle', font: { size: 10 } } },
            tooltip: { ...createGlassTooltip(), callbacks: { label: (ctx) => { if (ctx.datasetIndex === 0) return `${ctx.raw} articles`; if (ctx.datasetIndex === 1) return `${(ctx.raw * 1000).toFixed(0)} tokens`; return `${ctx.raw}s duration`; } } }
          },
          scales: {
            x: { ticks: { color: c, maxTicksLimit: 8, maxRotation: 45 }, grid: { color: gc } },
            y: { type: 'linear', display: true, position: 'left', ticks: { color: c }, grid: { color: gc }, beginAtZero: true, title: { display: true, text: 'Articles', color: c, font: { size: 9 } } },
            y1: { type: 'linear', display: true, position: 'right', ticks: { color: c }, grid: { drawOnChartArea: false }, beginAtZero: true, title: { display: true, text: 'Tokens (K) / Seconds', color: c, font: { size: 9 } } }
          }
        }
      });
    }

    function renderTokenChart(metrics) {
      if (chartsUnavailable('tokenChartFallback')) return;
      if (charts.token) charts.token.destroy();
      const recent = (metrics || []).slice(-14);
      if (!recent.length) { setChartFallback('tokenChartFallback', 'No AI token usage metrics are available.'); return; }
      setChartFallback('tokenChartFallback', `${recent.length} daily AI token usage points, showing the most recent two weeks.`);
      const ctx = document.getElementById('tokenChart').getContext('2d');
      const c = chartTextColor(), gc = chartGridColor();
      charts.token = new Chart(ctx, {
        type: 'line',
        data: { labels: recent.map(m => fmtDate(m.date)), datasets: [{ label: 'Tokens', data: recent.map(m => m.total_tokens_used || 0), borderColor: '#a44e35', backgroundColor: 'rgba(164,78,53,0.06)', fill: true, tension: 0.35, pointRadius: 2, pointHoverRadius: 5, borderWidth: 2 }] },
        options: {
          responsive: true,
          plugins: { legend: { display: false }, tooltip: { ...createGlassTooltip(), callbacks: { label: (ctx) => `${Number(ctx.raw).toLocaleString()} tokens` } } },
          scales: {
            x: { ticks: { color: c, maxTicksLimit: 7, font: { size: 9 } }, grid: { color: gc } },
            y: { ticks: { color: c }, grid: { color: gc }, beginAtZero: true }
          }
        }
      });
    }

    // ─── Filters ──
    function renderFilterBar() {
      const el = document.getElementById('sectorFilters');
      if (!el) return;
      const sorted = [...allSectors].sort();
      el.innerHTML = sorted.map(s => {
        const active = activeFilters.sector === s;
        const color = SECTOR_COLORS[s] || 'var(--text-dim)';
        // sector names come from the DB — carry them on a data attribute
        // rather than interpolating into an inline handler, and escape the
        // label so a name can never break out into markup
        return `<button type="button" class="filter-pill ${active ? 'active' : ''}" aria-pressed="${active}" data-sector="${escapeHtml(s)}" style="${active ? `background:${color};border-color:${color};color:#0a0705` : '--filter-color:' + color}">${active ? '✓ ' : ''}${escapeHtml(s)}</button>`;
      }).join('');
      // one delegated listener on the container, which is never replaced
      // (only its innerHTML is), so the 60s refresh can't stack handlers
      if (!el.dataset.wired) {
        el.dataset.wired = '1';
        el.addEventListener('click', e => {
          const btn = e.target.closest('.filter-pill[data-sector]');
          if (btn) setFilter('sector', btn.dataset.sector);
        });
      }
      const hasFilters = activeFilters.sector || activeFilters.impact || activeFilters.search;
      document.getElementById('filterClear').style.display = hasFilters ? 'inline-block' : 'none';
      const searchInput = document.getElementById('filterSearch');
      if (searchInput.value !== activeFilters.search) searchInput.value = activeFilters.search;
      document.querySelectorAll('.filter-pill.impact-bullish, .filter-pill.impact-bearish, .filter-pill.impact-neutral').forEach(btn => {
        btn.classList.toggle('active', activeFilters.impact === btn.dataset.impact);
        btn.setAttribute('aria-pressed', String(activeFilters.impact === btn.dataset.impact));
      });
    }

    function setFilter(type, value) {
      if (activeFilters[type] === value) activeFilters[type] = null;
      else activeFilters[type] = value;
      saveFilters();
      applyFilters();
    }
    function clearFilters() {
      activeFilters = { sector: null, impact: null, search: '' };
      localStorage.removeItem('savedFilters');
      document.getElementById('filterSearch').value = '';
      applyFilters();
    }
    function onSearchChange() {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        activeFilters.search = document.getElementById('filterSearch').value.toLowerCase().trim();
        saveFilters();
        applyFilters();
      }, 250);
    }
    function applyFilters() {
      renderFilterBar();
      let filtered = allArticlesCache;
      if (activeFilters.sector) filtered = filtered.filter(a => a.category === activeFilters.sector);
      if (activeFilters.impact) filtered = filtered.filter(a => a.impact === activeFilters.impact);
      if (activeFilters.search) {
        const q = activeFilters.search;
        filtered = filtered.filter(a => (a.title || '').toLowerCase().includes(q) || (a.affected_stocks || []).some(s => s && s.toLowerCase().includes(q)) || (a.category || '').toLowerCase().includes(q));
      }
      renderArticles(filtered, true);
    }

    let _expandedArticleIdx = null;

    function toggleArticleExpand(idx) {
      const detailRow = document.getElementById('article-detail-' + idx);
      const chevron = document.getElementById('article-chevron-' + idx);
      const row = document.getElementById('article-row-' + idx);
      if (!detailRow) return;
      const isOpen = !detailRow.hidden;
      document.querySelectorAll('[id^="article-detail-"]').forEach(el => { el.hidden = true; el.style.display = 'none'; el.setAttribute('aria-hidden', 'true'); });
      document.querySelectorAll('[id^="article-chevron-"]').forEach(el => { el.style.transform = ''; });
      document.querySelectorAll('[id^="article-row-"]').forEach(el => { el.style.background = ''; });
      document.querySelectorAll('[id^="article-row-"]').forEach(el => { el.setAttribute('aria-expanded', 'false'); });
      if (!isOpen) {
        detailRow.hidden = false;
        detailRow.style.display = 'table-row';
        detailRow.setAttribute('aria-hidden', 'false');
        chevron.style.transform = 'rotate(90deg)';
        row.style.background = 'rgba(164,78,53,0.04)';
        row.setAttribute('aria-expanded', 'true');
        _expandedArticleIdx = idx;
      } else {
        _expandedArticleIdx = null;
      }
    }

    function renderArticles(articles, filtered) {
      const tbody = document.getElementById('articlesBody');
      const countEl = document.getElementById('articlesCount');
      if (!articles.length) {
        const emptyMessage = articleSearchQuery ? `No articles match "${escapeHtml(articleSearchQuery)}"` : (filtered ? 'No articles match your filters' : 'No articles yet - run the digest first');
        tbody.innerHTML = `<tr><td colspan="6" style="padding:20px;text-align:center;color:var(--text-dim)">${emptyMessage}</td></tr>`;
        if (countEl) countEl.textContent = '';
        return;
      }
      const show = articles;
      tbody.innerHTML = show.map((a, i) => {
        const isSec = a.is_sec_filing;
        const secBadge = isSec ? '<span style="font-size:11px" title="SEC Filing">\uD83C\uDFDB</span>' : '';
        const stocks = (a.affected_stocks || []).map(s =>
          `<span style="font-family:'IBM Plex Mono', monospace;font-size:10px;background:var(--bg-hover);padding:1px 5px;border-radius:2px;margin:0 1px">${escapeHtml(s)}</span>`
        ).join('') || '—';
        const summary = escapeHtml(a.summary || '').replace(/\n/g, '<br>');
        const reason = escapeHtml(a.reason || '');
        const bearCase = a.bear_case || '';
        let ranking = a.ranking_explanation || null;
        if (typeof ranking === 'string') { try { ranking = JSON.parse(ranking); } catch { ranking = null; } }
        const rankingReasons = ranking && Array.isArray(ranking.reasons) ? ranking.reasons.map(escapeHtml).join(' · ') : '';
        const rankingDetail = ranking
          ? `<div style="font-size:11px;color:var(--text-muted);margin-bottom:8px">📐 Ranked <strong style="color:var(--gold)">${Number(ranking.finalScore || a.effective_score || 0).toFixed(1)}</strong> · base ${Number(ranking.baseImpactScore || a.impact_score || 0).toFixed(1)}${rankingReasons ? ` · ${rankingReasons}` : ''}</div>`
          : '';
        const safeUrl = safeHref(a.url);
        const thumbs = (a.thumbs_up || a.thumbs_down)
          ? `<span style="font-size:10px;color:var(--text-muted);margin-left:8px">👍 ${Number(a.thumbs_up)||0} · 👎 ${Number(a.thumbs_down)||0}</span>`
          : '';

        const articleTitle = escapeHtml(a.title || 'Untitled article');
        const mainRow = `<tr id="article-row-${i}" class="article-row" tabindex="0" role="button" aria-expanded="false" aria-controls="article-detail-${i}" aria-label="Expand article details: ${articleTitle}" style="cursor:pointer;transition:background 0.15s" data-article-index="${i}" >` +
          `<td><span style="display:flex;align-items:center;gap:6px">` +
          `<span id="article-chevron-${i}" style="font-size:8px;color:var(--text-muted);transition:transform 0.2s;flex-shrink:0;user-select:none">&#9658;</span>` +
          `${secBadge}<span style="color:var(--text)">${articleTitle}</span></span></td>` +
          `<td><span style="display:inline-flex;align-items:center;gap:4px"><span style="width:6px;height:6px;border-radius:1px;background:${SECTOR_COLORS[a.category] || 'var(--text-dim)'};display:inline-block;flex-shrink:0"></span>${escapeHtml(a.category || '—')}</span></td>` +
          `<td class="${sentimentClass(a.impact)}">${sentimentArrow(a.impact)} ${escapeHtml(a.impact || '—')}</td>` +
          `<td><span style="font-weight:600;font-family:'IBM Plex Mono', monospace">${escapeHtml(a.impact_score || '—')}</span><span style="color:var(--text-muted)">/10</span></td>` +
          `<td>${stocks}</td>` +
          `<td style="text-align:right"><a href="${safeUrl}" target="_blank" rel="noopener" aria-label="Open article in a new tab" title="Open article in a new tab"  style="font-size:10px;color:var(--gold)">&#128279;</a></td></tr>`;

        const detailRow = `<tr id="article-detail-${i}" aria-hidden="true" hidden style="display:none">` +
          `<td colspan="6" style="padding:0">` +
          `<div style="padding:12px 14px 14px 28px;background:rgba(164,78,53,0.03);border-top:1px solid var(--border-light);border-bottom:1px solid var(--border-light)">` +
          (summary ? `<div style="font-size:12px;color:var(--text-dim);margin-bottom:8px;line-height:1.6">${summary}</div>` : '') +
          (reason ? `<div style="font-size:11px;color:var(--text-muted);font-style:italic;margin-bottom:8px">&#128161; ${reason}</div>` : '') +
          rankingDetail +
          (bearCase ? `<div style="font-size:11px;color:#866523;font-style:italic;margin-bottom:10px;padding:6px 10px;background:rgba(224,178,87,0.06);border-left:2px solid rgba(224,178,87,0.4);border-radius:2px">⚠️ ${escapeHtml(bearCase)}</div>` : '') +
          `<div style="display:flex;align-items:center;gap:8px">` +
          `<a href="${safeUrl}" target="_blank" rel="noopener" aria-label="Read full article in a new tab"  style="font-size:11px;color:var(--gold);text-decoration:none">Read full article &#8594;</a>` +
          thumbs +
          `</div>` +
          `</div></td></tr>`;

        return mainRow + detailRow;
      }).join('');
      if (countEl) {
        if (articleSearchQuery) {
          const total = articleSearchTotal == null ? allArticlesCache.length : articleSearchTotal;
          countEl.textContent = `Showing ${show.length} of ${total} search results for "${articleSearchQuery}"`;
        } else if (filtered) {
          countEl.textContent = `Showing ${show.length} of ${articles.length} filtered from ${allArticlesCache.length} articles`;
        } else {
          countEl.textContent = `Showing ${show.length} articles`;
        }
      }
    }

    function csvCell(value) {
      const raw = Array.isArray(value) ? value.join('; ') : String(value ?? '');
      // Prefix spreadsheet formula triggers so exported article data stays
      // inert when opened in Excel, Sheets, or another spreadsheet app.
      const safe = /^[=+\-@\t\r]/.test(raw) ? `'${raw}` : raw;
      return '"' + safe.replace(/"/g, '""') + '"';
    }

    function exportCSV() {
      const data = allFetchedArticles.length > 0 ? allFetchedArticles : allArticlesCache;
      if (!data.length) return;
      const headers = ['title', 'source', 'category', 'impact', 'impact_score', 'affected_stocks', 'summary', 'url'];
      const rows = data.map(a => headers.map(h => csvCell(a[h])).join(','));
      const csv = [headers.join(','), ...rows].join('\n');
      const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `articles-${new Date().toISOString().split('T')[0]}.csv`;
      link.click();
      URL.revokeObjectURL(link.href);
    }

    // ─── Pipeline ──
    function renderPipeline(feeds) {
      const el = document.getElementById('pipelineHealth');
      if (!feeds.length) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">No pipeline data yet</p>'; return; }
      const latest = {};
      feeds.forEach(f => { if (!latest[f.feed_name] || f.created_at > latest[f.feed_name].created_at) latest[f.feed_name] = f; });
      const entries = Object.values(latest);
      const healthy = entries.filter(e => e.status === 'success').length;
      const failing = entries.filter(e => e.status === 'failed').length;
      el.innerHTML = `
        <div style="display:flex;gap:14px;margin-bottom:10px;flex-wrap:wrap">
          <span style="font-size:11px;display:flex;align-items:center;gap:6px"><span style="width:6px;height:6px;border-radius:50%;background:var(--bullish);display:inline-block"></span>${healthy} healthy</span>
          <span style="font-size:11px;display:flex;align-items:center;gap:6px"><span style="width:6px;height:6px;border-radius:50%;background:var(--danger);display:inline-block"></span>${failing} failing</span>
          <span style="font-size:11px;color:var(--text-dim)">${entries.length} total feeds</span>
        </div>
        ${entries.slice(0, 40).map(f => `<div class="feed-row"><span class="feed-status ${f.status === 'success' ? 'success' : f.status === 'failed' ? 'failed' : ''}"></span><span style="flex:1;font-weight:500">${escapeHtml(f.feed_name)}</span><span style="color:var(--text-muted);font-size:10px;font-family:'IBM Plex Mono', monospace">${Number(f.articles_fetched) || 0}</span>${f.status === 'failed' ? '<span style="color:var(--danger);font-size:10px">Unavailable</span>' : ''}</div>`).join('')}
      `;
    }

    function renderSECSection(filings) {
      const el = document.getElementById('secSection');
      if (!filings.length) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">No SEC filing analysis is available for this range.</p>'; return; }
      const totalFilings = filings.length;
      const eightKs = filings.filter(f => f.form_type === '8-K').length;
      const highImpact = filings.filter(f => (f.impact_score || 0) >= 8).length;
      const uniqueTickers = [...new Set(filings.map(f => f.ticker))];
      let html = `<div style="display:flex;gap:16px;margin-bottom:10px;flex-wrap:wrap">
        <span style="font-size:11px;display:flex;align-items:center;gap:6px">📜 ${totalFilings} filings</span>
        <span style="font-size:11px;color:var(--text-dim)">${eightKs} 8-Ks</span>
        <span style="font-size:11px;color:var(--text-dim)">${uniqueTickers.length} companies</span>
        <span style="font-size:11px;display:flex;align-items:center;gap:6px"><span style="width:6px;height:6px;border-radius:50%;background:var(--danger);display:inline-block"></span>${highImpact} high-impact (8+)</span>
      </div>`;
      html += `<table><thead><tr><th>Company</th><th>Form</th><th>Date</th><th>Capex</th><th>AI Revenue</th><th>Margins</th><th>Guide</th><th>Impact</th></tr></thead><tbody>`;
      for (const f of filings.slice(0, 20)) {
        const formColor = f.form_type === '8-K' ? 'var(--warn)' : f.form_type === '10-Q' ? 'var(--gold)' : '#a44e35';
        const impactColor = (f.impact_score || 0) >= 8 ? 'var(--danger)' : (f.impact_score || 0) >= 6 ? 'var(--warn)' : 'var(--text-muted)';
        const fmtCapex = f.capex !== null && f.capex !== undefined ? `$${f.capex.toLocaleString()}M` : '—';
        const fmtAiRev = f.ai_revenue !== null && f.ai_revenue !== undefined ? `$${f.ai_revenue.toLocaleString()}M` : '—';
        const fmtMargins = [];
        if (f.gross_margin !== null && f.gross_margin !== undefined) fmtMargins.push(`GM:${Number(f.gross_margin)}%`);
        if (f.operating_margin !== null && f.operating_margin !== undefined) fmtMargins.push(`OM:${Number(f.operating_margin)}%`);
        const marginStr = fmtMargins.length > 0 ? fmtMargins.join(' ') : '—';
        const fmtGuide = f.revenue_guidance !== null && f.revenue_guidance !== undefined ? `$${f.revenue_guidance.toLocaleString()}M` : '—';
        html += `<tr><td><strong>${escapeHtml(f.ticker)}</strong><br><span style="font-size:9px;color:var(--text-muted)">${escapeHtml((f.company_name || '').slice(0, 30))}</span></td>
          <td><span style="font-size:10px;background:${formColor}22;color:${formColor};padding:1px 6px;border-radius:2px;font-weight:600">${escapeHtml(f.form_type)}</span></td>
          <td style="font-size:10px;color:var(--text-dim);font-family:'IBM Plex Mono', monospace">${fmtDate(f.filing_date) || escapeHtml(f.filing_date)}</td>
          <td style="font-family:'IBM Plex Mono', monospace;font-size:11px">${fmtCapex}</td>
          <td style="font-family:'IBM Plex Mono', monospace;font-size:11px">${fmtAiRev}</td>
          <td style="font-family:'IBM Plex Mono', monospace;font-size:10px;color:var(--text-dim)">${marginStr}</td>
          <td style="font-family:'IBM Plex Mono', monospace;font-size:11px">${fmtGuide}</td>
          <td><span style="color:${impactColor};font-weight:600">${escapeHtml(f.impact_score || '—')}</span><span style="color:var(--text-muted);font-size:9px">/10</span></td></tr>`;
      }
      html += `</tbody></table>`;
      if (filings.length > 20) html += `<div style="margin-top:8px;font-size:10px;color:var(--text-muted)">Showing 20 of ${filings.length} filings</div>`;
      el.innerHTML = html;
    }

    function renderThesesSection(theses, history) {
      const el = document.getElementById('thesesSection');
      if (!theses.length) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">No thesis snapshots yet — they generate weekly (Sundays) for the top-10 most-mentioned tickers</p>'; return; }

      // v11 — group history rows by ticker, newest week first, client-side
      // (no per-ticker query loop; one batched fetch already happened above).
      const historyByTicker = {};
      (history || []).forEach(h => {
        (historyByTicker[h.ticker] = historyByTicker[h.ticker] || []).push(h);
      });
      Object.values(historyByTicker).forEach(rows => rows.sort((a, b) => (b.week_of || '').localeCompare(a.week_of || '')));

      el.innerHTML = theses.map(t => {
        const confColor = t.confidence >= 7 ? 'var(--bullish)' : t.confidence >= 4 ? 'var(--warn)' : 'var(--text-muted)';
        const drivers = (t.key_drivers || []).map(d =>
          `<span style="font-size:10px;background:var(--bg-hover);padding:1px 6px;border-radius:2px;margin-right:4px">${escapeHtml(d)}</span>`
        ).join('');
        const updated = (t.updated_at || '').split('T')[0];

        // Timeline: last 6 weeks max, week_of shown explicitly next to each
        // entry so a skipped cron run is visible as a real date gap rather
        // than silently mislabeling a multi-week jump as a one-week delta.
        const tickerHistory = (historyByTicker[t.ticker] || []).slice(0, 6);
        let historyHtml = '';
        if (tickerHistory.length > 1) {
          const rows = tickerHistory.map((h, i) => {
            const prev = tickerHistory[i + 1];
            const delta = prev ? h.confidence - prev.confidence : null;
            const deltaHtml = delta == null || delta === 0
              ? ''
              : delta > 0
                ? ` <span style="color:var(--bullish)">(+${delta})</span>`
                : ` <span style="color:var(--bearish)">(${delta})</span>`;
            return `<div style="display:flex;gap:8px;font-size:10px;color:var(--text-muted);padding:2px 0">
              <span style="font-family:'IBM Plex Mono', monospace">${escapeHtml(h.week_of || '')}</span>
              <span>confidence ${Number(h.confidence)}/10${deltaHtml}</span>
            </div>`;
          }).join('');
          historyHtml = `<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border-light)">${rows}</div>`;
        }

        return `<div style="padding:10px 0;border-bottom:1px solid var(--border-light)">
          <div style="display:flex;align-items:center;gap:8px;margin-bottom:6px">
            <strong style="font-family:'IBM Plex Mono', monospace">${escapeHtml(t.ticker)}</strong>
            <span style="color:${confColor};font-size:11px;font-weight:600">confidence ${Number(t.confidence)}/10</span>
            <span style="color:var(--text-muted);font-size:10px;margin-left:auto">${escapeHtml(updated)}</span>
          </div>
          <div style="font-size:12px;color:var(--text-dim);line-height:1.5;margin-bottom:4px">🟢 ${escapeHtml(t.bull_case)}</div>
          <div style="font-size:12px;color:var(--text-dim);line-height:1.5;margin-bottom:6px">🔴 ${escapeHtml(t.bear_case)}</div>
          ${drivers ? `<div>${drivers}</div>` : ''}
          ${historyHtml}
        </div>`;
      }).join('');
    }

    function renderCapex(capex) {
      const tbody = document.getElementById('capexBody');
      if (!capex.length) { tbody.innerHTML = '<tr><td colspan="4" style="padding:20px;text-align:center;color:var(--text-dim)">No capex tracked yet</td></tr>'; return; }
      tbody.innerHTML = capex.map(c => `<tr><td><strong>${escapeHtml(c.company)}</strong></td><td><span style="font-family:'IBM Plex Mono', monospace;font-weight:600">${escapeHtml(c.amount || '—')}</span></td><td><span style="font-size:10px;background:var(--bg-hover);padding:1px 6px;border-radius:2px">${escapeHtml(c.category || '—')}</span></td><td style="color:var(--text-dim);font-size:11px">${escapeHtml(c.description || '')}</td></tr>`).join('');
    }

    function renderTrendingSection(metrics) {
      const el = document.getElementById('trendingSection');
      if (!metrics.length) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">No trending data yet</p>'; return; }
      const latest = metrics.find(m => m.trending_json);
      if (!latest) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">No trending data available</p>'; return; }
      let items = [];
      try { items = JSON.parse(latest.trending_json); } catch { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">Could not parse trending data</p>'; return; }
      if (!items.length) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">No trending entities</p>'; return; }
      let html = `<div style="display:flex;gap:14px;margin-bottom:10px;flex-wrap:wrap"><span style="font-size:11px;display:flex;align-items:center;gap:6px">🔥 ${items.length} trending</span><span style="font-size:11px;color:var(--text-dim)">Based on ${escapeHtml(latest.date)}</span></div>`;
      for (const item of items.slice(0, 8)) {
        const te = item.type === 'ticker' ? '📈' : item.type === 'sector' ? '📊' : '🏢';
        const se = item.dominantSentiment === 'positive' ? '🟢' : item.dominantSentiment === 'negative' ? '🔴' : '⚪';
        html += `<div class="feed-row"><span>${te}</span><span style="flex:1;font-weight:600;font-size:12px">${escapeHtml(item.entity)}</span><span style="color:var(--text-muted);font-size:10px">${Number(item.mentionCount)} mentions</span><span style="color:var(--text-dim);font-size:10px;font-family:'IBM Plex Mono', monospace">${Number(item.avgScore)}/10</span><span>${se}</span></div>`;
      }
      el.innerHTML = html;
    }

    function renderFeedbackSection(feedbackDaily) {
      const el = document.getElementById('feedbackSection');
      if (!feedbackDaily || !feedbackDaily.length) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">Feedback summaries appear after at least five ratings are received.</p>'; return; }
      const totals = feedbackDaily.reduce((acc, row) => {
        acc.sum += Number(row.rating_sum || 0);
        acc.votes += Number(row.total_votes || 0);
        acc.dist[0] += Number(row.rating_1_count || 0);
        acc.dist[1] += Number(row.rating_2_count || 0);
        acc.dist[2] += Number(row.rating_3_count || 0);
        acc.dist[3] += Number(row.rating_4_count || 0);
        acc.dist[4] += Number(row.rating_5_count || 0);
        return acc;
      }, { sum: 0, votes: 0, dist: [0, 0, 0, 0, 0] });
      if (!totals.votes) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">Feedback summaries appear after at least five ratings are received.</p>'; return; }
      const avg = (totals.sum / totals.votes).toFixed(1);
      const dist = totals.dist;
      const maxD = Math.max(...dist, 1);
      let html = `<div style="display:flex;gap:14px;margin-bottom:10px;flex-wrap:wrap;align-items:center"><span style="font-size:20px">${'⭐'.repeat(Math.round(parseFloat(avg)))}</span><span style="font-size:18px;font-weight:700">${avg}</span><span style="font-size:11px;color:var(--text-dim)">/ 5 · ${totals.votes} vote${totals.votes !== 1 ? 's' : ''}</span></div>`;
      for (let i = 5; i >= 1; i--) {
        const c = dist[i - 1], p = (c / totals.votes * 100).toFixed(0), w = (c / maxD * 100).toFixed(0);
        html += `<div style="display:flex;align-items:center;gap:6px;margin-bottom:3px;font-size:11px"><span style="width:18px;text-align:right;color:var(--text-dim)">${i}★</span><div style="flex:1;height:8px;background:var(--border-light);border-radius:2px;overflow:hidden"><div style="height:100%;width:${w}%;background:${['#ef4444','#f97316','#f59e0b','#697e85','#70876a'][i - 1]};border-radius:2px"></div></div><span style="width:36px;color:var(--text-muted);font-family:'IBM Plex Mono', monospace;font-size:10px">${c} (${p}%)</span></div>`;
      }
      const commentCount = feedbackDaily.reduce((sum, row) => sum + Number(row.comment_count || 0), 0);
      html += `<p style="margin:10px 0 0;color:var(--text-muted);font-size:10px">${commentCount} written response${commentCount === 1 ? '' : 's'} retained privately; only aggregate ratings are shown here.</p>`;
      el.innerHTML = html;
    }

    function renderRankingQuality(rows) {
      const el = document.getElementById('rankingQualitySection');
      if (!rows.length) {
        el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">No validated ranking data yet. Reader 👍/👎 votes will populate this view.</p>';
        return;
      }
      const totals = rows.reduce((acc, row) => {
        acc.up += Number(row.thumbs_up || 0);
        acc.down += Number(row.thumbs_down || 0);
        acc.voted += Number(row.voted_articles || 0);
        return acc;
      }, { up: 0, down: 0, voted: 0 });
      const approval = totals.up + totals.down > 0 ? Math.round(totals.up / (totals.up + totals.down) * 100) : 0;
      let html = `<div style="display:flex;gap:18px;margin-bottom:10px;flex-wrap:wrap"><span style="font-size:12px"><strong style="color:var(--gold)">${approval}%</strong> approval</span><span style="font-size:11px;color:var(--text-dim)">${totals.voted} ranked articles validated</span><span style="font-size:11px;color:var(--text-muted)">👍 ${totals.up} · 👎 ${totals.down}</span></div>`;
      html += '<table><thead><tr><th>Date</th><th>Voted articles</th><th>Approval</th><th>Avg ranked score</th></tr></thead><tbody>';
      for (const row of rows.slice(0, 10)) {
        const rate = row.approval_rate == null ? '—' : `${Math.round(Number(row.approval_rate) * 100)}%`;
        const score = row.avg_voted_effective_score == null ? '—' : Number(row.avg_voted_effective_score).toFixed(1);
        html += `<tr><td>${fmtDate(row.date)}</td><td>${Number(row.voted_articles || 0)}</td><td>${rate}</td><td>${score}</td></tr>`;
      }
      html += '</tbody></table>';
      el.innerHTML = html;
    }

    function renderDeliverySection(deliveries) {
      const el = document.getElementById('deliverySection');
      if (!deliveries.length) { el.innerHTML = '<p style="color:var(--text-dim);padding:10px 0;font-size:12px">No deliveries in this range</p>'; return; }
      const successful = deliveries.reduce((sum, d) => sum + Number(d.successful_deliveries || 0), 0);
      const failed = deliveries.reduce((sum, d) => sum + Number(d.failed_deliveries || 0), 0);
      const total = deliveries.reduce((sum, d) => sum + Number(d.total_deliveries || 0), 0);
      const dates = deliveries.slice().sort((a, b) => String(b.run_date).localeCompare(String(a.run_date))).slice(0, 10);
      let html = `<div style="display:flex;gap:16px;margin-bottom:10px;flex-wrap:wrap"><span style="font-size:11px;display:flex;align-items:center;gap:6px"><span style="width:6px;height:6px;border-radius:50%;background:var(--bullish);display:inline-block"></span>${successful} delivered</span><span style="font-size:11px;display:flex;align-items:center;gap:6px"><span style="width:6px;height:6px;border-radius:50%;background:var(--danger);display:inline-block"></span>${failed} failed</span><span style="font-size:11px;color:var(--text-dim)">${total} total</span></div>`;
      if (dates.length > 0) {
        html += `<table><thead><tr><th>Date</th><th>Delivered</th><th>Success Rate</th><th>Users</th></tr></thead><tbody>`;
        for (const d of dates) {
          const rowTotal = Number(d.total_deliveries || 0);
          const rowSuccess = Number(d.successful_deliveries || 0);
          const pct = rowTotal > 0 ? ((rowSuccess / rowTotal) * 100).toFixed(0) : '0';
          const pc = parseInt(pct) >= 80 ? 'var(--bullish)' : parseInt(pct) >= 50 ? 'var(--warn)' : 'var(--danger)';
          html += `<tr><td style="font-weight:500;font-size:11px">${fmtDate(d.run_date)}</td><td style="font-size:11px">${rowSuccess}/${rowTotal}</td><td><span style="color:${pc};font-weight:600;font-size:11px">${pct}%</span></td><td style="font-size:11px">${Number(d.unique_users || 0)}</td></tr>`;
        }
        html += `</tbody></table>`;
      }
      el.innerHTML = html;
    }

    async function loadMoreArticles() {
      const btn = document.getElementById('loadMoreBtn');
      const info = document.getElementById('paginationInfo');
      if (!hasMoreArticles || !btn || btn.disabled) return;
      const revision = articleRevision;
      btn.disabled = true; btn.textContent = '⏳ Loading...';
      const nextPage = articlePage + 1;
      const offset = nextPage * ARTICLES_PAGE_SIZE;
      try {
        const result = await fetchArticlePage(articleSearchQuery, offset);
        if (revision !== articleRevision) return;
        const existingArticles = new Set(allFetchedArticles.map(a => a.id ?? a.url));
        for (const article of result.articles) {
          const identity = article.id ?? article.url;
          if (!existingArticles.has(identity)) { allFetchedArticles.push(article); existingArticles.add(identity); }
        }
        articlePage = nextPage;
        articleSearchTotal = result.total ?? articleSearchTotal;
        hasMoreArticles = result.hasMore;
        allArticlesCache = allFetchedArticles;
        applyFilters();
        btn.style.display = hasMoreArticles ? 'inline-flex' : 'none';
        const totalText = articleSearchTotal == null ? '' : ` of ${articleSearchTotal}`;
        info.textContent = hasMoreArticles ? `Showing ${allFetchedArticles.length}${totalText}` : `Showing ${allFetchedArticles.length}${totalText} - all loaded`;
        info.style.color = 'var(--text-muted)';
        updatePartialLoadError('Article pagination');
      } catch (e) {
        if (revision !== articleRevision) return;
        info.textContent = `Error loading articles: ${e.message || 'Request failed'}`;
        info.style.color = 'var(--danger)';
        updatePartialLoadError('Article pagination', e.message || 'Request failed');
      } finally {
        if (revision === articleRevision) {
        btn.disabled = false;
        btn.textContent = '⬇️ Load More';
        }
      }
    }

    async function doFullTextSearch() {
      const revision = ++articleRevision;
      const input = document.getElementById('fullTextSearch');
      const status = document.getElementById('searchStatus');
      const query = normalizeSearchQuery(input.value);
      articleSearchQuery = '';
      articleSearchTotal = null;
      articlePage = 0;
      hasMoreArticles = false;
      allFetchedArticles = [];
      activeFilters.search = '';
      saveFilters();
      const localFilter = document.getElementById('filterSearch');
      if (localFilter) localFilter.value = '';
      const loadBtn = document.getElementById('loadMoreBtn');
      if (loadBtn) { loadBtn.style.display = 'none'; loadBtn.disabled = false; loadBtn.textContent = '⬇️ Load More'; }
      const pagInfo = document.getElementById('paginationInfo');
      if (pagInfo) pagInfo.textContent = '';
      if (!query) { status.textContent = 'Showing the latest articles'; status.style.color = 'var(--text-muted)'; loadDashboard(); return; }
      if (query.length < 2) { status.textContent = 'Type at least 2 characters'; status.style.color = 'var(--warn)'; return; }
      articleSearchQuery = query;
      status.textContent = '🔍 Searching...'; status.style.color = 'var(--text-dim)';
      updatePartialLoadError('Article search');
      updatePartialLoadError('Article pagination');
      try {
        const result = await fetchArticlePage(articleSearchQuery, 0);
        if (revision !== articleRevision) return;
        allFetchedArticles = result.articles;
        allArticlesCache = allFetchedArticles;
        articleSearchTotal = result.total;
        hasMoreArticles = result.hasMore;
        if (!allFetchedArticles.length) {
          status.textContent = '❌ No results found';
          status.style.color = 'var(--danger)';
          renderArticles([], true);
        } else {
          const total = articleSearchTotal == null ? allFetchedArticles.length : articleSearchTotal;
          status.textContent = `✅ ${total} result${total === 1 ? '' : 's'} across all articles`;
          status.style.color = 'var(--lime)';
          applyFilters();
        }
        if (loadBtn) loadBtn.style.display = hasMoreArticles ? 'inline-flex' : 'none';
        if (pagInfo) pagInfo.textContent = hasMoreArticles ? `Showing ${allFetchedArticles.length} of ${articleSearchTotal ?? allFetchedArticles.length}` : `${allFetchedArticles.length} results`;
        updatePartialLoadError('Article search');
      } catch (e) {
        if (revision !== articleRevision) return;
        status.textContent = `❌ Error: ${e.message || 'Search failed'}`;
        status.style.color = 'var(--danger)';
        renderArticles([], true);
        updatePartialLoadError('Article search', e.message || 'Search failed');
      }
    }

    function doGlobalSearch() {
      const input = document.getElementById('globalSearch');
      const ft = document.getElementById('fullTextSearch');
      if (ft && input) { ft.value = input.value; }
      doFullTextSearch();
    }

    // ─── Chart tab listeners ──
    document.querySelectorAll('.chart-tabs button').forEach(btn => {
      btn.addEventListener('click', function() {
        this.parentElement.querySelectorAll('button').forEach(b => {
          b.classList.remove('active');
          b.setAttribute('aria-selected', 'false');
        });
        this.classList.add('active');
        this.setAttribute('aria-selected', 'true');
        loadDashboard();
      });
    });

    // ─── Init ──
    let refreshTimer = null;
    function startAutoRefresh() {
      if (refreshTimer === null && !document.hidden) refreshTimer = setInterval(loadDashboard, 300000);
    }
    function stopAutoRefresh() {
      if (refreshTimer !== null) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
    }
    loadDashboard();
    startAutoRefresh();
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) stopAutoRefresh();
      else { loadDashboard(); startAutoRefresh(); }
    });

    // Keyboard shortcuts
    document.addEventListener('keydown', (e) => {
      // Cmd+K or Ctrl+K to focus search
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        const input = document.getElementById('globalSearch');
        if (input) input.focus();
      }
      // / to focus search (Gmail-style)
      if (e.key === '/' && !e.ctrlKey && !e.metaKey && !['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        e.preventDefault();
        const input = document.getElementById('globalSearch');
        if (input) input.focus();
      }
    });

    document.addEventListener('click', event => {
      if (event.target.closest('a')) return;
      const section = event.target.closest('[data-section]');
      if (section) { switchSection(section.dataset.section, section); return; }
      const row = event.target.closest('[data-article-index]');
      if (row) { toggleArticleExpand(Number(row.dataset.articleIndex)); return; }
      const button = event.target.closest('[data-action]');
      if (!button) return;
      const actions = {
        config: showConfig, refresh: loadDashboard, clear: clearFilters,
        more: loadMoreArticles, export: exportCSV, save: saveConfig,
        home: () => { location.href = '/'; },
        impact: () => setFilter('impact', button.dataset.impact),
        glow: () => { const glow = document.getElementById('bgGlow'); glow.style.opacity = glow.style.opacity === '0' ? '0.5' : '0'; },
      };
      if (actions[button.dataset.action]) { event.preventDefault(); actions[button.dataset.action](); }
    });
    document.getElementById('globalSearch').addEventListener('keydown', event => { if (event.key === 'Enter') doGlobalSearch(); });
    document.getElementById('articleSearchForm').addEventListener('submit', event => { event.preventDefault(); doFullTextSearch(); });
    document.getElementById('filterSearch').addEventListener('input', onSearchChange);
    document.addEventListener('keydown', event => {
      const row = event.target.closest('[data-article-index]');
      if (row && event.target === row && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault(); toggleArticleExpand(Number(row.dataset.articleIndex));
      }
    });
