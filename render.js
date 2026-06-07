// Renders render/latest/*.html -> render/out/*.png, commits the PNGs back,
// then posts the caption + 4 images to Slack via an Incoming Webhook.
// Runs inside GitHub Actions (env vars GITHUB_* are provided automatically).

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = process.env.GITHUB_REPOSITORY;                 // "owner/repo"
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const SHA = (process.env.GITHUB_SHA || 'x').slice(0, 8);    // cache-buster for Slack
const WEBHOOK = process.env.SLACK_WEBHOOK;

const SECTIONS = ['summary', 'ow', 'human', 'tables'];
const TITLES = { summary: 'Summary', ow: 'Overwatch Performance', human: 'Human Side', tables: 'Ticket Status & Escalations' };
const LATEST = 'render/latest';
const OUT = 'render/out';

function postSlack(payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(WEBHOOK);
    const data = JSON.stringify(payload);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () =>
        (res.statusCode >= 200 && res.statusCode < 300) ? resolve(b) : reject(new Error('slack ' + res.statusCode + ' ' + b))); }
    );
    req.on('error', reject); req.write(data); req.end();
  });
}

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

  let caption = ':bar_chart: *DAILY BUSINESS REPORT*';
  try { caption = fs.readFileSync(path.join(LATEST, 'caption.txt'), 'utf8').trim(); } catch (e) {}

  const base = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + OUT;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: caption } }];
  for (const name of SECTIONS) {
    if (!fs.existsSync(path.join(OUT, name + '.png'))) continue;
    blocks.push({ type: 'image', image_url: base + '/' + name + '.png?v=' + SHA, alt_text: TITLES[name] });
  }
  await postSlack({ blocks });
  console.log('posted to slack');
})().catch(e => { console.error(e); process.exit(1); });
