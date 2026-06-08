// Renders render/latest/*.html -> render/out/*.png, commits the PNGs back,
// then posts caption + 4 TITLED images to Slack via Block Kit (bot token).
// Clean inline images, no raw URL text. Runs inside GitHub Actions.

const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const puppeteer = require('puppeteer');

const REPO = process.env.GITHUB_REPOSITORY;                 // "owner/repo"
const BRANCH = process.env.GITHUB_REF_NAME || 'main';
const SHA = (process.env.GITHUB_SHA || 'x').slice(0, 8);    // cache-buster for Slack
const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

const SECTIONS = [
  { key: 'summary', title: '📊 Summary' },
  { key: 'ow',      title: '🤖 Overwatch Performance' },
  { key: 'human',   title: '👤 Human Side' },
  { key: 'tables',  title: '📋 Ticket Status & Escalations' },
];
const LATEST = 'render/latest';
const OUT = 'render/out';

function slackPost(method, payload) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(payload);
    const req = https.request(
      { hostname: 'slack.com', path: '/api/' + method, method: 'POST',
        headers: { 'Content-Type': 'application/json; charset=utf-8',
                   'Authorization': 'Bearer ' + SLACK_TOKEN,
                   'Content-Length': Buffer.byteLength(data) } },
      (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch (e) {}
        j.ok ? resolve(j) : reject(new Error(method + ' failed: ' + (j.error || b))); }); }
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

  // Commit PNGs so they have public raw URLs for the image blocks.
  // render/out/** is not a trigger path -> no loop.
  execSync('git config user.name "report-bot"');
  execSync('git config user.email "report-bot@users.noreply.github.com"');
  execSync('git add ' + OUT);
  try { execSync('git commit -m "render pngs [skip ci]"', { stdio: 'inherit' }); }
  catch (e) { console.log('nothing to commit'); }
  execSync('git push origin HEAD:' + BRANCH, { stdio: 'inherit' });

  let caption = ':bar_chart: *DAILY BUSINESS REPORT*';
  try { caption = fs.readFileSync(path.join(LATEST, 'caption.txt'), 'utf8').trim(); } catch (e) {}

  // Build Block Kit: caption section + one titled image block per section.
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
  await slackPost('chat.postMessage', {
    channel: SLACK_CHANNEL,
    text: caption,          // fallback for notifications
    blocks: blocks,
    unfurl_links: false,
    unfurl_media: false,
  });
  console.log('posted to slack');
})().catch(e => { console.error(e); process.exit(1); });
