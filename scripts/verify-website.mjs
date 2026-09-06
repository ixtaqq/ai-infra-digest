import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const browserCandidates = process.platform === "win32"
  ? [
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    ]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const browserPath = process.env.BROWSER_PATH || browserCandidates.find(existsSync);
const targetUrl = process.argv[2] || "http://127.0.0.1:4321/dashboard/";
const port = 9200 + (process.pid % 500);
const profilePath = join(tmpdir(), `ai-infra-website-verification-${process.pid}`);

if (!browserPath) {
  throw new Error("No supported browser found. Set BROWSER_PATH to Edge, Chrome, or Chromium.");
}

const browserArgs = [
  "--headless=new",
  "--disable-gpu",
  "--disable-background-mode",
  "--disable-extensions",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profilePath}`,
  "about:blank",
];
if (process.platform === "linux") {
  browserArgs.push("--no-sandbox", "--disable-dev-shm-usage");
}

const browser = spawn(browserPath, browserArgs, { stdio: ["ignore", "pipe", "pipe"] });
let browserStderr = "";
browser.stderr.setEncoding("utf8");
browser.stderr.on("data", (chunk) => { browserStderr += chunk; });
let browserExit;
let browserError;
browser.once("error", (error) => { browserError = error; });
browser.once("exit", (code, signal) => { browserExit = `code=${code ?? "?"}, signal=${signal ?? "?"}`; });
browser.unref();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (browserError) {
      throw new Error(`Failed to start headless browser: ${browserError.message}; ${browserStderr.trim() || "no diagnostics"}`);
    }
    if (browserExit) {
      throw new Error(`Headless browser exited before connecting (${browserExit}): ${browserStderr.trim() || "no diagnostics"}`);
    }
    const remaining = deadline - Date.now();
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`,
        { method: "PUT", signal: AbortSignal.timeout(Math.min(500, remaining)) },
      );
      if (response.ok) return response.json();
    } catch {
      // Browser startup is asynchronous.
    }
    await delay(Math.min(250, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out connecting to the headless browser after 30s: ${browserStderr.trim() || "no diagnostics"}`);
}

async function verify() {
  const tab = await connect();
  const socket = new WebSocket(tab.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", reject, { once: true });
  });

  let requestId = 0;
  const pending = new Map();
  const browserErrors = [];
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
    if (message.method === "Runtime.exceptionThrown") {
      browserErrors.push(message.params.exceptionDetails.text);
    }
  });

  const call = (method, params = {}) => new Promise((resolve) => {
    const id = ++requestId;
    pending.set(id, resolve);
    socket.send(JSON.stringify({ id, method, params }));
  });

  await call("Page.enable");
  await call("Runtime.enable");
  const evaluate = async (expression) => {
    const response = await call("Runtime.evaluate", { returnByValue: true, awaitPromise: true, expression });
    if (response.error || response.result?.exceptionDetails) {
      throw new Error(JSON.stringify(response.error || response.result.exceptionDetails));
    }
    return response.result.result.value;
  };

  const waitUntilReady = async () => {
    let lastError = "document not ready";
    for (let attempt = 0; attempt < 30; attempt += 1) {
      try {
        if (await evaluate("document.readyState === 'complete' && Boolean(document.querySelector('h1'))")) return;
      } catch (error) {
        lastError = error.message;
        // Navigation can replace the execution context between polls.
      }
      await delay(100);
    }
    throw new Error(`Dashboard did not become ready: ${lastError}`);
  };

  const results = [];
  for (const width of [320, 768, 1024, 1440]) {
    await call("Emulation.setDeviceMetricsOverride", {
      width,
      height: 900,
      deviceScaleFactor: 1,
      mobile: width < 769,
    });
    const navigation = await call("Page.navigate", { url: targetUrl });
    if (navigation.result?.errorText) {
      throw new Error(`Navigation failed: ${navigation.result.errorText}`);
    }
    await waitUntilReady();

    const pagination = await evaluate(`(async () => {
      const fixtures = Array.from({ length: 45 }, (_, i) => ({ id: i + 1,
        title: 'Fixture article ' + (i + 1), url: 'https://example.com/' + i,
        source: 'Fixture', category: 'Chips & GPUs', impact: 'Neutral',
        impact_score: 7, affected_stocks: ['NVDA'], summary: 'Synthetic coverage' }));
      const originalFetch = fetchArticlePage;
      fetchArticlePage = async (_query, offset) => ({ articles: fixtures.slice(offset, offset + 20), total: 45, hasMore: offset + 20 < 45 });
      activeFilters.search = ''; activeFilters.sector = ''; activeFilters.impact = '';
      allFetchedArticles = fixtures.slice(0, 20); allArticlesCache = allFetchedArticles;
      articlePage = 0; articleSearchQuery = ''; hasMoreArticles = true;
      renderArticles(allFetchedArticles, false);
      const counts = [document.querySelectorAll('#articlesBody tr[id^="article-detail-"]').length];
      await loadMoreArticles();
      counts.push(document.querySelectorAll('#articlesBody tr[id^="article-detail-"]').length);
      await loadMoreArticles();
      counts.push(document.querySelectorAll('#articlesBody tr[id^="article-detail-"]').length);
      const complete = !hasMoreArticles;
      const lastReachable = document.getElementById('articlesBody').textContent.includes('Fixture article 45');
      let releaseOld;
      fetchArticlePage = (query) => query === 'older'
        ? new Promise(resolve => { releaseOld = resolve; })
        : Promise.resolve({ articles: [fixtures[44]], total: 1, hasMore: false });
      document.getElementById('fullTextSearch').value = 'older';
      const older = doFullTextSearch();
      document.getElementById('fullTextSearch').value = 'newer';
      await doFullTextSearch();
      releaseOld({ articles: [fixtures[0]], total: 1, hasMore: false });
      await older;
      const latestSearchWon = allFetchedArticles.length === 1 && allFetchedArticles[0].id === 45;
      fetchArticlePage = originalFetch;
      return { counts, complete, lastReachable, latestSearchWon };
    })()`);
    if (JSON.stringify(pagination.counts) !== '[20,40,45]' || !pagination.complete || !pagination.lastReachable || !pagination.latestSearchWon) {
      throw new Error('Accumulated pagination regression: ' + JSON.stringify(pagination));
    }

    const evaluation = await evaluate(`(() => {
        const root = document.documentElement;
        const heading = document.querySelector('h1');
        const config = document.getElementById('configPanel');
        if (config && getComputedStyle(config).display === 'none') showConfig();
        const configText = config?.textContent || '';
        return {
          innerWidth,
          scrollWidth: root.scrollWidth,
          overflow: root.scrollWidth > innerWidth + 1,
          headingWithinViewport: !heading || heading.getBoundingClientRect().right <= innerWidth + 1,
          sidebarWidth: document.querySelector('.sidebar')?.getBoundingClientRect().width || 0,
          liveVisible: getComputedStyle(document.querySelector('.live-chip')).display !== 'none',
          configUsesPublicKeyLanguage: /public anon or publishable key/i.test(configText),
          configWarnsAgainstServiceRole: /never enter a service-role key/i.test(configText),
        };
      })()`);
    results.push({ width, pagination, ...evaluation });
  }

  console.log(JSON.stringify({ results, browserErrors }, null, 2));

  if (
    browserErrors.length > 0 ||
    results.some((result) =>
      result.overflow ||
      !result.headingWithinViewport ||
      !result.configUsesPublicKeyLanguage ||
      !result.configWarnsAgainstServiceRole
    )
  ) {
    process.exitCode = 1;
  }

  socket.close();
}

try {
  await verify();
} finally {
  if (process.platform === "win32") {
    const escapedProfile = profilePath.replaceAll("'", "''");
    const stopProfile = `$profile='${escapedProfile}'; 1..3 | ForEach-Object { $ids=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe' OR Name='chrome.exe'" | Where-Object { $_.CommandLine -like "*$profile*" } | Select-Object -ExpandProperty ProcessId); if($ids.Count -gt 0){ Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }`;
    spawnSync("powershell.exe", ["-NoProfile", "-Command", stopProfile], { stdio: "ignore" });
  } else {
    browser.kill("SIGTERM");
  }
}

process.exit(process.exitCode || 0);
