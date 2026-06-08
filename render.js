// Renders render/<src>/*.html -> PNGs, commits them back (public raw URLs),
// then posts caption + titled image blocks to Slack via chat.postMessage.
// Block Kit image blocks reliably post (unlike files_upload_v2 external sharing)
// and show the image inline with a title, no visible URL.
// Directory-configurable: daily uses render/latest, weekly overrides via env.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = process.env.GITHUB_REPOSITORY;
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const SHA = (process.env.GITHUB_SHA || 'x').slice(0, 8);
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;
const LATEST = process.env.RENDER_SRC || 'render/latest';
const OUT = process.env.RENDER_OUT || 'render/out';

const SECTIONS = [
  { key: 'r1', title: '📊 Volume & Automation' },
  { key: 'r2', title: '⏱️ Resolution TAT (p50/p75/p90)' },
  { key: 'r3', title: '😊 CSAT & Reopen' },
];

function slackPostJSON(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request(
      { hostname: 'slack.com', path: '/api/' + method, method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8',
                   'Authorization': 'Bearer ' + SLACK_TOKEN,
                   'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch (e) {}
        j.ok ? resolve(j) : reject(new Error(method + ': ' + (j.error || b))); }); });
    req.on('error', reject); req.write(data); req.end();
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  for (const s of SECTIONS) {
    const f = path.join(LATEST, s.key + '.html');
    if (!fs.existsSync(f)) { console.log('skip (missing): ' + f); continue; }
    const html = fs.readFileSync(f, 'utf8');
    const page = await browser.newPage();
    await page.setViewport({ width: 1244, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 600));
    await page.screenshot({ path: path.join(OUT, s.key + '.png'), type: 'png', fullPage: true });
    await page.close();
    console.log('rendered ' + s.key);
  }
  await browser.close();

  // Commit PNGs so they have public raw URLs (OUT is not a trigger path -> no loop).
  execSync('git config user.name "report-bot"');
  execSync('git config user.email "report-bot@users.noreply.github.com"');
  execSync('git add ' + OUT);
  try { execSync('git commit -m "render pngs [skip ci]"', { stdio: 'inherit' }); }
  catch (e) { console.log('nothing to commit'); }
  execSync('git push origin HEAD:' + BRANCH, { stdio: 'inherit' });

  let caption = ':bar_chart: *CUSTOMER SUCCESS REPORT*';
  try { caption = fs.readFileSync(path.join(LATEST, 'caption.txt'), 'utf8').trim(); } catch (e) {}

  const base = 'https://raw.githubusercontent.com/' + REPO + '/' + BRANCH + '/' + OUT;
  const blocks = [{ type: 'section', text: { type: 'mrkdwn', text: caption } }];
  for (const s of SECTIONS) {
    if (!fs.existsSync(path.join(OUT, s.key + '.png'))) continue;
    blocks.push({
      type: 'image',
      title: { type: 'plain_text', text: s.title, emoji: true },
      image_url: base + '/' + s.key + '.png?v=' + SHA,
      alt_text: s.title,
    });
  }
  await slackPostJSON('chat.postMessage', {
    channel: SLACK_CHANNEL, text: caption, blocks: blocks,
    unfurl_links: false, unfurl_media: false,
  });
  console.log('posted to slack');
})().catch(e => { console.error(e); process.exit(1); });
