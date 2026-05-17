#!/usr/bin/env node
// One-shot asset build. Regenerates the OG social card (1200x630) and
// compresses the landing-page images in place. Run with `node scripts/build-assets.js`.
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const puppeteer = require('puppeteer');

const SEO = path.join(__dirname, '..', 'public', 'seo');

async function buildOgCard() {
  const html = `<!DOCTYPE html><html><head><meta charset="UTF-8">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800&display=swap" rel="stylesheet">
  <style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:1200px;height:630px;font-family:'Inter',sans-serif;color:#fff;overflow:hidden}
    body{
      background:
        radial-gradient(ellipse at 20% 30%, rgba(59,130,246,.55) 0%, transparent 60%),
        radial-gradient(ellipse at 85% 75%, rgba(29,78,216,.45) 0%, transparent 55%),
        linear-gradient(135deg, #0b1426 0%, #0f1b35 50%, #1a2547 100%);
      display:flex;align-items:center;padding:80px 90px;position:relative;
    }
    body::before{
      content:'';position:absolute;inset:0;
      background-image:
        linear-gradient(rgba(96,165,250,.06) 1px, transparent 1px),
        linear-gradient(90deg, rgba(96,165,250,.06) 1px, transparent 1px);
      background-size:48px 48px;
      mask-image:radial-gradient(ellipse at center, black 0%, transparent 75%);
    }
    .wrap{position:relative;z-index:1;max-width:880px}
    .brand{display:flex;align-items:center;gap:14px;margin-bottom:42px}
    .logo{
      width:60px;height:60px;border-radius:14px;
      background:linear-gradient(135deg,#3b82f6,#1d4ed8);
      display:flex;align-items:center;justify-content:center;
      font-size:32px;font-weight:800;color:#fff;
      box-shadow:0 10px 30px rgba(59,130,246,.4);
    }
    .brand-name{font-size:28px;font-weight:700;letter-spacing:-.01em}
    .brand-name em{font-style:normal;color:#60a5fa}
    h1{
      font-size:72px;font-weight:800;line-height:1.08;letter-spacing:-.02em;
      margin-bottom:28px;
    }
    h1 .accent{
      background:linear-gradient(135deg,#60a5fa 0%,#c084fc 100%);
      -webkit-background-clip:text;background-clip:text;color:transparent;
    }
    .sub{
      font-size:28px;font-weight:500;color:#cbd5e1;line-height:1.4;
      max-width:780px;
    }
    .footer{
      position:absolute;bottom:60px;left:90px;right:90px;z-index:1;
      display:flex;justify-content:space-between;align-items:center;
      font-size:18px;color:#94a3b8;font-weight:500;
    }
    .footer .url{color:#60a5fa;font-weight:600}
    .pill{
      display:inline-flex;align-items:center;gap:8px;
      padding:8px 16px;border-radius:99px;
      background:rgba(96,165,250,.15);border:1px solid rgba(96,165,250,.3);
      font-size:14px;font-weight:600;color:#93c5fd;letter-spacing:.04em;
      text-transform:uppercase;margin-bottom:24px;
    }
    .pill::before{content:'';width:6px;height:6px;border-radius:99px;background:#22c55e}
  </style></head><body>
    <div class="wrap">
      <div class="brand">
        <div class="logo">F</div>
        <div class="brand-name">Forge <em>AI</em></div>
      </div>
      <div class="pill">AI-Powered Growth</div>
      <h1>Professional Websites for <span class="accent">Local Businesses.</span></h1>
      <p class="sub">Free demo sites, AI chatbots, and automated follow-ups. No credit card. No commitment.</p>
    </div>
    <div class="footer">
      <span>Built by AI, in minutes, not weeks.</span>
      <span class="url">forgeaiagent.com</span>
    </div>
  </body></html>`;

  const browser = await puppeteer.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1200, height: 630, deviceScaleFactor: 1 });
    await page.setContent(html, { waitUntil: 'networkidle0' });
    const pngBuf = await page.screenshot({ type: 'png', clip: { x: 0, y: 0, width: 1200, height: 630 } });
    // Recompress as JPEG for smaller OG payload (social platforms accept both).
    const out = path.join(SEO, 'og-image.jpg');
    const jpegBuf = await sharp(pngBuf).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
    fs.writeFileSync(out, jpegBuf);
    // Clean up the old PNG if it exists from a previous run.
    const oldPng = path.join(SEO, 'og-image.png');
    if (fs.existsSync(oldPng)) fs.unlinkSync(oldPng);
    console.log(`[og] wrote ${out} (${fs.statSync(out).size} bytes)`);
  } finally {
    await browser.close();
  }
}

async function compress(file, opts) {
  const full = path.join(SEO, file);
  if (!fs.existsSync(full)) return console.log(`[skip] ${file}`);
  const before = fs.statSync(full).size;
  const buf = fs.readFileSync(full);
  const out = await sharp(buf)
    .resize({ width: opts.width, withoutEnlargement: true })
    .jpeg({ quality: opts.quality, mozjpeg: true })
    .toBuffer();
  fs.writeFileSync(full, out);
  const after = fs.statSync(full).size;
  console.log(`[img] ${file}: ${before} -> ${after} bytes (${Math.round((1 - after / before) * 100)}% smaller)`);
}

(async () => {
  await buildOgCard();
  await compress('founder.jpg', { width: 640, quality: 82 });
  await compress('demo-magic-flower-shop.jpg', { width: 900, quality: 78 });
  await compress('demo-dtla-smile.jpg', { width: 900, quality: 78 });
  await compress('demo-fitness-forum.jpg', { width: 900, quality: 78 });
})().catch(e => { console.error(e); process.exit(1); });
