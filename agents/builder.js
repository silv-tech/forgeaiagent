const Anthropic = require('@anthropic-ai/sdk');
const fs = require('fs');
const path = require('path');

function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_key_here') {
    throw new Error('Anthropic API key not set! Go to Settings and add your key from console.anthropic.com');
  }
  return new Anthropic({ apiKey: key });
}

function isComplete(html) {
  const hasDoctype = html.includes('<!DOCTYPE') || html.includes('<!doctype');
  const hasClose = html.includes('</html>');
  const isLarge = html.length > 15000;
  // Large HTML without closing tags is considered complete (auto-fixed by caller)
  if (hasDoctype && isLarge && !hasClose) return true;
  return hasDoctype && hasClose && html.length > 3000;
}

async function buildDemoSite(lead, onProgress) {
  onProgress({ status:'building', message:`🔑 Checking API key...` });

  let client;
  try {
    client = getClient();
  } catch(e) {
    onProgress({ status:'error', message:`❌ ${e.message}` });
    throw e;
  }

  onProgress({ status:'building', message:`✍️  Writing prompt for ${lead.name}...` });
  const type = (lead.type||'business').replace(/_/g,' ');

  const imgSeed = lead.name.replace(/[^a-z0-9]/gi,'-').toLowerCase().substring(0,20);
  const prompt = `Build a complete single-page demo website for a local business. Use Tailwind CSS CDN for all styling, no custom <style> block needed.

Business: "${lead.name}"
Type: ${type}
Address: ${lead.address}
Phone: ${lead.phone !== 'N/A' ? lead.phone : 'Call us'}
Rating: ${lead.rating !== 'N/A' ? lead.rating+'/5 ('+lead.reviews+' reviews)' : 'not yet rated'}

Use these Picsum image URLs (always work, never broken):
- Hero bg: https://picsum.photos/seed/${imgSeed}/1600/900
- About photo: https://picsum.photos/seed/${imgSeed}2/800/500
- Feature 1: https://picsum.photos/seed/${imgSeed}3/600/400
- Feature 2: https://picsum.photos/seed/${imgSeed}4/600/400
- Feature 3: https://picsum.photos/seed/${imgSeed}5/600/400

Build these sections IN ORDER, completing each fully before moving on:

1. HEAD: Include Tailwind CDN (<script src="https://cdn.tailwindcss.com"></script>), Google Fonts link for 1 elegant font, and basic meta tags.

2. NAV: Fixed top, white bg, shadow. Logo (business name) on left, nav links on right (About, Services, Reviews, Contact). Mobile hamburger menu with JS toggle.

3. HERO: Full-height section. Background image (Hero bg URL above) with absolute dark overlay (bg-black bg-opacity-50). Centered white text: big bold headline relevant to the business, 1-line subtext, two buttons (primary CTA + secondary outline).

4. SERVICES: Section with gray-50 bg. Title "Our Services". 3-column grid of 6 cards, each card has an emoji icon, service name specific to this business type, one-line description, and a realistic price. Cards have white bg, rounded-xl, shadow-md, hover:shadow-lg.

5. ABOUT: Two-column layout. Left: the About photo img tag (800x500). Right: heading "About Us" + 2 paragraphs of real copy about this specific business + a "Learn More" button.

6. GALLERY: Three images side by side (Feature 1, 2, 3) each with rounded-xl, overflow-hidden, hover scale effect via inline style or Tailwind.

7. REVIEWS: Dark bg section (gray-900). Title in white. Three review cards with white bg, rounded-xl, padding. Each has ★★★★★ in yellow, reviewer name in bold, 2-sentence review text relevant to the business.

8. CONTACT: Light bg. Show address, phone, and business hours. Big "Call Now" button and "Get Directions" button (href to Google Maps search for the address).

9. FOOTER: Dark bg, white text. Business name, short tagline, © 2026.

10. FLOATING BUTTON: Fixed bottom-right, z-50, rounded-full, primary color, "Book Now" or "Call Now" with phone number.

Output ONLY raw HTML starting with <!DOCTYPE html> and ending with </html>. No markdown. No explanation.`;

  let html = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      onProgress({ status:'building', message:`🤖 Calling Claude Sonnet (attempt ${attempt}/2)... this takes 30-60 seconds` });
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role:'user', content: prompt }]
      });
      onProgress({ status:'building', message:`📥 Response received, validating HTML...` });
      html = msg.content[0].text.trim().replace(/^```html?\n?/i,'').replace(/\n?```$/,'').trim();
      // Auto-fix missing closing tags
      if (html.includes('<!DOCTYPE') && !html.includes('</html>') && html.length > 10000) {
        onProgress({ status:'building', message:'🔧 Auto-fixing incomplete HTML...' });
        if (!html.includes('</body>')) html += '\n</body>';
        html += '\n</html>';
      }
      const size = Math.round(html.length/1024);
      onProgress({ status:'building', message:`📏 Got ${size}KB of HTML, checking completeness...` });
      if (isComplete(html)) {
        onProgress({ status:'building', message:`✅ HTML looks complete! Saving file...` });
        break;
      }
      onProgress({ status:'retry', message:`⚠️  HTML incomplete (${size}KB), retrying...` });
    } catch(e) {
      onProgress({ status:'error', message:`❌ API error (attempt ${attempt}): ${e.message}` });
      if (attempt === 2) throw e;
      const wait = e.message.includes('429') ? 60000 : 3000;
      onProgress({ status:'building', message:`⏳ ${wait >= 60000 ? 'Rate limited, waiting 60s before retry...' : 'Waiting 3s before retry...'}`});
      await new Promise(r=>setTimeout(r,wait));
    }
  }

  if (!isComplete(html)) {
    const err = 'Generated HTML was incomplete. Check your Anthropic API key and try again.';
    onProgress({ status:'error', message:`❌ ${err}` });
    throw new Error(err);
  }

  const sitesDir = path.join(process.env.DATA_DIR || path.join(__dirname,'..'), 'sites');
  fs.mkdirSync(sitesDir, { recursive: true });
  const safe = lead.name.replace(/[^a-z0-9]/gi,'-').toLowerCase().substring(0,40);
  const filename = `${safe}-${Date.now()}.html`;
  fs.writeFileSync(path.join(sitesDir, filename), html);

  const size = Math.round(html.length/1024);
  onProgress({ status:'done', message:`🎉 Site saved! ${size}KB, ${filename}`, filename });
  return { html, filename };
}

module.exports = { buildDemoSite };
