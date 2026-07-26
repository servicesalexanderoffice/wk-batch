// Batch WebKit SERP runner for GitHub Actions. Reads QUERIES_JSON (a JSON
// array of query strings), fetches each from Startpage with one persistent
// WebKit browser, writes results.json: [{query, results:[{title,url,snippet}]}
// | {query, wall:true} | {query, error}]. Mirrors relay-wk/server.js exactly —
// the wall there is TLS-fingerprint-based, which real WebKit passes.
const fs = require('fs');
const pw = require('playwright');

const queries = JSON.parse(process.env.QUERIES_JSON || '[]');
const GAP_MS = 3000;

async function main() {
  const browser = await pw.webkit.launch({ headless: true });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  await ctx.route('**/*', (route) => {
    const t = route.request().resourceType();
    if (['image', 'media', 'font', 'stylesheet'].includes(t)) return route.abort();
    route.continue();
  });
  const out = [];
  for (const query of queries) {
    let page = null;
    try {
      page = await ctx.newPage();
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
      if (!results.length) {
        const size = (await page.content()).length;
        out.push({ query, wall: size < 20000, results: [], pageTitle: title.slice(0, 100) });
      } else {
        out.push({ query, results });
      }
    } catch (e) {
      out.push({ query, error: String(e.message || e).slice(0, 200) });
    } finally {
      try { await page?.close(); } catch { }
    }
    await new Promise(r => setTimeout(r, GAP_MS));
  }
  await browser.close().catch(() => {});
  fs.writeFileSync('results.json', JSON.stringify(out));
  const ok = out.filter(r => r.results && r.results.length).length;
  console.log(`done: ${ok}/${queries.length} queries returned results`);
}
main().catch(e => { console.error(e); process.exit(1); });
