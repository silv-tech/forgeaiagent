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

async function analyzeScreenshot(imageBuffer, mimeType) {
  const client = getClient();
  const base64 = imageBuffer.toString('base64');
  const msg = await client.messages.create({
    model: 'claude-sonnet-4-6',
    max_tokens: 2000,
    messages: [{
      role: 'user',
      content: [
        {
          type: 'image',
          source: { type: 'base64', media_type: mimeType, data: base64 }
        },
        {
          type: 'text',
          text: `Analyze this Facebook profile screenshot of a fitness business. Extract the following and return ONLY valid JSON (no markdown, no explanation):

{
  "businessName": "exact business name from the profile",
  "services": ["list of services/programs mentioned or implied"],
  "tagline": "bio text or tagline if visible",
  "vibe": "one of: hardcore, boutique, family-friendly, athletic-performance, wellness, bodybuilding, crossfit-style, yoga-zen, mixed",
  "colors": "any brand colors visible (describe them, e.g. 'red and black', 'teal and white')",
  "aesthetic": "brief description of their visual brand style",
  "targetAudience": "who they seem to target based on the profile"
}

If a field isn't clearly visible, make a reasonable inference based on the business type and other visible info. Always return valid JSON.`
        }
      ]
    }]
  });
  const text = msg.content[0].text.trim();
  // Extract JSON from response (handle possible markdown wrapping)
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error('Vision analysis did not return valid JSON');
  return JSON.parse(jsonMatch[0]);
}

async function buildFitnessSite(lead, screenshotData, onProgress) {
  onProgress({ status:'building', message:'Checking API key...' });
  let client;
  try {
    client = getClient();
  } catch(e) {
    onProgress({ status:'error', message:`${e.message}` });
    throw e;
  }

  // Step 1: Analyze screenshot
  onProgress({ status:'building', message:'Analyzing screenshot with Claude Vision...' });
  let brand;
  try {
    brand = await analyzeScreenshot(screenshotData.buffer, screenshotData.mimeType);
    onProgress({ status:'building', message:`Extracted: "${brand.businessName}" — ${brand.vibe} vibe, ${brand.services?.length||0} services detected` });
  } catch(e) {
    onProgress({ status:'error', message:`Vision analysis failed: ${e.message}` });
    throw e;
  }

  // Step 2: Merge with lead data
  const name = brand.businessName || lead.name;
  const services = brand.services || ['Personal Training', 'Group Classes', 'Nutrition Coaching'];
  const tagline = brand.tagline || '';
  const vibe = brand.vibe || 'athletic-performance';
  const audience = brand.targetAudience || 'fitness enthusiasts';

  onProgress({ status:'building', message:`Building fitness site for "${name}"...` });

  // Vibe-to-style mapping — primary color + light sections ensure visibility
  const vibeStyles = {
    'hardcore':             { primary: '#e11d48', accent: '#fbbf24', heroQuery: 'crossfit+gym+intense' },
    'boutique':             { primary: '#8b5cf6', accent: '#f472b6', heroQuery: 'boutique+fitness+studio' },
    'family-friendly':      { primary: '#2563eb', accent: '#10b981', heroQuery: 'family+fitness+gym' },
    'athletic-performance': { primary: '#f97316', accent: '#eab308', heroQuery: 'athlete+training+gym' },
    'wellness':             { primary: '#14b8a6', accent: '#7c3aed', heroQuery: 'wellness+fitness+health' },
    'bodybuilding':         { primary: '#ef4444', accent: '#f59e0b', heroQuery: 'bodybuilding+weights+gym' },
    'crossfit-style':       { primary: '#dc2626', accent: '#fb923c', heroQuery: 'crossfit+workout+box' },
    'yoga-zen':             { primary: '#7c3aed', accent: '#34d399', heroQuery: 'yoga+meditation+studio' },
    'mixed':                { primary: '#3b82f6', accent: '#f59e0b', heroQuery: 'modern+fitness+gym' },
  };
  const style = vibeStyles[vibe] || vibeStyles['mixed'];
  const svcList = services.slice(0, 6).map(s => `"${s}"`).join(', ');

  const prompt = `Build a premium single-page fitness website. Use Tailwind CDN. Output ONLY raw HTML (<!DOCTYPE html> to </html>). No markdown.

BUSINESS: "${name}"
SERVICES: ${svcList}
TAGLINE: "${tagline}"
VIBE: ${vibe} | AUDIENCE: ${audience}
ADDRESS: ${lead.address || ''} | PHONE: ${lead.phone !== 'N/A' ? lead.phone : ''}
PRIMARY COLOR: ${style.primary} | ACCENT: ${style.accent}

IMAGES — use these exact URLs (Unsplash Source, always work):
- HERO: https://images.unsplash.com/photo-1534438327276-14e5300c3a48?w=1600&h=900&fit=crop
- ABOUT: https://images.unsplash.com/photo-1571019614242-c5c5dee9f50b?w=800&h=600&fit=crop
- SVC1: https://images.unsplash.com/photo-1581009146145-b5ef050c2e1e?w=600&h=400&fit=crop
- SVC2: https://images.unsplash.com/photo-1518611012118-696072aa579a?w=600&h=400&fit=crop
- SVC3: https://images.unsplash.com/photo-1549060279-7e168fcee0c2?w=600&h=400&fit=crop
- TESTIMONIAL BG: https://images.unsplash.com/photo-1526506118085-60ce8714f8c5?w=1600&h=600&fit=crop

STRUCTURE (6 sections — complete each fully):

1. NAV: Fixed top, white bg, shadow-sm. Business name in bold on left. Links: Programs, About, Results, Contact. CTA button "Book Free Call" in primary color. Mobile hamburger menu with JS toggle.

2. HERO: Full viewport height, min-h-screen. Use HERO image as background with CSS background-image (cover, center). Add a dark overlay (bg-black/60) on top. White text centered: big uppercase headline (Oswald font), subtitle with tagline, two buttons (primary solid + white outline). Must have visible white text — the overlay guarantees contrast.

3. PROGRAMS: Light gray bg (#f9fafb). "Our Programs" heading. 3-column responsive grid of service cards. Each card: white bg, rounded-xl, shadow, image on top (use SVC1/SVC2/SVC3), service name as heading, short description, primary-colored "Learn More" link. Hover shadow effect.

4. ABOUT: White bg. Two columns: left = ABOUT image (rounded-xl), right = "About ${name}" heading, 2 paragraphs of copy about this fitness business, 3 inline stat boxes (e.g. "500+ Clients", "5+ Years", "98% Satisfaction") with primary-colored numbers.

5. TESTIMONIALS: Dark section (gray-900 bg). "What Our Clients Say" in white. 3 testimonial cards (white bg, rounded-xl, padding). Each: 5 gold stars, quote text about fitness transformation, client name + "Member since 2024". Make quotes specific to the services offered.

6. CONTACT + FOOTER: Light bg. "Ready to Start?" heading in primary color. Contact info (address, phone if available). Simple form: name, email, message, submit button in primary color. Footer below: dark bg, business name, copyright 2026, social icon placeholders.

REQUIREMENTS:
- Google Fonts: Oswald (headings) + Inter (body)
- Tailwind CDN: <script src="https://cdn.tailwindcss.com"></script>
- html { scroll-behavior: smooth }
- ALL text must be readable — white text ONLY on dark overlays, dark text on light sections
- Buttons and cards need hover transitions
- Mobile responsive (test: hamburger menu, stacked columns on mobile, readable font sizes)
- Fixed "Book Now" button bottom-right, primary color bg, white text, rounded-full, shadow-lg, z-50
- CRITICAL: You MUST complete ALL 6 sections including Contact and Footer. Do NOT stop early. Keep CSS minimal — use Tailwind classes, avoid long custom CSS blocks. Be concise with HTML to stay within token limits.`;

  // Step 3: Generate site
  let html = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      onProgress({ status:'building', message:`Calling Claude Sonnet (attempt ${attempt}/2)... ~2-4 minutes` });
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role:'user', content: prompt }],
      }, { timeout: 300000 });
      onProgress({ status:'building', message:'Response received, validating HTML...' });
      html = msg.content[0].text.trim().replace(/^```html?\n?/i,'').replace(/\n?```$/,'').trim();
      // Auto-fix missing closing tags
      if (html.includes('<!DOCTYPE') && !html.includes('</html>') && html.length > 10000) {
        onProgress({ status:'building', message:'Auto-fixing incomplete HTML...' });
        if (!html.includes('</body>')) html += '\n</body>';
        html += '\n</html>';
      }
      const size = Math.round(html.length/1024);
      onProgress({ status:'building', message:`Got ${size}KB of HTML, checking completeness...` });
      if (isComplete(html)) {
        onProgress({ status:'building', message:'HTML looks complete! Saving file...' });
        break;
      }
      onProgress({ status:'retry', message:`HTML incomplete (${size}KB), retrying...` });
    } catch(e) {
      onProgress({ status:'error', message:`API error (attempt ${attempt}): ${e.message}` });
      if (attempt === 2) throw e;
      const wait = e.message.includes('429') ? 60000 : 3000;
      onProgress({ status:'building', message: wait >= 60000 ? 'Rate limited, waiting 60s before retry...' : 'Waiting 3s before retry...' });
      await new Promise(r=>setTimeout(r,wait));
    }
  }

  if (!isComplete(html)) {
    const err = 'Generated HTML was incomplete. Check your Anthropic API key and try again.';
    onProgress({ status:'error', message: err });
    throw new Error(err);
  }

  // Step 4: Save
  const sitesDir = path.join(process.env.DATA_DIR || path.join(__dirname,'..'), 'sites');
  fs.mkdirSync(sitesDir, { recursive: true });
  const safe = name.replace(/[^a-z0-9]/gi,'-').toLowerCase().substring(0,40);
  const filename = `${safe}-${Date.now()}.html`;
  fs.writeFileSync(path.join(sitesDir, filename), html);

  const size = Math.round(html.length/1024);
  onProgress({ status:'done', message:`Site saved! ${size}KB — ${filename}`, filename });
  return { html, filename, brand };
}

module.exports = { buildDemoSite, analyzeScreenshot, buildFitnessSite };
