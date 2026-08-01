// Batch WebKit SERP runner for GitHub Actions. Reads QUERIES_JSON (a JSON
// array of query strings), fetches each from Startpage with one persistent
// WebKit browser (through PROXY_URL when set — Startpage blocks Azure/GH
// egress IPs outright, so the residential proxy provides the IP while GH
// provides free compute), falling back to DDG's html endpoint (Bing index,
// labeled source:"ddg" so the ingester never mistakes it for Google truth).
// Writes results.json: [{query, source, results:[{title,url,snippet}]}...].
const fs = require('fs');
const pw = require('playwright');

const queries = JSON.parse(process.env.QUERIES_JSON || '[]');
const GAP_MS = 3000;

function proxyOpt() {
  const raw = String(process.env.PROXY_URL || '').trim();
  if (!raw) return {};
  try {
    const u = new URL(raw);
    return { proxy: { server: `${u.protocol}//${u.host}`, username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } };
  } catch { return {}; }
}

let browser = null, ctx = null;
async function getCtx() {
  if (ctx) return ctx;
  browser = await pw.webkit.launch({ headless: true, ...proxyOpt() });
  ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  // Lean mode (2026-07-31): runner traffic transits the residential proxy and
  // bills real GB. Abort heavy subresources AND every third-party host —
  // startpage.com's own document/scripts/xhr must pass (blocking its scripts
  // triggers the challenge wall, verified on the Fly fleet).
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
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
    await page.waitForTimeout(1500);
    const results = await page.evaluate(() => {
      const blocks = document.querySelectorAll('.result, .w-gl__result, [class*="result"][class*="card"]');
      const o = [];
      for (const b of blocks) {
        const a = b.querySelector('a.result-link, a.w-gl__result-title, a[href^="http"]');
        if (!a) continue;
        let t = (b.querySelector('h2, h3') || b.querySelector('[class*="title"]') || a).textContent.trim();
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
    const re = /class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m;
    while ((m = re.exec(html)) && out.length < 12) {
      let url = m[1];
      const uddg = /[?&]uddg=([^&]+)/.exec(url);
      if (uddg) { try { url = decodeURIComponent(uddg[1]); } catch { } }
      const strip = (s) => String(s || '').replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
      out.push({ title: strip(m[2]).slice(0, 90), url, snippet: strip(m[3]).slice(0, 160) });
    }
    if (!out.length) return { error: 'ddg parsed 0 results' };
    return { source: 'ddg', results: out };
  } catch (e) {
    return { error: String(e.message || e).slice(0, 200) };
  }
}

async function main() {
  const out = [];
  for (const query of queries) {
    let r = await fetchStartpage(query);
    if (!r.results) {
      const fb = await fetchDdg(query);
      r = fb.results ? fb : { ...r, ...fb };
    }
    out.push({ query, ...r });
    await new Promise(res => setTimeout(res, GAP_MS));
  }
  try { await browser?.close(); } catch { }
  fs.writeFileSync('results.json', JSON.stringify(out));
  const bySrc = {};
  for (const r of out) bySrc[r.source || 'fail'] = (bySrc[r.source || 'fail'] || 0) + 1;
  console.log('done:', JSON.stringify(bySrc));
}
main().catch(e => { console.error(e); process.exit(1); });
