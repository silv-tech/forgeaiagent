const Anthropic = require('@anthropic-ai/sdk');
const path = require('path');
const fs = require('fs');

const DATA_ROOT = process.env.DATA_DIR || path.join(__dirname, '..');
const SMS_LOG_FILE = path.join(DATA_ROOT, 'leads', 'sms-outreach.json');
const SMS_COUNTER_FILE = path.join(DATA_ROOT, 'leads', '.sms-counter.json');
const RESET_INTERVAL_MS = 24 * 60 * 60 * 1000;

// ── SMS DAILY COUNTER ─────────────────────────────────────────────────────
function loadSmsCounter() {
  try {
    const data = JSON.parse(fs.readFileSync(SMS_COUNTER_FILE, 'utf8'));
    if (data.startedAt && (Date.now() - data.startedAt) < RESET_INTERVAL_MS) return data;
  } catch {}
  return { startedAt: Date.now(), sent: 0 };
}

function saveSmsCounter(counter) {
  try { fs.writeFileSync(SMS_COUNTER_FILE, JSON.stringify(counter)); } catch {}
}

function getSmsStats() {
  const c = loadSmsCounter();
  const remainingMs = Math.max(0, RESET_INTERVAL_MS - (Date.now() - c.startedAt));
  const h = Math.floor(remainingMs / 3600000);
  const m = Math.floor((remainingMs % 3600000) / 60000);
  return {
    sent: c.sent,
    resetsIn: `${h}h ${m}m`,
    resetsAtMs: c.startedAt + RESET_INTERVAL_MS
  };
}

function incrementSmsCounter() {
  const c = loadSmsCounter();
  c.sent = (c.sent || 0) + 1;
  saveSmsCounter(c);
  return c;
}

// ── SMS LOG ───────────────────────────────────────────────────────────────
function loadSmsLog() {
  try { return fs.existsSync(SMS_LOG_FILE) ? JSON.parse(fs.readFileSync(SMS_LOG_FILE, 'utf8')) : []; } catch { return []; }
}

function saveSmsLog(log) {
  const tmp = SMS_LOG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(log, null, 2));
  fs.renameSync(tmp, SMS_LOG_FILE);
}

// ── CLAUDE SMS GENERATOR ──────────────────────────────────────────────────
function getClient() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key || key === 'your_anthropic_key_here') throw new Error('Anthropic API key not set.');
  return new Anthropic({ apiKey: key });
}

function parseJSON(text) {
  try { return JSON.parse(text); } catch {}
  const m = text.match(/\{[\s\S]*\}/);
  if (m) try { return JSON.parse(m[0]); } catch {}
  return null;
}

async function generateSmsText(lead, messageType) {
  const client = getClient();
  const hasRating = lead.rating && lead.rating !== 'N/A';
  const reviews = parseInt(lead.reviews) || 0;

  let prompt;
  if (messageType === 'renoview') {
    prompt = `You write a single cold SMS message for ForgeAI pitching RenoView, an AI renovation visualization tool. Output ONLY the SMS text, nothing else.

BUSINESS:
- Name: ${lead.name}
- Type: ${lead.type || 'contractor'}
- Rating: ${hasRating ? lead.rating : 'unknown'}
- Reviews: ${reviews}

INSTRUCTIONS:
- Pitch: AI tool that lets homeowners upload a photo of their space and see the renovation result before hiring. Turns website visitors into leads.
- Keep under 155 characters (leave room for opt-out footer)
- Sound like a real person texting a business owner, not a marketing blast
- No emojis, no ALL CAPS, no exclamation marks
- Mention their business name naturally
- End with a soft CTA like "want to see it?" or "interested?"
- Do NOT include any opt-out text, that's added automatically

Return ONLY valid JSON: {"message":"..."}`;
  } else {
    prompt = `You write a single cold SMS message for ForgeAI, a digital growth agency. Output ONLY the SMS text, nothing else.

BUSINESS:
- Name: ${lead.name}
- Type: ${lead.type || 'business'}
- Address: ${lead.address || ''}
- Rating: ${hasRating ? lead.rating : 'unknown'}
- Reviews: ${reviews}
- Has website: ${lead.website ? 'yes' : 'no'}

INSTRUCTIONS:
- Pitch: Free AI-powered website (if they don't have one) OR free AI chatbot + automated follow-up system (if they do)
- Keep under 155 characters (leave room for opt-out footer)
- Sound like a real person texting a business owner, not a marketing blast
- No emojis, no ALL CAPS, no exclamation marks
- Mention their business name or something specific about them
- End with a soft CTA like "worth a quick call?" or "want to see it?"
- Do NOT include any opt-out text, that's added automatically
- No corporate words like leverage, synergy, optimize

Return ONLY valid JSON: {"message":"..."}`;
  }

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 200,
    messages: [{ role: 'user', content: prompt }]
  });

  const result = parseJSON(msg.content[0]?.text || '');
  if (!result?.message) throw new Error('Failed to generate SMS text');
  return result.message;
}

// ── PHONE NUMBER UTILS ────────────────────────────────────────────────────
function normalizePhone(phone) {
  if (!phone) return null;
  // Strip everything except digits
  const digits = phone.replace(/\D/g, '');
  if (digits.length < 10) return null;
  // US 10-digit: add +1
  if (digits.length === 10) return '+1' + digits;
  // US 11-digit starting with 1: add +
  if (digits.length === 11 && digits[0] === '1') return '+' + digits;
  // Already has country code (international)
  return '+' + digits;
}

function isValidPhone(phone) {
  return !!normalizePhone(phone);
}

// ── SEND SMS VIA TWILIO ───────────────────────────────────────────────────
async function sendSms(lead, message, onProgress) {
  const accountSid = process.env.TWILIO_ACCOUNT_SID;
  const authToken = process.env.TWILIO_AUTH_TOKEN;
  const fromNumber = process.env.TWILIO_PHONE_NUMBER;

  if (!accountSid || !authToken || !fromNumber) {
    throw new Error('Twilio not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_PHONE_NUMBER.');
  }

  const toNumber = normalizePhone(lead.phone);
  if (!toNumber) throw new Error(`Invalid phone number for ${lead.name}: ${lead.phone}`);

  // Append opt-out footer
  const fullMessage = message + '\n\nReply STOP to opt out';

  if (onProgress) onProgress({ status: 'sending', message: `📱 Sending SMS to ${lead.name} (${toNumber})...` });

  const twilio = require('twilio')(accountSid, authToken);
  const result = await twilio.messages.create({
    body: fullMessage,
    from: fromNumber,
    to: toNumber
  });

  incrementSmsCounter();

  const record = {
    leadId: lead.id,
    leadName: lead.name,
    phone: toNumber,
    message: message,
    fullMessage: fullMessage,
    sid: result.sid,
    status: result.status,
    sentAt: new Date().toISOString(),
    segments: Math.ceil(fullMessage.length / 160)
  };

  // Append to SMS log
  const log = loadSmsLog();
  log.push(record);
  saveSmsLog(log);

  if (onProgress) onProgress({ status: 'sent', message: `✅ SMS sent to ${lead.name} (${toNumber})` });

  return record;
}

module.exports = { generateSmsText, sendSms, getSmsStats, loadSmsLog, normalizePhone, isValidPhone };
