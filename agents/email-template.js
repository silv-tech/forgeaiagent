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
              <span style="font-size:10.5px;color:#94a3b8;letter-spacing:.14em;text-transform:uppercase;font-weight:600">Websites &middot; Chatbots &middot; Follow-ups</span>
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

module.exports = { renderOutreachHtml, renderSamples, stripUrls, esc };
