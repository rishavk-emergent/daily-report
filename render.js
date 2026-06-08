// Renders render/latest/*.html -> PNGs and UPLOADS them directly to Slack
// (files_upload_v2) as native inline images with a caption. No repo/URL needed.
// Runs inside GitHub Actions.

const fs = require('fs');
const path = require('path');
const https = require('https');
const puppeteer = require('puppeteer');

const SLACK_TOKEN = process.env.SLACK_BOT_TOKEN;
const SLACK_CHANNEL = process.env.SLACK_CHANNEL;

const SECTIONS = [
  { key: 'r1', title: '📊 Volume & Automation' },
  { key: 'r2', title: '⏱️ Resolution TAT (p50/p75/p90)' },
  { key: 'r3', title: '😊 CSAT & Reopen' },
];
const LATEST = 'render/latest';
const OUT = 'render/out';

function slackGet(method, qs) {
  return new Promise((resolve, reject) => {
    const req = https.request(
      { hostname: 'slack.com', path: '/api/' + method + '?' + qs, method: 'GET',
        headers: { 'Authorization': 'Bearer ' + SLACK_TOKEN } },
      (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => {
        let j = {}; try { j = JSON.parse(b); } catch (e) {}
        j.ok ? resolve(j) : reject(new Error(method + ': ' + (j.error || b))); }); });
    req.on('error', reject); req.end();
  });
}

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

function uploadBytes(uploadUrl, buf, filename) {
  return new Promise((resolve, reject) => {
    const u = new URL(uploadUrl);
    const boundary = '----dr' + Buffer.from(filename).toString('hex').slice(0, 12) + buf.length;
    const head = Buffer.from('--' + boundary + '\r\nContent-Disposition: form-data; name="file"; filename="' +
      filename + '"\r\nContent-Type: image/png\r\n\r\n');
    const tail = Buffer.from('\r\n--' + boundary + '--\r\n');
    const body = Buffer.concat([head, buf, tail]);
    const req = https.request(
      { hostname: u.hostname, path: u.pathname + u.search, method: 'POST',
        headers: { 'Content-Type': 'multipart/form-data; boundary=' + boundary, 'Content-Length': body.length } },
      (res) => { let b = ''; res.on('data', d => b += d); res.on('end', () => resolve(b)); });
    req.on('error', reject); req.write(body); req.end();
  });
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--font-render-hinting=none'],
  });
  const ready = [];
  for (const s of SECTIONS) {
    const f = path.join(LATEST, s.key + '.html');
    if (!fs.existsSync(f)) { console.log('skip (missing): ' + f); continue; }
    const html = fs.readFileSync(f, 'utf8');
    const page = await browser.newPage();
    await page.setViewport({ width: 1244, height: 800, deviceScaleFactor: 2 });
    await page.setContent(html, { waitUntil: 'networkidle0', timeout: 30000 });
    await new Promise(r => setTimeout(r, 600));
    const out = path.join(OUT, s.key + '.png');
    await page.screenshot({ path: out, type: 'png', fullPage: true });
    await page.close();
    ready.push({ ...s, file: out });
    console.log('rendered ' + s.key);
  }
  await browser.close();

  let caption = ':bar_chart: *DAILY BUSINESS REPORT*';
  try { caption = fs.readFileSync(path.join(LATEST, 'caption.txt'), 'utf8').trim(); } catch (e) {}

  // files_upload_v2: get upload URL -> POST bytes -> complete (all files in one message)
  const uploaded = [];
  for (const s of ready) {
    const buf = fs.readFileSync(s.file);
    const g = await slackGet('files.getUploadURLExternal', 'filename=' + s.key + '.png&length=' + buf.length);
    await uploadBytes(g.upload_url, buf, s.key + '.png');
    uploaded.push({ id: g.file_id, title: s.title });
    console.log('uploaded ' + s.key);
  }
  await slackPostJSON('files.completeUploadExternal', {
    files: uploaded,
    channel_id: SLACK_CHANNEL,
    initial_comment: caption,
  });
  console.log('posted to slack (' + uploaded.length + ' images)');
})().catch(e => { console.error(e); process.exit(1); });
