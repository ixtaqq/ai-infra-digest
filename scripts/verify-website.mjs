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
const profilePath = join(tmpdir(), "ai-infra-website-verification");

if (!browserPath) {
  throw new Error("No supported browser found. Set BROWSER_PATH to Edge, Chrome, or Chromium.");
}

const browser = spawn(browserPath, [
  "--headless=new",
  "--disable-gpu",
  "--disable-background-mode",
  "--disable-extensions",
  `--remote-debugging-port=${port}`,
  `--user-data-dir=${profilePath}`,
  "about:blank",
], { stdio: "ignore" });
browser.unref();

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function connect() {
  for (let attempt = 0; attempt < 30; attempt += 1) {
    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/json/new?${encodeURIComponent(targetUrl)}`,
        { method: "PUT", signal: AbortSignal.timeout(500) },
      );
      if (response.ok) return response.json();
    } catch {
      // Browser startup is asynchronous.
    }
    await delay(100);
  }
  throw new Error("Timed out connecting to the headless browser");
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
    const response = await call("Runtime.evaluate", { returnByValue: true, expression });
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
    results.push({ width, ...evaluation });
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
    const stopProfile = `$profile='${escapedProfile}'; 1..3 | ForEach-Object { $ids=@(Get-CimInstance Win32_Process -Filter "Name='msedge.exe'" | Where-Object { $_.CommandLine -like "*$profile*" } | Select-Object -ExpandProperty ProcessId); if($ids.Count -gt 0){ Stop-Process -Id $ids -Force -ErrorAction SilentlyContinue }; Start-Sleep -Milliseconds 100 }`;
    spawnSync("powershell.exe", ["-NoProfile", "-Command", stopProfile], { stdio: "ignore" });
  } else {
    browser.kill("SIGTERM");
  }
}

process.exit(process.exitCode || 0);
