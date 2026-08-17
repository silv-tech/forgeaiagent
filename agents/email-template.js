// Shared HTML email template. Used by the outreach agent (live sends)
// and the test-outreach script. Designed to render cleanly in Gmail,
// Apple Mail, Outlook, and mobile clients.
//
// Structure is table-based for Outlook compatibility. All styling is
// inline so nothing is stripped by email clients.

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Strip any URL that made it into the generated body. The CTA button now
// carries the demo link, so leaving URLs inline reads like spam.
function stripUrls(text) {
  return String(text || '')
    // Remove bare URLs and any "here:" / "at:" lead-ins that become dangling.
    .replace(/\bhere:\s*(https?:\/\/\S+)/gi, 'below')
    .replace(/\bat:\s*(https?:\/\/\S+)/gi, 'below')
    .replace(/\bvisit\s+(https?:\/\/\S+)/gi, 'have a look below')
    .replace(/https?:\/\/\S+/g, '')
    // Clean up double spaces and empty lines left over.
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function paragraphsFrom(text) {
  return stripUrls(text)
    .split('\n')
    .map(line => {
      const l = line.trim();
      if (!l) return '<div style="height:10px;line-height:10px">&nbsp;</div>';
      return `<p style="margin:0 0 16px;font-size:15px;line-height:1.7;color:#334155">${esc(l)}</p>`;
    })
    .join('');
}

function renderChecklist(items) {
  if (!items || !items.length) return '';
  const rows = items.map(item => `
    <tr>
      <td width="28" style="padding:6px 0;vertical-align:top">
        <table cellpadding="0" cellspacing="0" border="0"><tr>
          <td width="20" height="20" align="center" valign="middle" style="background:#dcfce7;border-radius:999px;color:#16a34a;font-weight:900;font-size:12px;line-height:20px;font-family:-apple-system,BlinkMacSystemFont,Arial,sans-serif">&#10003;</td>
        </tr></table>
      </td>
      <td style="padding:6px 0 6px 10px;font-size:14.5px;color:#334155;line-height:1.55;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${esc(item)}</td>
    </tr>`).join('');
  return `
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:4px 0 0">
      ${rows}
    </table>`;
}

function renderButton(href, label) {
  // Table-based button for maximum client compatibility.
  return `
    <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="margin:8px 0 4px">
      <tr>
        <td align="center" style="border-radius:10px;background:#2563eb;box-shadow:0 4px 14px rgba(37,99,235,0.28)">
          <a href="${esc(href)}" target="_blank" rel="noopener" style="display:inline-block;padding:15px 34px;font-size:15px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;letter-spacing:.01em;border-radius:10px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${esc(label)} &rarr;</a>
        </td>
      </tr>
    </table>`;
}

/**
 * Render a polished outreach email.
 * @param {object} opts
 * @param {string} opts.bodyText - Plain-text body (will be escaped + paragraphed).
 * @param {string} opts.ctaUrl - URL the big button links to.
 * @param {string} [opts.ctaLabel='View Your Demo Site'] - Button label.
 * @param {string[]} [opts.checklist] - Optional list of bullet items under the button.
 * @param {string} [opts.closingLine] - Optional final sentence before signature.
 * @param {string} [opts.testBanner] - If set, shows a yellow "test email" banner at top.
 * @param {string} [opts.samplesHtml] - Optional pre-rendered HTML for the 5 deliverables block.
 * @param {string} [opts.pixelHtml] - Optional tracking pixel HTML.
 * @param {object} [opts.premiumAddOn] - Optional paid add-on callout. { title, body }
 * @returns {string}
 */
function renderOutreachHtml(opts) {
  const {
    bodyText,
    ctaUrl,
    ctaLabel = 'View Your Demo Site',
    checklist,
    closingLine,
    testBanner,
    samplesHtml = '',
    pixelHtml = '',
    premiumAddOn
  } = opts;

  const bodyHtml = paragraphsFrom(bodyText);
  const checklistHtml = renderChecklist(checklist);
  const buttonHtml = ctaUrl ? renderButton(ctaUrl, ctaLabel) : '';

  const testBannerHtml = testBanner ? `
    <tr><td style="padding:0 36px">
      <div style="background:#fef3c7;border:1px solid #fbbf24;border-radius:8px;padding:12px 16px;margin:24px 0 0;font-size:12.5px;color:#92400e;line-height:1.5">
        <strong>Test email.</strong> ${esc(testBanner)}
      </div>
    </td></tr>` : '';

  const closingHtml = closingLine ? `
    <tr><td style="padding:20px 36px 0">
      <p style="margin:0;font-size:15px;line-height:1.7;color:#334155;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${esc(closingLine)}</p>
    </td></tr>` : '';

  // Secondary callout block. Used to plant an idea worth talking about on
  // the call, visually distinct from the free deliverables above but neutral
  // in tone. No monetary signaling, the idea sells itself.
  const premiumHtml = premiumAddOn ? `
    <tr><td style="padding:14px 36px 6px">
      <div style="background:#eef2ff;border:1px solid #c7d2fe;border-radius:10px;padding:16px 18px">
        <p style="margin:0 0 6px;font-size:14.5px;font-weight:700;color:#0f172a;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${esc(premiumAddOn.title || '')}</p>
        <p style="margin:0;font-size:13.5px;line-height:1.65;color:#475569;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">${esc(premiumAddOn.body || '')}</p>
      </div>
    </td></tr>` : '';

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
</head>
<body style="margin:0;padding:0;background:#f1f5f9">
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#f1f5f9;padding:32px 12px">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="600" role="presentation" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;box-shadow:0 1px 2px rgba(15,23,42,0.04),0 8px 24px rgba(15,23,42,0.06);overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">

      <!-- HEADER -->
      <tr><td style="padding:22px 36px;border-bottom:1px solid #e2e8f0">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation">
          <tr>
            <td style="vertical-align:middle">
              <span style="font-size:19px;font-weight:800;color:#0f172a;letter-spacing:-.01em">Forge <span style="color:#2563eb">AI</span></span>
            </td>
            <td align="right" style="vertical-align:middle">
              <span style="font-size:10.5px;color:#94a3b8;letter-spacing:.14em;text-transform:uppercase;font-weight:600">AI-Powered Outreach</span>
            </td>
          </tr>
        </table>
      </td></tr>

      ${testBannerHtml}

      <!-- BODY -->
      <tr><td style="padding:32px 36px 4px">
        ${bodyHtml}
      </td></tr>

      ${ctaUrl ? `<tr><td align="center" style="padding:8px 36px 20px">${buttonHtml}</td></tr>` : ''}

      ${checklist && checklist.length ? `<tr><td style="padding:4px 36px 8px">
        <p style="margin:0 0 10px;font-size:13px;font-weight:700;color:#0f172a;letter-spacing:.04em;text-transform:uppercase">What you get, all free</p>
        ${checklistHtml}
      </td></tr>` : ''}

      ${premiumHtml}

      ${closingHtml}

      <!-- SIGNATURE -->
      <tr><td style="padding:24px 36px 28px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="border-top:1px solid #e2e8f0;padding-top:24px">
          <tr>
            <td>
              <p style="margin:0;font-size:15px;font-weight:700;color:#0f172a">Leif</p>
              <p style="margin:3px 0 0;font-size:13px;color:#64748b">Founder, Forge AI</p>
              <p style="margin:8px 0 0;font-size:13px">
                <a href="mailto:leif@forgeaiagent.com" style="color:#2563eb;text-decoration:none">leif@forgeaiagent.com</a>
                <span style="color:#cbd5e1;margin:0 8px">|</span>
                <a href="https://forgeaiagent.com" style="color:#2563eb;text-decoration:none">forgeaiagent.com</a>
              </p>
            </td>
          </tr>
        </table>
      </td></tr>

      ${samplesHtml ? `<tr><td style="padding:0 36px 28px">${samplesHtml}</td></tr>` : ''}

      <!-- FOOTER -->
      <tr><td style="padding:18px 36px;background:#f8fafc;border-top:1px solid #e2e8f0">
        <p style="margin:0;font-size:11.5px;color:#94a3b8;text-align:center;line-height:1.6">
          Forge AI &middot; Professional websites for local businesses<br>
          <a href="https://forgeaiagent.com" style="color:#64748b;text-decoration:none">forgeaiagent.com</a>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>
${pixelHtml}
</body>
</html>`;
}

// Render the deliverables block (5 free things). Used when the outreach
// agent has generated samples.
function renderSamples({ samples, demoUrl, auditLine }) {
  const card = (n, label, content) => `
    <div style="margin:0 0 18px">
      <p style="margin:0 0 8px;font-size:10.5px;font-weight:700;color:#64748b;text-transform:uppercase;letter-spacing:.08em">${esc(n)} &middot; ${esc(label)}</p>
      <div style="background:#f8fafc;border:1px solid #e2e8f0;border-radius:8px;padding:14px 16px;font-size:13.5px;color:#334155;line-height:1.7">${content}</div>
    </div>`;

  return `
    <div style="margin-top:12px;padding-top:24px;border-top:1px solid #e2e8f0">
      <p style="margin:0 0 4px;font-size:15px;font-weight:700;color:#0f172a">Your 5 Free Deliverables</p>
      <p style="margin:0 0 18px;font-size:12.5px;color:#64748b">Everything below is yours to keep, no strings attached.</p>
      ${card('01', 'Custom Demo Website', `<a href="${esc(demoUrl)}" target="_blank" style="color:#2563eb;text-decoration:none;font-weight:600">Click to open your live demo &rarr;</a>`)}
      ${card('02', 'Instagram Caption',       esc(samples?.instagram_post || ''))}
      ${card('03', 'Google Review Response',  esc(samples?.review_response || ''))}
      ${card('04', 'Customer Follow-up Message', esc(samples?.followup_message || ''))}
      ${card('05', 'Online Presence Audit',   esc(auditLine || 'Short audit of your current online presence, handed to you on the call.'))}
    </div>`;
}

// ── RENOVIEW FIXED HTML EMAIL TEMPLATE ────────────────────────────────────
// Rich HTML marketing email for RenoView outreach to contractors/builders.
// Fixed template — no AI generation needed. Matches the original RenoView
// email design: dark theme, before/after images, pricing, CTA.

const RENOVIEW_SUBJECT = "Turn Your Website Into a Lead Machine (Your Competitors Aren't Doing This Yet)";

function renderRenoviewHtml(opts = {}) {
  const {
    pixelHtml = '',
    unsubscribeUrl = '',
    baseImageUrl = 'https://forgeaiagent.com/img/renoview'
  } = opts;

  const kitchenHero = `${baseImageUrl}/kitchen-hero.jpg`;
  const kitchenSmall = `${baseImageUrl}/kitchen-small.jpg`;
  const sidingImg = `${baseImageUrl}/siding.jpg`;

  // Shared styles
  const ff = "font-family:'Segoe UI',Roboto,-apple-system,BlinkMacSystemFont,Helvetica,Arial,sans-serif";
  const sectionLabel = `margin:0 0 8px;font-size:10px;font-weight:700;color:#00d4ff;letter-spacing:.2em;text-transform:uppercase;text-align:center;${ff}`;
  const sectionHeading = `margin:0 0 28px;font-size:26px;font-weight:800;color:#ffffff;text-align:center;line-height:1.25;letter-spacing:-.01em;${ff}`;
  const dividerLine = '<tr><td align="center" style="padding:0 80px"><div style="height:1px;background:linear-gradient(90deg,transparent,rgba(0,212,255,.15),transparent)"></div></td></tr>';
  const spacer = h => `<tr><td style="height:${h}px;line-height:${h}px;font-size:1px">&nbsp;</td></tr>`;

  // Helper: wraps content in a full-width row with background that stretches edge-to-edge
  const fullWidthRow = (bg, content) => `
</table></td></tr></table>
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:${bg}">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">
      ${content}
    </table>
  </td></tr>
</table>
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#0b0b10">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;background:#0b0b10;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif">`;

  // Checklist row helper
  const checkItem = (text) => `
    <tr>
      <td width="32" valign="top" style="padding:10px 0 10px 0">
        <div style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#10b981,#06b6d4);text-align:center;line-height:22px;font-size:13px;color:#fff">&#10003;</div>
      </td>
      <td style="padding:10px 0 10px 12px;font-size:14px;color:#c8cdd5;line-height:1.5;${ff};border-bottom:1px solid rgba(255,255,255,.04)">${text}</td>
    </tr>`;

  return `<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<meta name="supported-color-schemes" content="light dark">
</head>
<body style="margin:0;padding:0;background:#08080d">

<!-- ======== HERO ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:linear-gradient(180deg,#140e24 0%,#0d0a18 60%,#08080d 100%)">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;${ff}">
      ${spacer(56)}
      <tr><td align="center" style="padding:0 40px">
        <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="display:inline-block">
          <tr>
            <td align="center" style="border-radius:30px;background:linear-gradient(135deg,rgba(0,212,255,.12),rgba(124,58,237,.10));border:1px solid rgba(0,212,255,.28);padding:10px 28px;box-shadow:0 0 20px rgba(0,212,255,.08)">
              <span style="font-size:11px;font-weight:800;color:#00d4ff;letter-spacing:.2em;text-transform:uppercase;${ff}">&#9889; The Future of Contractor Marketing</span>
            </td>
          </tr>
        </table>
      </td></tr>
      ${spacer(24)}
      <tr><td align="center" style="padding:0 40px">
        <h1 style="margin:0 0 4px;font-size:36px;font-weight:800;color:#ffffff;line-height:1.2;text-align:center;letter-spacing:-.02em;${ff}">Stop Chasing Clients.</h1>
        <h1 style="margin:0;font-size:36px;font-weight:800;color:#00d4ff;line-height:1.2;text-align:center;letter-spacing:-.02em;${ff}">Let Them Come to You.</h1>
      </td></tr>
      ${spacer(18)}
      <tr><td align="center" style="padding:0 60px">
        <p style="margin:0;font-size:15px;color:#7a8494;line-height:1.7;text-align:center;${ff}">We build AI-powered platforms for kitchen, bath &amp; siding contractors that turn website visitors into paying customers.</p>
      </td></tr>
      ${spacer(36)}

      <!-- HERO IMAGE -->
      <tr><td align="center" style="padding:0 36px">
        <div style="border-radius:16px;padding:5px;background:linear-gradient(135deg,rgba(0,212,255,.15),rgba(124,58,237,.15));display:inline-block">
          <img src="${esc(kitchenHero)}" alt="AI Kitchen Transformation" width="596" style="width:100%;max-width:596px;border-radius:12px;display:block" />
        </div>
      </td></tr>
      ${spacer(48)}
    </table>
  </td></tr>
</table>

<!-- ======== GRADIENT DIVIDER ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center" style="padding:0 80px"><div style="height:1px;background:linear-gradient(90deg,transparent,rgba(0,212,255,.18),transparent)"></div></td></tr>
</table>

<!-- ======== HOW IT WORKS ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;${ff}">
      ${spacer(48)}
      <tr><td><p style="${sectionLabel}">How It Works</p></td></tr>
      <tr><td><h2 style="${sectionHeading}">3 Steps. Endless Leads.</h2></td></tr>

      <!-- STEP 1 -->
      <tr><td style="padding:0 50px 12px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px">
          <tr>
            <td width="52" align="center" valign="middle" style="padding:16px 0 16px 18px">
              <div style="width:34px;height:34px;border-radius:10px;background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.15);text-align:center;line-height:34px;font-size:15px">&#128248;</div>
            </td>
            <td style="padding:16px 18px 16px 14px">
              <p style="margin:0;font-size:14.5px;color:#c8cdd5;line-height:1.5;${ff}"><strong style="color:#ffffff">1.</strong> Homeowner uploads a photo of their old space</p>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- STEP 2 -->
      <tr><td style="padding:0 50px 12px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px">
          <tr>
            <td width="52" align="center" valign="middle" style="padding:16px 0 16px 18px">
              <div style="width:34px;height:34px;border-radius:10px;background:rgba(124,58,237,.08);border:1px solid rgba(124,58,237,.15);text-align:center;line-height:34px;font-size:15px">&#129302;</div>
            </td>
            <td style="padding:16px 18px 16px 14px">
              <p style="margin:0;font-size:14.5px;color:#c8cdd5;line-height:1.5;${ff}"><strong style="color:#ffffff">2.</strong> AI instantly transforms it into their dream renovation</p>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- STEP 3 (highlighted — impactful) -->
      <tr><td style="padding:0 50px 12px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:linear-gradient(135deg,rgba(0,212,255,.06),rgba(124,58,237,.06));border:1px solid rgba(0,212,255,.25);border-radius:14px;box-shadow:0 0 24px rgba(0,212,255,.08)">
          <tr>
            <td width="56" align="center" valign="middle" style="padding:22px 0 22px 20px">
              <div style="width:40px;height:40px;border-radius:12px;background:linear-gradient(135deg,rgba(0,212,255,.15),rgba(124,58,237,.12));border:1px solid rgba(0,212,255,.3);text-align:center;line-height:40px;font-size:18px">&#128222;</div>
            </td>
            <td style="padding:22px 20px 22px 14px">
              <p style="margin:0;font-size:16px;color:#e2e8f0;line-height:1.5;${ff}"><strong style="color:#ffffff">3.</strong> They see it. They want it. They call <span style="color:#00d4ff;font-weight:800;font-size:18px;letter-spacing:.02em">YOU</span>.</p>
            </td>
          </tr>
        </table>
      </td></tr>
      ${spacer(40)}
    </table>
  </td></tr>
</table>

<!-- ======== DIVIDER ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center" style="padding:0 80px"><div style="height:1px;background:linear-gradient(90deg,transparent,rgba(0,212,255,.18),transparent)"></div></td></tr>
</table>

<!-- ======== THE MAGIC ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;${ff}">
      ${spacer(48)}
      <tr><td><p style="${sectionLabel}">The Magic</p></td></tr>
      <tr><td><h2 style="${sectionHeading}">See the AI Engine in Action</h2></td></tr>

      <!-- KITCHEN IMAGE -->
      <tr><td align="center" style="padding:0 36px">
        <div style="border-radius:16px;padding:5px;background:linear-gradient(135deg,rgba(0,212,255,.12),rgba(124,58,237,.12));display:inline-block">
          <img src="${esc(kitchenSmall)}" alt="Kitchen Transformation" width="596" style="width:100%;max-width:596px;border-radius:12px;display:block" />
        </div>
      </td></tr>
      <tr><td style="padding:12px 40px 0">
        <p style="margin:0;font-size:12px;color:#6b7280;text-align:center;letter-spacing:.03em;${ff}">Kitchen Transformation &mdash; same room, dream renovation</p>
      </td></tr>
      ${spacer(28)}

      <!-- SIDING IMAGE -->
      <tr><td align="center" style="padding:0 36px">
        <div style="border-radius:16px;padding:5px;background:linear-gradient(135deg,rgba(0,212,255,.12),rgba(124,58,237,.12));display:inline-block">
          <img src="${esc(sidingImg)}" alt="Siding Transformation" width="596" style="width:100%;max-width:596px;border-radius:12px;display:block" />
        </div>
      </td></tr>
      <tr><td style="padding:12px 40px 0">
        <p style="margin:0;font-size:12px;color:#6b7280;text-align:center;letter-spacing:.03em;${ff}">Siding Transformation &mdash; instant curb appeal</p>
      </td></tr>
      ${spacer(48)}
    </table>
  </td></tr>
</table>

<!-- ======== DIVIDER ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center" style="padding:0 80px"><div style="height:1px;background:linear-gradient(90deg,transparent,rgba(0,212,255,.18),transparent)"></div></td></tr>
</table>

<!-- ======== EVERYTHING INCLUDED ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;${ff}">
      ${spacer(48)}
      <tr><td><p style="${sectionLabel}">Everything Included</p></td></tr>
      <tr><td><h2 style="${sectionHeading}">All in One Platform</h2></td></tr>

      <tr><td style="padding:0 40px 30px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:rgba(255,255,255,.025);border:1px solid rgba(255,255,255,.06);border-radius:14px">
          <tr><td style="padding:8px 24px">
            <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation">
              ${checkItem('AI Transformation Engine (Kitchen, Bath &amp; Siding)')}
              ${checkItem('Your own fully branded website')}
              ${checkItem('Custom CRM dashboard for every lead')}
              ${checkItem('Agentic AI assistant &mdash; auto email &amp; call follow-ups')}
              ${checkItem('Real-time lead notifications')}
              ${checkItem('Built-in customer financing (zero down)')}
              ${checkItem('Analytics &amp; reporting dashboard')}
              ${checkItem('Full setup &amp; onboarding by our team')}
              <tr>
                <td width="32" valign="top" style="padding:10px 0 10px 0">
                  <div style="width:22px;height:22px;border-radius:6px;background:linear-gradient(135deg,#10b981,#06b6d4);text-align:center;line-height:22px;font-size:13px;color:#fff">&#10003;</div>
                </td>
                <td style="padding:10px 0 10px 12px;font-size:14px;color:#c8cdd5;line-height:1.5;${ff}">Ongoing support &amp; updates</td>
              </tr>
            </table>
          </td></tr>
        </table>
      </td></tr>
      ${spacer(10)}
    </table>
  </td></tr>
</table>

<!-- ======== PRICING (full-width gradient) ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:linear-gradient(180deg,#08080d 0%,#12081f 40%,#12081f 60%,#08080d 100%)">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;${ff}">
      ${spacer(50)}
      <tr><td><p style="${sectionLabel}">The Investment</p></td></tr>
      ${spacer(8)}
      <tr><td align="center">
        <h2 style="margin:0;font-size:56px;font-weight:800;color:#ffffff;text-align:center;line-height:1;letter-spacing:-.03em;${ff}">$2,600</h2>
      </td></tr>
      ${spacer(8)}
      <tr><td align="center" style="padding:0 40px">
        <p style="margin:0;font-size:13.5px;color:#7a8494;text-align:center;${ff}">One-time setup fee &middot; or <strong style="color:#e2e8f0">$216 &times; 12 months</strong> &middot; No hidden costs</p>
      </td></tr>
      ${spacer(28)}

      <!-- AFFIRM -->
      <tr><td align="center" style="padding:0 40px">
        <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="width:100%">
          <tr>
            <td align="center" style="border-radius:14px;background:linear-gradient(135deg,#10b981,#0891b2);padding:18px 28px;box-shadow:0 4px 20px rgba(16,185,129,.2)">
              <span style="font-size:14.5px;font-weight:700;color:#ffffff;${ff}">&#128179; Finance with Affirm &mdash; zero down, low monthly payments</span>
            </td>
          </tr>
        </table>
      </td></tr>
      ${spacer(24)}

      <!-- TOOLBAR -->
      <tr><td align="center" style="padding:0 40px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:12px">
          <tr><td style="padding:20px 24px;text-align:center">
            <p style="margin:0;font-size:14.5px;color:#7a8494;line-height:1.7;${ff}">
              or <strong style="color:#ffffff;font-size:22px;letter-spacing:-.01em">$1,500</strong> for the RenoViews AI toolbar &mdash; drops right into your existing website, no changes to your site.
            </p>
          </td></tr>
        </table>
      </td></tr>
      ${spacer(16)}

      <!-- FREE NETWORK -->
      <tr><td align="center" style="padding:0 40px">
        <table cellpadding="0" cellspacing="0" border="0" role="presentation" style="display:inline-block">
          <tr>
            <td align="center" style="border-radius:10px;background:rgba(245,158,11,.06);border:1px solid rgba(245,158,11,.15);padding:14px 24px">
              <span style="font-size:13.5px;color:#f59e0b;font-weight:600;${ff}">Or join our contractor network for FREE and pay only per lead.</span>
            </td>
          </tr>
        </table>
      </td></tr>
      ${spacer(32)}

      <!-- SEE IT LIVE -->
      <tr><td align="center" style="padding:0 40px">
        <table cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr>
            <td align="center" style="border-radius:30px;background:linear-gradient(135deg,#7c3aed,#6d28d9);box-shadow:0 4px 20px rgba(124,58,237,.3)">
              <a href="https://renoviews.com" target="_blank" rel="noopener" style="display:inline-block;padding:16px 42px;font-size:15px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:30px;letter-spacing:.01em;${ff}">See It Live at RenoViews.com &rarr;</a>
            </td>
          </tr>
        </table>
      </td></tr>
      ${spacer(50)}
    </table>
  </td></tr>
</table>

<!-- ======== DIVIDER ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center" style="padding:0 80px"><div style="height:1px;background:linear-gradient(90deg,transparent,rgba(0,212,255,.18),transparent)"></div></td></tr>
</table>

<!-- ======== COMPARISON ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;${ff}">
      ${spacer(48)}
      <tr><td><p style="${sectionLabel}">Why RenoViews</p></td></tr>
      <tr><td><h2 style="${sectionHeading}">The Smarter Investment</h2></td></tr>
      <!-- OLD WAY -->
      <tr><td style="padding:0 40px 12px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:rgba(239,68,68,.04);border:1px solid rgba(239,68,68,.1);border-radius:12px">
          <tr>
            <td width="44" align="center" valign="top" style="padding:18px 0 18px 18px;font-size:18px">&#128201;</td>
            <td style="padding:18px 18px 18px 10px">
              <p style="margin:0;font-size:13.5px;color:#c8cdd5;line-height:1.65;${ff}"><strong style="color:#f87171">The old way:</strong> Most contractors burn $2,000&ndash;$10,000 every month on Facebook ads with inconsistent results.</p>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- RENOVIEWS WAY -->
      <tr><td style="padding:0 40px 30px">
        <table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:rgba(0,212,255,.04);border:1px solid rgba(0,212,255,.14);border-radius:12px">
          <tr>
            <td width="44" align="center" valign="top" style="padding:18px 0 18px 18px;font-size:18px">&#128640;</td>
            <td style="padding:18px 18px 18px 10px">
              <p style="margin:0;font-size:13.5px;color:#c8cdd5;line-height:1.65;${ff}"><strong style="color:#00d4ff">The RenoViews way:</strong> A one-time investment that turns every website visit into a potential customer &mdash; working for you forever.</p>
            </td>
          </tr>
        </table>
      </td></tr>
    </table>
  </td></tr>
</table>

<!-- ======== FINAL CTA (full-width gradient) ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:linear-gradient(180deg,#08080d 0%,#1a0a2e 50%,#08080d 100%)">
  <tr><td align="center">
    <table cellpadding="0" cellspacing="0" border="0" width="680" role="presentation" style="max-width:680px;width:100%;${ff}">
      ${spacer(48)}
      <tr><td align="center" style="padding:0 40px">
        <h2 style="margin:0 0 12px;font-size:26px;font-weight:800;color:#ffffff;text-align:center;line-height:1.3;letter-spacing:-.01em;${ff}">Ready to leave your competition in the dust?</h2>
        <p style="margin:0;font-size:14.5px;color:#7a8494;text-align:center;${ff}">Reply to this email to get started.</p>
      </td></tr>
      ${spacer(28)}
      <tr><td align="center">
        <table cellpadding="0" cellspacing="0" border="0" role="presentation">
          <tr>
            <td align="center" style="border-radius:30px;background:linear-gradient(135deg,#7c3aed,#6d28d9);box-shadow:0 4px 20px rgba(124,58,237,.3)">
              <a href="https://renoviews.com" target="_blank" rel="noopener" style="display:inline-block;padding:16px 42px;font-size:15px;font-weight:700;line-height:1;color:#ffffff;text-decoration:none;border-radius:30px;letter-spacing:.01em;${ff}">Get Started Today &rarr;</a>
            </td>
          </tr>
        </table>
      </td></tr>
      ${spacer(50)}
    </table>
  </td></tr>
</table>

<!-- ======== FOOTER ======== -->
<table cellpadding="0" cellspacing="0" border="0" width="100%" role="presentation" style="background:#08080d">
  <tr><td align="center" style="padding:0 80px"><div style="height:1px;background:linear-gradient(90deg,transparent,rgba(255,255,255,.06),transparent)"></div></td></tr>
  <tr><td align="center" style="padding:28px 40px 16px">
    <p style="margin:0;font-size:11px;color:#3d4554;text-align:center;line-height:1.6;letter-spacing:.04em;${ff}">
      <a href="https://renoviews.com" style="color:#505868;text-decoration:none;font-weight:600">RenoViews.com</a>
      <span style="color:#2a2f3a;margin:0 6px">&middot;</span>
      <span style="color:#3d4554">Sent by</span> <a href="https://forgeaiagent.com" style="color:#505868;text-decoration:none;font-weight:600">Forge AI</a>
    </p>
  </td></tr>
  ${unsubscribeUrl ? `<tr><td align="center" style="padding:0 40px 28px">
    <p style="margin:0;font-size:11px;text-align:center;${ff}">
      <a href="${esc(unsubscribeUrl)}" style="color:#4a5060;text-decoration:none;border-bottom:1px solid rgba(74,80,96,.4);padding-bottom:1px">Unsubscribe</a>
    </p>
  </td></tr>` : ''}
</table>
${pixelHtml}
</body>
</html>`;
}

function getRenoviewPlainText() {
  return `The Future of Contractor Marketing

Stop Chasing Clients. Let Them Come to You.

We build AI-powered platforms for kitchen, bath & siding contractors that turn website visitors into paying customers.

How It Works — 3 Steps. Endless Leads.

1. Homeowner uploads a photo of their old space
2. AI instantly transforms it into their dream renovation
3. They see it. They want it. They call YOU.

Everything Included — All in One Platform:
- AI Transformation Engine (Kitchen, Bath & Siding)
- Your own fully branded website
- Custom CRM dashboard for every lead
- Agentic AI assistant — auto email & call follow-ups
- Real-time lead notifications
- Built-in customer financing (zero down)
- Analytics & reporting dashboard
- Full setup & onboarding by our team
- Ongoing support & updates

The Investment: $2,600
One-time setup fee, or $216 x 12 months. No hidden costs.
Finance with Affirm — zero down, low monthly payments.

Or $1,500 for the RenoViews AI toolbar — drops right into your existing website, no changes to your site.

Or join our contractor network for FREE and pay only per lead.

See it live at RenoViews.com

The old way: Most contractors burn $2,000-$10,000 every month on Facebook ads with inconsistent results.

The RenoViews way: A one-time investment that turns every website visit into a potential customer, working for you forever.

Ready to leave your competition in the dust?
Reply to this email to get started.

RenoViews.com`;
}

module.exports = { renderOutreachHtml, renderSamples, stripUrls, esc, renderRenoviewHtml, getRenoviewPlainText, RENOVIEW_SUBJECT };
