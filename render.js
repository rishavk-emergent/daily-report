// Renders render/latest/*.html -> render/out/*.png and commits the PNGs back.
// (Slack posting happens in Zapier, which posts these public raw URLs and lets
// Slack unfurl them as inline images — so no webhook/secret is needed here.)
// Runs inside GitHub Actions (GITHUB_* env vars are provided automatically).

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer');

const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const SECTIONS = ['summary', 'ow', 'human', 'tables'];
const LATEST = 'render/latest';
const OUT = 'render/out';

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  for (const name of SECTIONS) {
    const f = path.join(LATEST, name + '.html');
    if (!fs.existsSync(f)) { console.log('skip (missing): ' + f); continue; }
    const html = fs.readFileSync(f, 'utf8');
    const page = await browser.newPage();
    await page.setViewport({ width: 1244, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(OUT, name + '.png'), type: 'png', fullPage: true });
    await page.close();
    console.log('rendered ' + name);
  }
  await browser.close();

  // Commit the PNGs back so they get public raw URLs. render/out/** is NOT a
  // trigger path, so this push does not re-run the workflow.
  execSync('git config user.name "report-bot"');
  execSync('git config user.email "report-bot@users.noreply.github.com"');
  execSync('git add ' + OUT);
  try { execSync('git commit -m "render pngs [skip ci]"', { stdio: 'inherit' }); }
  catch (e) { console.log('nothing to commit'); }
  execSync('git push origin HEAD:' + BRANCH, { stdio: 'inherit' });
  console.log('done');
})().catch(e => { console.error(e); process.exit(1); });
