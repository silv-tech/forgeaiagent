const Anthropic = require('@anthropic-ai/sdk');

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

async function handleReply(lead, originalEmail, replyText, onProgress) {
  const client = getClient();
  onProgress({ status:'analyzing', message:`Analyzing reply from ${lead.name}...` });

  const msg = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 600,
    messages: [{ role:'user', content:
`You are Leif, the founder of Forge AI. You sent a cold outreach email to this business offering them a free demo website and 5 free deliverables. The only thing you asked for in return was a quick 15-minute call. This is your follow-up reply to their response.

The goal of every reply is ONE thing: get them on a 15-minute call. Not to sell pricing, not to close a deal, not to explain everything - just book the call. The call is where everything else happens.

Business: "${lead.name}" (${(lead.type||'business').replace(/_/g,' ')})
Original email subject: "${originalEmail.subject}"
Their reply: "${replyText}"

What you originally offered them for free:
- A custom demo website (already built and live)
- Instagram caption, Google review response template, customer follow-up message
- Full online presence audit
All free. In exchange for one 15-minute call.

Step 1: Classify their reply as exactly one of:
  interested / price / need / trust / time / negative

Step 2: Write a reply (max 80 words) based on the type:
  interested → Warm, excited response. Remind them everything is still free. Just ask them to pick a time for the 15-minute call. Make it stupidly easy - offer 2 specific time options or a scheduling link placeholder.
  price      → Reassure them - there is no price, no pitch, no commitment on the call. The free stuff is genuinely free. The call is just 15 minutes to walk them through everything. That is all.
  need       → Acknowledge their point warmly. Remind them the demo is already built specifically for them - it exists right now. The call just takes 15 minutes to show them everything live.
  trust      → Be transparent and human. Leif found them on Google Maps, liked what he saw, and built something for them. No obligation. The call is just to show them what is possible. 15 minutes.
  time       → Completely respect it. Ask when would work better - next week, a specific day. Make it feel effortless to reschedule. Keep it light.
  negative   → Respect their decision warmly. Leave the door open. Let them know the demo and free deliverables are still theirs if they ever change their mind.

Tone: warm, confident, human - sounds like the founder who built this for them personally, not a salesperson. Never mention pricing. Never pitch. Always bring it back to the 15-minute call.
Sign as Leif, Forge AI.

Return ONLY JSON, nothing else:
{"objectionType":"...","sentiment":"positive|neutral|negative","subject":"Re: [original subject]","body":"..."}`
    }]
  });

  const result = parseJSON(msg.content[0].text);
  if (!result?.body) throw new Error('Failed to generate response - try again.');
  onProgress({ status:'done', message:`✅ Response ready (${result.objectionType})` });
  return result;
}

module.exports = { handleReply };
