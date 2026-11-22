// Batch WebKit SERP runner for GitHub Actions. Reads QUERIES_JSON (a JSON
// array of query strings), fetches each from Startpage with one persistent
// WebKit browser (through PROXY_URL when set — Startpage blocks Azure/GH
// egress IPs outright, so the residential proxy provides the IP while GH
// provides free compute), falling back to DDG's html endpoint (Bing index,
// labeled source:"ddg" so the ingester never mistakes it for Google truth):
// a plain fetch first, then the same page in a proxy-less WebKit.
// Writes results.json: [{query, source, results:[{title,url,snippet}]}...].
const fs = require('fs');
const pw = require('playwright');

const queries = JSON.parse(process.env.QUERIES_JSON || '[]');
const GAP_MS = 3000;

// ENGINE SWITCH (2026-08-02): BROWSER=camoufox runs the batch on Camoufox (a
// Firefox stealth fork with C++-level fingerprint spoofing) instead of WebKit.
// The bet, proven on the RackNerd relay box the same day: Camoufox clears
// Startpage on a raw datacenter IP that WebKit gets walled on. GitHub's Azure
// runner IPs are exactly that kind of IP — WebKit walls them, so proxy-less
// accounts (reefhaus) fall all the way back to DDG. If Camoufox clears the
// Azure IP directly, those runs return real Google (Startpage) for $0 proxy
// cost. Falls back to WebKit if camoufox-js isn't installed.
const USE_CAMOUFOX = process.env.BROWSER === 'camoufox';
let Camoufox = null;
if (USE_CAMOUFOX) {
  try { Camoufox = require('camoufox-js').Camoufox; }
  catch { console.error('BROWSER=camoufox set but camoufox-js not installed — using WebKit'); }
}
// Returns a Playwright Browser. For Camoufox we use the high-level Camoufox()
// wrapper with headless:'virtual' — it manages the Xvfb virtual display and the
// env Camoufox needs itself (the low-level launchOptions+firefox.launch path
// segfaulted on the GH runners; the wrapper is camoufox-js's primary API).
async function launchBrowser(proxyOptions) {
  if (USE_CAMOUFOX && Camoufox) {
    // headless:true matches the proven RackNerd config (Debian 12, broad
    // playwright deps). CAMOUFOX_HEADLESS=virtual switches to the Xvfb path.
    const headless = process.env.CAMOUFOX_HEADLESS === 'virtual' ? 'virtual' : true;
    return Camoufox({ headless, geoip: !!proxyOptions.proxy, ...(proxyOptions.proxy ? { proxy: proxyOptions.proxy } : {}) });
  }
  return pw.webkit.launch({ headless: true, ...proxyOptions });
}

// Sticky exit per run (2026-08-02): the runner used a bare rotating proxy, so
// every query got a fresh exit IP against one cold context — clearance never
// held, the challenge re-walled, and this account's runs fell back to DDG far
// more than the others (observed: reefhausstudio-prog came back ddg-heavy).
// The relay-wk fleet fixed the identical problem by pinning ONE exit per boot
// so clearance earned on the first query holds for the rest (~90% ok vs cold).
// Pin one session for the whole run; the provider holds the IP up to 120 min.
// Disable with STICKY=0. randomBytes avoids a session collision across the
// parallel runs sharing the same proxy creds.
const SESSION_ID = require('crypto').randomBytes(4).toString('hex');

function proxyOpt() {
  const raw = String(process.env.PROXY_URL || '').trim();
  if (!raw) return {};
  try {
    const u = new URL(raw);
    let username = decodeURIComponent(u.username), password = decodeURIComponent(u.password);
    if (process.env.STICKY !== '0') {
      // Evomi pins via password params; DataImpulse via username suffix.
      if (/evomi/i.test(u.hostname)) password += `_session-${SESSION_ID}_lifetime-120`;
      else if (/dataimpulse/i.test(u.hostname)) username += `;sessid.${SESSION_ID};sessttl.120`;
    }
    return { proxy: { server: `${u.protocol}//${u.host}`, username, password } };
  } catch { return {}; }
}

let browser = null, ctx = null;
async function getCtx() {
  if (ctx) return ctx;
  const b = await launchBrowser(proxyOpt());
  // WebKit returns a Browser (→ newContext); the Camoufox() wrapper may return
  // a Browser or an already-open persistent context. Use newContext if present,
  // otherwise treat the returned object as the context.
  if (typeof b.newContext === 'function') { browser = b; ctx = await b.newContext({ viewport: { width: 1280, height: 900 } }); }
  else { browser = b.browser ? b.browser() : b; ctx = b; }
  // Lean mode (2026-07-31): runner traffic transits the residential proxy and
  // bills real GB. Abort heavy subresources AND every third-party host —
  // startpage.com's own document/scripts/xhr must pass (blocking its scripts
  // triggers the challenge wall, verified on the Fly fleet).
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
    // Anubis PoW wall (Startpage 2026-09-18): its solver worker fetches via
    // blob: URLs (empty hostname → aborted by the allowlist below, challenge
    // never solves). blob: is same-origin by construction; let it through.
    if (route.request().url().startsWith('blob:')) return route.continue();
    let host = '';
    try { host = new URL(route.request().url()).hostname; } catch {}
    if (t === 'document' || /(^|\.)startpage\.com$/.test(host) || /(^|\.)duckduckgo\.com$/.test(host)) return route.continue();
    return route.abort();
  });
  return ctx;
}

async function fetchStartpage(query) {
  let page = null;
  try {
    const c = await getCtx();
    page = await c.newPage();
    await page.goto(`https://www.startpage.com/sp/search?query=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 35000 });
    let title = await page.title();
    for (let w = 0; w < 6 && /just a moment|verification/i.test(title); w++) { await page.waitForTimeout(3000); title = await page.title(); }
    // Anubis interstitial (2026-09-18): empty-title challenge page; solves in
    // ~1-2s once its blob: worker passes the route diet, then navigates to the
    // real SERP. Wait it out before the parse.
    for (let w = 0; w < 8; w++) {
      const anubis = await page.evaluate(() => !!document.getElementById('anubis-main')).catch(() => false);
      if (!anubis) break;
      await page.waitForTimeout(1500);
    }
    await page.waitForTimeout(1500);
    const results = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.result, .w-gl__result, [class*="result"][class*="card"]');
      const o = [];
      for (const b of blocks) {
        const a = b.querySelector('a.result-link, a.w-gl__result-title, a[href^="http"]');
        if (!a) continue;
        let t = (b.querySelector('h2, h3') || b.querySelector('a.result-link, a.w-gl__result-title') || a).textContent.trim(); // 2026-09-18: [class*="title"] now hits wgl-site-title junk; real title = result-link anchor text
        t = t.replace(/^\.css-\S+\{[^}]*\}/g, '').trim().slice(0, 90);
        const snippet = (b.querySelector('p, [class*="description"], [class*="snippet"]') || {}).textContent || '';
        o.push({ title: t, url: a.href, snippet: snippet.trim().slice(0, 160) });
        if (o.length >= 12) break;
      }
      return o;
    });
    if (results.length) return { source: 'google-startpage', results };
    return { blockedTitle: title.slice(0, 100) };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  } finally {
    try { await page?.close(); } catch { }
  }
}

async function fetchDdg(query) {
  try {
    const r = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15' },
      signal: AbortSignal.timeout(20000),
    });
    if (r.status !== 200) return { error: `ddg ${r.status}` };
    const html = await r.text();
    const out = [];
    // Snippet is searched only inside this result's tail (up to the next
    // result__a): a trailing optional group after a lazy gap always matched
    // empty, so every DDG snippet came back "" (w433).
    const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>([\s\S]*?)(?=class="result__a"|$)/g;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/.exec(m[3]);
      let url = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(url);
      if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { } }
      const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      out.push({ title: strip(m[2]).slice(0, 90), url, snippet: strip(sn && sn[1]).slice(0, 160) });
    }
    if (!out.length) return { error: 'ddg parsed 0 results' };
    return { source: 'ddg', results: out };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

// DDG through a real browser, no proxy (class 79, 2026-11-16). Since 11/15 20:00Z DDG answers 202 (challenge page)
// to every plain fetch from a runner IP, html and lite, GET and POST; the same page loaded in WebKit from the same
// runner returns results. Its own browser so it never rides PROXY_URL (the proxy bills GB, this lane is free).
// Bing direct was tried first and is NOT a fallback: from runner IPs it serves results for the first word only
// (imdb and wikipedia for "emergency ..."), with cookies or in a browser alike.
let ddgMisses = 0, ddgBrowser = null, ddgCtx = null, ddgFull = 0;
async function fetchDdgBrowser(query) {
  let page = null;
  try {
    if (!ddgCtx) {
      ddgBrowser = await pw.webkit.launch({ headless: true });
      ddgCtx = await ddgBrowser.newContext({ viewport: { width: 1280, height: 900 } });
      await ddgCtx.route('**/*', (route) => (['image', 'media', 'font', 'stylesheet'].includes(route.request().resourceType()) ? route.abort() : route.continue()));
    }
    page = await ddgCtx.newPage();
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const results = await page.evaluate(() => {
      const o = [];
      for (const b of document.querySelectorAll('.result')) {
        if (b.className.includes('result--ad')) continue;
        const a = b.querySelector('a.result__a');
        if (!a) continue;
        let url = a.href;
        const m = /[?&]uddg=([^&]+)/.exec(url);
        if (m) { try { url = decodeURIComponent(m[1]); } catch { } }
        if (/^https?:\/\/([a-z0-9-]+\.)*duckduckgo\.com\//.test(url)) continue; // ad click-through rows
        const sn = b.querySelector('.result__snippet');
        o.push({ title: a.textContent.trim().slice(0, 90), url, snippet: (sn ? sn.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 160) });
        if (o.length >= 12) break;
      }
      return o;
    });
    if (results.length) return { source: 'ddg', results };
    // Duck challenge on the html page (class 80, 2026-11-22: "Unfortunately, bots use DuckDuckGo too", title
    // "DuckDuckGo"). Once it shows, every later html load in the run gets it too; a fresh context and the lite page
    // get the same wall. The full site answers the same query from the same runner, and html loads work again after it.
    const title = (await page.title()).slice(0, 60);
    await page.goto(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=web`, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('article[data-testid="result"]', { timeout: 8000 }).catch(() => { });
    const full = await page.evaluate(() => {
      const o = [];
      for (const b of document.querySelectorAll('article[data-testid="result"]')) {
        const a = b.querySelector('a[data-testid="result-title-a"]');
        if (!a || !/^https?:/.test(a.href) || /^https?:\/\/([a-z0-9-]+\.)*duckduckgo\.com\//.test(a.href)) continue;
        const sn = b.querySelector('[data-result="snippet"]');
        o.push({ title: a.textContent.trim().slice(0, 90), url: a.href, snippet: (sn ? sn.textContent : '').replace(/\s+/g, ' ').trim().slice(0, 160) });
        if (o.length >= 12) break;
      }
      return o;
    });
    if (!full.length) return { error: `ddg browser 0 results (${title}); ddg full site 0 results` };
    ddgFull++;
    return { source: 'ddg', results: full };
  } catch (e) {
    return { error: 'ddg browser ' + String(e.message || e).slice(0, 160) };
  } finally {
    try { await page?.close(); } catch { }
  }
}

async function main() {
  const out = [];
  for (const query of queries) {
    let r = await fetchStartpage(query);
    if (!r.results) {
      // Plain fetch first (free and fast when DDG is not walling runner IPs); three misses in a row and the run stops
      // asking that way. A miss goes to the browser fetch above.
      let fb = ddgMisses >= 3 ? { error: 'ddg fetch skipped (3 misses this run)' } : await fetchDdg(query);
      if (fb.results) ddgMisses = 0; else { ddgMisses++; const b = await fetchDdgBrowser(query); fb = b.results ? b : { error: `${fb.error}; ${b.error}` }; }
      r = fb.results ? fb : { ...r, ...fb };
    }
    out.push({ query, ...r });
    await new Promise(res => setTimeout(res, GAP_MS));
  }
  try { await browser?.close(); } catch { }
  try { await ddgBrowser?.close(); } catch { }
  fs.writeFileSync('results.json', JSON.stringify(out));
  const bySrc = {};
  for (const r of out) bySrc[r.source || 'fail'] = (bySrc[r.source || 'fail'] || 0) + 1;
  console.log('done:', JSON.stringify(bySrc), 'ddgFull', ddgFull);
}
main().catch(e => { console.error(e); process.exit(1); });
