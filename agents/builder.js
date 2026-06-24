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
  const colors = brand.colors || 'dark and energetic';
  const aesthetic = brand.aesthetic || 'modern fitness';
  const audience = brand.targetAudience || 'fitness enthusiasts';

  onProgress({ status:'building', message:`Building fitness site for "${name}"...` });

  const imgSeed = name.replace(/[^a-z0-9]/gi,'-').toLowerCase().substring(0,20);

  // Color palette mapping based on vibe
  const palettes = {
    'hardcore': { primary: '#dc2626', secondary: '#111827', accent: '#f59e0b', bg: '#0f0f0f' },
    'boutique': { primary: '#8b5cf6', secondary: '#1e1b4b', accent: '#f472b6', bg: '#0f0a1e' },
    'family-friendly': { primary: '#2563eb', secondary: '#1e3a5f', accent: '#10b981', bg: '#f0f9ff' },
    'athletic-performance': { primary: '#f97316', secondary: '#0c0a09', accent: '#eab308', bg: '#0a0a0a' },
    'wellness': { primary: '#14b8a6', secondary: '#134e4a', accent: '#a78bfa', bg: '#f0fdfa' },
    'bodybuilding': { primary: '#ef4444', secondary: '#000000', accent: '#fbbf24', bg: '#050505' },
    'crossfit-style': { primary: '#dc2626', secondary: '#1c1917', accent: '#f97316', bg: '#0c0a09' },
    'yoga-zen': { primary: '#8b5cf6', secondary: '#3b0764', accent: '#6ee7b7', bg: '#faf5ff' },
    'mixed': { primary: '#3b82f6', secondary: '#111827', accent: '#f59e0b', bg: '#0a0a0a' },
  };
  const palette = palettes[vibe] || palettes['mixed'];

  const prompt = `Build a complete, stunning single-page fitness website. This should look like a premium $5,000 fitness website. Use Tailwind CSS CDN and custom CSS for the color palette.

BUSINESS INFO (extracted from their Facebook profile):
- Name: "${name}"
- Services: ${services.join(', ')}
- Tagline: "${tagline}"
- Brand Vibe: ${vibe}
- Visual Colors: ${colors}
- Target Audience: ${audience}
- Address: ${lead.address || 'Contact for location'}
- Phone: ${lead.phone !== 'N/A' ? lead.phone : 'Call us'}

COLOR PALETTE (use these exact hex values):
- Primary: ${palette.primary}
- Secondary/Dark: ${palette.secondary}
- Accent: ${palette.accent}
- Background: ${palette.bg}

Use these Picsum image URLs:
- Hero bg: https://picsum.photos/seed/${imgSeed}-hero/1600/900
- About: https://picsum.photos/seed/${imgSeed}-about/800/600
- Program 1: https://picsum.photos/seed/${imgSeed}-p1/600/400
- Program 2: https://picsum.photos/seed/${imgSeed}-p2/600/400
- Program 3: https://picsum.photos/seed/${imgSeed}-p3/600/400
- Trainer 1: https://picsum.photos/seed/${imgSeed}-t1/400/500
- Trainer 2: https://picsum.photos/seed/${imgSeed}-t2/400/500
- Transformation 1: https://picsum.photos/seed/${imgSeed}-r1/400/400
- Transformation 2: https://picsum.photos/seed/${imgSeed}-r2/400/400
- Transformation 3: https://picsum.photos/seed/${imgSeed}-r3/400/400

Build these sections in order:

1. HEAD: Tailwind CDN, Google Fonts (use a bold fitness font like Oswald + clean body font), meta tags. Add a <style> block for custom colors using the palette above.

2. NAV: Fixed, dark bg (secondary color). Logo/business name on left styled in primary color. Nav links: Programs, Trainers, Results, Pricing, Contact. Mobile hamburger with JS toggle. Subtle shadow on scroll.

3. HERO: Full-viewport height. Background image with dark gradient overlay. Large bold headline reflecting the "${vibe}" vibe (e.g. "UNLEASH YOUR POTENTIAL" for hardcore, "Find Your Balance" for wellness). Subtext with the tagline or a compelling fitness line. Two CTA buttons: "Start Your Journey" (primary color bg) + "View Programs" (outline). Add subtle scroll indicator animation.

4. ABOUT: Split layout. Image on one side, text on the other. Heading about the gym's story. 2 paragraphs of compelling copy matching the ${vibe} vibe. Include 3 stat counters (e.g. "500+ Members", "10+ Years", "50+ Classes/Week") with primary color numbers.

5. PROGRAMS/CLASSES: Section heading "Our Programs". Grid of cards for each service: ${services.map((s,i) => `"${s}"`).join(', ')}. Each card has an image, program name, brief description, schedule hint, and "Learn More" button. Cards should have hover lift effect.

6. TRAINERS: Dark section. "Meet Our Team" heading. 2 trainer cards with photos, names, specialties, certifications, and social links. Clean card design matching the vibe.

7. TRANSFORMATIONS/RESULTS: "Real Results" section. 3 before/after style cards (use the transformation images). Each has a name, program completed, and a short testimonial quote. Star ratings in accent color.

8. PRICING: 3-tier pricing cards (Basic, Pro/Popular, Elite). Popular tier highlighted with primary color border and "Most Popular" badge. Each has: price/month, list of included features, CTA button. Clean, professional layout.

9. TESTIMONIALS: Dark bg. Large quote marks in primary color. 3 testimonial cards with star ratings, member names, and realistic fitness journey quotes.

10. CONTACT/CTA: Split section. Left: large bold CTA text "Ready to Transform?" with "Join Now" button. Right: contact info (address, phone, hours), simple contact form (name, email, message, submit button styled in primary color).

11. FOOTER: Dark bg. Business name, tagline, quick links, social media icons, and copyright 2026.

12. FLOATING CTA: Fixed bottom-right button "Join Now" or "Free Trial" with primary color bg, pulse animation.

CRITICAL REQUIREMENTS:
- Dark, premium aesthetic that matches the "${vibe}" brand
- Smooth scroll behavior for nav links
- All interactive elements (buttons, cards) have hover transitions
- Mobile responsive with hamburger menu
- Use the exact color palette provided
- Make it feel like a real, professional fitness website

Output ONLY raw HTML starting with <!DOCTYPE html> and ending with </html>. No markdown. No explanation.`;

  // Step 3: Generate site
  let html = '';
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      onProgress({ status:'building', message:`Calling Claude Sonnet (attempt ${attempt}/2)... this takes 30-60 seconds` });
      const msg = await client.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 16000,
        messages: [{ role:'user', content: prompt }]
      });
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
