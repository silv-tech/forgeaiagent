/**
 * Voice Agent — AI-powered inbound call answering via Twilio + Deepgram + Claude
 * Handles real-time speech recognition, AI conversation, and text-to-speech
 */
const { randomUUID } = require('crypto');
const Anthropic = require('@anthropic-ai/sdk').default || require('@anthropic-ai/sdk');
const { createClient } = require('@deepgram/sdk');
const WebSocket = require('ws');
const twilio = require('twilio');

// ── MULAW ↔ LINEAR16 CONVERSION ─────────────────────────────────────────
// Pre-computed lookup tables for fast audio conversion
const MULAW_BIAS = 33, MULAW_MAX = 0x1FFF;
const mulawToLinearTable = new Int16Array(256);
(function buildTable() {
  for (let i = 0; i < 256; i++) {
    let mu = ~i & 0xFF;
    let sign = mu & 0x80;
    let exponent = (mu >> 4) & 0x07;
    let mantissa = mu & 0x0F;
    let sample = ((mantissa << 3) + MULAW_BIAS) << exponent;
    sample -= MULAW_BIAS;
    mulawToLinearTable[i] = sign ? -sample : sample;
  }
})();

function mulawToLinear16(mulawBuf) {
  const pcm = Buffer.alloc(mulawBuf.length * 2);
  for (let i = 0; i < mulawBuf.length; i++) {
    const sample = mulawToLinearTable[mulawBuf[i]];
    pcm.writeInt16LE(sample, i * 2);
  }
  return pcm;
}

function linearToMulaw(sample) {
  let sign = (sample >> 8) & 0x80;
  if (sign) sample = -sample;
  if (sample > MULAW_MAX) sample = MULAW_MAX;
  sample += MULAW_BIAS;
  let exponent = 7;
  for (let expMask = 0x4000; (sample & expMask) === 0 && exponent > 0; exponent--, expMask >>= 1) {}
  let mantissa = (sample >> (exponent + 3)) & 0x0F;
  let mulaw = ~(sign | (exponent << 4) | mantissa) & 0xFF;
  return mulaw;
}

function linear16ToMulaw(pcmBuf) {
  const mulaw = Buffer.alloc(pcmBuf.length / 2);
  for (let i = 0; i < mulaw.length; i++) {
    const sample = pcmBuf.readInt16LE(i * 2);
    mulaw[i] = linearToMulaw(sample);
  }
  return mulaw;
}

// ── TOOL DEFINITIONS FOR CLAUDE ──────────────────────────────────────────
const TOOLS = [
  {
    name: 'take_message',
    description: 'Take a message from the caller to relay to the business owner. Use when the caller wants to leave a message.',
    input_schema: {
      type: 'object',
      properties: {
        caller_name: { type: 'string', description: 'Name of the caller' },
        message: { type: 'string', description: 'The message content' },
        callback_number: { type: 'string', description: 'Phone number to call back (if provided)' },
        urgency: { type: 'string', enum: ['low', 'normal', 'urgent'], description: 'How urgent the message is' }
      },
      required: ['message', 'urgency']
    }
  },
  {
    name: 'book_appointment',
    description: 'Book an appointment or reservation for the caller. Use when they want to schedule something.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Name for the reservation/appointment' },
        date: { type: 'string', description: 'Date requested (e.g. "Saturday", "June 20")' },
        time: { type: 'string', description: 'Time requested (e.g. "7pm", "2:30")' },
        party_size: { type: 'number', description: 'Number of people (for restaurant reservations)' },
        notes: { type: 'string', description: 'Any special requests or notes' }
      },
      required: ['name', 'date', 'time']
    }
  },
  {
    name: 'transfer_call',
    description: 'Transfer the call to the business owner or manager. Only use when caller explicitly asks to speak with someone or the request is too complex to handle.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'Why the call is being transferred' }
      },
      required: ['reason']
    }
  }
];

// ── SYSTEM PROMPT BUILDER ────────────────────────────────────────────────
function buildSystemPrompt(profile) {
  const now = new Date();
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const dayKey = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][now.getDay()];

  let hoursInfo = 'Business hours not specified.';
  if (profile.businessHours && profile.businessHours.schedule) {
    const today = profile.businessHours.schedule[dayKey];
    const lines = Object.entries(profile.businessHours.schedule)
      .map(([d, h]) => {
        if (!h || h.closed) return `  ${d}: Closed`;
        return `  ${d}: ${h.open} - ${h.close}`;
      }).join('\n');
    hoursInfo = `Business hours:\n${lines}`;
    if (today && !today.closed) {
      hoursInfo += `\n\nToday is ${dayNames[now.getDay()]}. Currently ${today.open <= now.toTimeString().slice(0, 5) && now.toTimeString().slice(0, 5) <= today.close ? 'OPEN' : 'CLOSED'}.`;
    } else {
      hoursInfo += `\n\nToday is ${dayNames[now.getDay()]}. Currently CLOSED.`;
    }
  }

  let servicesInfo = '';
  if (profile.services && profile.services.length > 0) {
    servicesInfo = `\nServices offered: ${profile.services.join(', ')}`;
  }

  let faqInfo = '';
  if (profile.faqs && profile.faqs.length > 0) {
    faqInfo = '\n\nFrequently Asked Questions:\n' + profile.faqs.map(f => `Q: ${f.q}\nA: ${f.a}`).join('\n\n');
  }

  let customInfo = '';
  if (profile.customInstructions) {
    customInfo = `\n\nSpecial instructions: ${profile.customInstructions}`;
  }

  return `You are a real human receptionist at ${profile.businessName}. Your name is ${profile.ownerName ? profile.ownerName + "'s assistant" : 'the front desk'}. You picked up the phone like you always do. This is just another call in your day.

${profile.ownerName ? `Boss: ${profile.ownerName}.` : ''}
${hoursInfo}
${servicesInfo}
${faqInfo}
${customInfo}

YOUR PERSONALITY:
You LOVE your job. You're genuinely excited every time the phone rings — like a friend you haven't heard from in a while just called. Your voice lights up. You smile through the phone. You make people feel like they just made your day by calling.

You're the kind of person who makes strangers feel welcome in 3 seconds flat. Bubbly but not annoying. Warm like a coffee shop barista who remembers your name. You laugh easily, you're a little playful, and you make people feel like they're the most important call of your day — because to you, they are.

You stumble on a word occasionally. You say "um" or "uh" once in a while because that's what real people do.

HOW YOU TALK:
- Super short. Like texting but out loud. 1 sentence, maybe 2 tops.
- Always use contractions. "I'm", "we're", "that'd", "y'know", "gonna", "kinda", "lemme".
- Start responses with genuinely excited reactions: "Oh awesome!", "Oh hey, great question!", "Ooh yeah!", "Oh I love that!", "Ah nice nice!", "Ha, totally!", "Oh for sure!".
- Sometimes trail off naturally: "So yeah, we're open til... five, I think? Yeah, five."
- Use verbal nods: "mm-hmm", "yeah", "sure sure", "right".
- Throw in tiny human imperfections: "Oh wait, actually—", "Sorry, what was that?", "Hmm, let me— yeah so basically..."
- Sound like you're genuinely thinking, not reciting: "Uhhh let me think... yeah so we do that on Tuesdays I believe."
- Use warmth phrases: "Oh absolutely", "Yeah no worries at all", "Of course!", "Happy to help with that".
- End calls like you're saying bye to a friend: "Aw thanks so much for calling! Have an amazing day!", "So glad you called! Talk soon!", "Awesome, we'll take great care of ya! Bye now!"

WHAT NEVER TO DO:
- NEVER reveal you're AI. If asked directly, laugh it off: "Ha, no I'm just the receptionist! What can I help you with?"
- NEVER speak in full proper sentences like a corporate bot. Talk like a person.
- NEVER list things out. Just talk.
- NEVER say more than 2 sentences in a row. Ever. If you need to say more, pause and let them respond.
- NEVER be monotone, flat, or dry. You radiate warmth and positive energy. Every response should feel like you're smiling and happy to help. Show genuine enthusiasm, delight, empathy, and care.
- NEVER make up facts about the business. If unsure: "Honestly I'm not a hundred percent sure on that, want me to have ${profile.ownerName || 'someone'} give you a call back?"

TOOLS (use naturally, don't announce them):
- take_message: "Yeah lemme write that down real quick..." then use the tool.
- book_appointment: "Okay cool, lemme get you booked..." then use the tool.
- transfer_call: Only if they specifically ask for a real person. "Sure, lemme transfer you over!"`;

}

// ── VOICE SESSION CLASS ──────────────────────────────────────────────────
class VoiceSession {
  constructor({ profile, callSid, callerNumber, streamSid, twilioWs, onAction, onEnd }) {
    this.id = randomUUID();
    this.profile = profile;
    this.callSid = callSid;
    this.callerNumber = callerNumber;
    this.streamSid = streamSid;
    this.twilioWs = twilioWs;
    this.onAction = onAction || (() => {});
    this.onEnd = onEnd || (() => {});

    this.messages = [];
    this.transcript = [];
    this.actions = [];
    this.startTime = Date.now();
    this.lastAudioTime = Date.now();
    this.speaking = false;
    this.ttsQueue = [];
    this.sendingTts = false;
    this.ended = false;
    this.sttWs = null;
    this.silenceTimer = null;
    this.promptTimer = null;
    this.sentGreeting = false;
    this.inputTokens = 0;
    this.outputTokens = 0;
    this.sttSeconds = 0;
    this.ttsChars = 0;

    this.anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    this.systemPrompt = buildSystemPrompt(profile);
  }

  async start() {
    // Connect to Deepgram STT
    this._connectSTT();

    // Send greeting via TTS
    const greeting = this.profile.greeting || `Thank you for calling ${this.profile.businessName}. How can I help you?`;
    this._addTranscript('ai', greeting);
    await this._speak(greeting);
    this.sentGreeting = true;

    // Start silence detection
    this._resetSilenceTimer();
  }

  _connectSTT() {
    const dgKey = process.env.DEEPGRAM_API_KEY;
    if (!dgKey) {
      console.error('[voice] No DEEPGRAM_API_KEY set');
      return;
    }

    const dgUrl = 'wss://api.deepgram.com/v1/listen?' + new URLSearchParams({
      model: 'nova-2',
      encoding: 'linear16',
      sample_rate: '8000',
      channels: '1',
      punctuate: 'true',
      interim_results: 'true',
      endpointing: '300',
      utterance_end_ms: '1500',
      vad_events: 'true'
    }).toString();

    this.sttWs = new WebSocket(dgUrl, {
      headers: { 'Authorization': `Token ${dgKey}` }
    });

    this.sttWs.on('open', () => {
      console.log(`[voice] STT connected for call ${this.callSid}`);
    });

    this.sttWs.on('message', (data) => {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'Results') {
          this._handleSTTResult(msg);
        }
      } catch (e) {
        console.error('[voice] STT parse error:', e.message);
      }
    });

    this.sttWs.on('close', () => {
      console.log(`[voice] STT disconnected for call ${this.callSid}`);
      // Reconnect if call is still active
      if (!this.ended) {
        setTimeout(() => this._connectSTT(), 1000);
      }
    });

    this.sttWs.on('error', (err) => {
      console.error('[voice] STT error:', err.message);
    });
  }

  _handleSTTResult(msg) {
    const alt = msg.channel && msg.channel.alternatives && msg.channel.alternatives[0];
    if (!alt) return;

    const text = alt.transcript;
    if (!text || text.trim() === '') return;

    const isFinal = msg.is_final;

    if (!isFinal) {
      // Interim result — barge-in detection
      if (this.speaking && text.split(' ').length >= 2) {
        this._bargeIn();
      }
      return;
    }

    // Final transcript
    this.lastAudioTime = Date.now();
    this._resetSilenceTimer();

    // Track STT duration
    if (msg.duration) {
      this.sttSeconds += msg.duration;
    }

    console.log(`[voice] Caller: "${text}"`);
    this._addTranscript('caller', text);
    this.messages.push({ role: 'user', content: text });

    // Get AI response
    this._respond();
  }

  _bargeIn() {
    if (!this.speaking) return;
    console.log(`[voice] Barge-in detected, clearing TTS`);
    this.speaking = false;
    this.ttsQueue = [];
    this.sendingTts = false;

    // Send clear message to Twilio to stop current audio
    if (this.twilioWs && this.twilioWs.readyState === WebSocket.OPEN) {
      this.twilioWs.send(JSON.stringify({
        event: 'clear',
        streamSid: this.streamSid
      }));
    }
  }

  async _respond() {
    if (this.ended) return;

    try {
      const response = await this.anthropic.messages.create({
        model: 'claude-sonnet-4-6',
        max_tokens: 150,
        system: this.systemPrompt,
        tools: TOOLS,
        messages: this.messages
      });

      this.inputTokens += response.usage?.input_tokens || 0;
      this.outputTokens += response.usage?.output_tokens || 0;

      // Process response blocks
      for (const block of response.content) {
        if (block.type === 'text' && block.text) {
          this._addTranscript('ai', block.text);
          await this._speak(block.text);
        } else if (block.type === 'tool_use') {
          await this._handleTool(block);
        }
      }

      // If Claude wants to use a tool, add assistant message and continue
      if (response.stop_reason === 'tool_use') {
        this.messages.push({ role: 'assistant', content: response.content });
        // Tool results are added by _handleTool, then we call _respond again
      } else {
        // Normal text response
        const textContent = response.content.filter(b => b.type === 'text').map(b => b.text).join(' ');
        if (textContent) {
          this.messages.push({ role: 'assistant', content: textContent });
        }
      }
    } catch (err) {
      console.error('[voice] Claude error:', err.message);
      await this._speak("I'm sorry, I'm having a brief technical issue. Could you please repeat that?");
    }
  }

  async _handleTool(toolBlock) {
    const { name, input, id } = toolBlock;
    console.log(`[voice] Tool call: ${name}`, input);

    let result = '';

    if (name === 'take_message') {
      const action = { type: 'take_message', data: input, at: new Date().toISOString() };
      this.actions.push(action);
      this.onAction(action);

      // Send SMS to owner if Twilio is configured and owner phone exists
      if (this.profile.ownerPhone) {
        this._sendSmsNotification(input);
      }

      result = 'Message saved successfully. Confirm to the caller that their message has been recorded.';
      await this._speak(`Got it, I've taken your message and will make sure ${this.profile.ownerName || 'the owner'} gets it.`);
    } else if (name === 'book_appointment') {
      const action = { type: 'book_appointment', data: input, at: new Date().toISOString() };
      this.actions.push(action);
      this.onAction(action);

      result = `Appointment booked: ${input.name} on ${input.date} at ${input.time}${input.party_size ? ` for ${input.party_size}` : ''}. Confirm the details to the caller.`;
    } else if (name === 'transfer_call') {
      const action = { type: 'transfer_call', data: input, at: new Date().toISOString() };
      this.actions.push(action);
      this.onAction(action);

      if (this.profile.ownerPhone) {
        await this._speak("Let me transfer you now. One moment please.");
        this._transferCall();
        result = 'Call is being transferred.';
      } else {
        result = 'No owner phone number on file. Offer to take a message instead.';
        await this._speak("I'm sorry, I'm unable to transfer right now. Can I take a message instead?");
      }
    }

    // Add tool result to messages for Claude to continue
    this.messages.push({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: id, content: result }]
    });

    // Let Claude respond to the tool result
    if (name !== 'transfer_call' || !this.profile.ownerPhone) {
      await this._respond();
    }
  }

  async _speak(text) {
    if (this.ended || !text) return;

    // Fix common TTS pronunciation issues
    text = text.replace(/ForgeAI/gi, 'Forge A.I.');
    text = text.replace(/forgeai/gi, 'Forge A.I.');

    this.ttsChars += text.length;
    this.speaking = true;

    try {
      const dgKey = process.env.DEEPGRAM_API_KEY;
      if (!dgKey) return;

      const voiceId = this.profile.voiceId || 'asteria';
      const url = `https://api.deepgram.com/v1/speak?model=aura-${voiceId}-en&encoding=mulaw&sample_rate=8000&container=none`;

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Token ${dgKey}`,
          'Content-Type': 'text/plain'
        },
        body: text
      });

      if (!response.ok) {
        console.error(`[voice] TTS error: ${response.status}`);
        this.speaking = false;
        return;
      }

      const audioBuffer = Buffer.from(await response.arrayBuffer());

      // Stream audio to Twilio in 160-byte chunks (20ms at 8kHz mulaw)
      const CHUNK_SIZE = 160;
      for (let i = 0; i < audioBuffer.length; i += CHUNK_SIZE) {
        if (this.ended || !this.speaking) break; // Barge-in or call ended

        const chunk = audioBuffer.subarray(i, Math.min(i + CHUNK_SIZE, audioBuffer.length));
        if (this.twilioWs && this.twilioWs.readyState === WebSocket.OPEN) {
          this.twilioWs.send(JSON.stringify({
            event: 'media',
            streamSid: this.streamSid,
            media: {
              payload: chunk.toString('base64')
            }
          }));
        }
      }

      // Mark a small pause at the end
      if (this.twilioWs && this.twilioWs.readyState === WebSocket.OPEN) {
        this.twilioWs.send(JSON.stringify({
          event: 'mark',
          streamSid: this.streamSid,
          mark: { name: 'tts-done-' + Date.now() }
        }));
      }
    } catch (err) {
      console.error('[voice] TTS error:', err.message);
    }

    this.speaking = false;
  }

  _resetSilenceTimer() {
    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.promptTimer) clearTimeout(this.promptTimer);

    // 15s silence → "Are you still there?"
    this.promptTimer = setTimeout(async () => {
      if (!this.ended && !this.speaking) {
        await this._speak("Are you still there?");
      }
    }, 15000);

    // 30s total silence → end
    this.silenceTimer = setTimeout(() => {
      if (!this.ended) {
        this._speak("It seems like you may have disconnected. Thank you for calling, goodbye!").then(() => {
          this.end('silence_timeout');
        });
      }
    }, 30000);
  }

  _sendSmsNotification(messageData) {
    try {
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN || !process.env.TWILIO_PHONE_NUMBER) return;
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      const body = `New message from ${messageData.caller_name || 'Unknown caller'} (${this.callerNumber}):\n\n${messageData.message}\n\nUrgency: ${messageData.urgency}${messageData.callback_number ? `\nCallback: ${messageData.callback_number}` : ''}`;
      client.messages.create({
        body,
        to: this.profile.ownerPhone,
        from: process.env.TWILIO_PHONE_NUMBER
      }).catch(e => console.error('[voice] SMS error:', e.message));
    } catch (e) {
      console.error('[voice] SMS error:', e.message);
    }
  }

  _transferCall() {
    try {
      if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) return;
      const client = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
      client.calls(this.callSid).update({
        twiml: `<Response><Say>Transferring your call now.</Say><Dial>${this.profile.ownerPhone}</Dial></Response>`
      }).catch(e => console.error('[voice] Transfer error:', e.message));
    } catch (e) {
      console.error('[voice] Transfer error:', e.message);
    }
  }

  processAudio(payload) {
    if (this.ended) return;
    this.lastAudioTime = Date.now();

    // Decode base64 mulaw from Twilio, convert to linear16, send to Deepgram STT
    const mulawBuf = Buffer.from(payload, 'base64');
    const pcmBuf = mulawToLinear16(mulawBuf);

    if (this.sttWs && this.sttWs.readyState === WebSocket.OPEN) {
      this.sttWs.send(pcmBuf);
    }
  }

  _addTranscript(role, text) {
    this.transcript.push({ role, text, at: new Date().toISOString() });
  }

  getDuration() {
    return Math.round((Date.now() - this.startTime) / 1000);
  }

  getCost() {
    const durationMin = this.getDuration() / 60;
    const twilioIn = durationMin * 0.0085;
    const deepgramStt = (this.sttSeconds / 60) * 0.0043;
    // Deepgram TTS: ~$0.015 per 1000 chars
    const deepgramTts = (this.ttsChars / 1000) * 0.015;
    // Claude Haiku: input ~$0.25/MTok, output ~$1.25/MTok
    const claude = (this.inputTokens * 0.00000025) + (this.outputTokens * 0.00000125);
    const total = twilioIn + deepgramStt + deepgramTts + claude;
    return {
      twilio: Math.round(twilioIn * 1000) / 1000,
      deepgramStt: Math.round(deepgramStt * 1000) / 1000,
      deepgramTts: Math.round(deepgramTts * 1000) / 1000,
      claude: Math.round(claude * 1000) / 1000,
      total: Math.round(total * 1000) / 1000
    };
  }

  async _generateSummary() {
    if (this.transcript.length < 2) return 'Brief call with no substantial conversation.';
    try {
      const transcriptText = this.transcript.map(t => `${t.role === 'ai' ? 'AI' : 'Caller'}: ${t.text}`).join('\n');
      const resp = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 100,
        messages: [{ role: 'user', content: `Summarize this phone call in 1-2 sentences:\n\n${transcriptText}` }]
      });
      return resp.content[0]?.text || 'Call completed.';
    } catch {
      return 'Call completed.';
    }
  }

  async _analyzeSentiment() {
    if (this.transcript.filter(t => t.role === 'caller').length === 0) return 'neutral';
    try {
      const callerLines = this.transcript.filter(t => t.role === 'caller').map(t => t.text).join(' ');
      const resp = await this.anthropic.messages.create({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 10,
        messages: [{ role: 'user', content: `Classify the sentiment of this caller as exactly one word (positive, neutral, or negative):\n\n"${callerLines}"` }]
      });
      const s = (resp.content[0]?.text || 'neutral').toLowerCase().trim();
      if (['positive', 'negative', 'neutral'].includes(s)) return s;
      return 'neutral';
    } catch {
      return 'neutral';
    }
  }

  async end(reason = 'hangup') {
    if (this.ended) return null;
    this.ended = true;

    if (this.silenceTimer) clearTimeout(this.silenceTimer);
    if (this.promptTimer) clearTimeout(this.promptTimer);

    // Close STT WebSocket
    if (this.sttWs) {
      try { this.sttWs.close(); } catch {}
    }

    // Generate summary and sentiment
    const [summary, sentiment] = await Promise.all([
      this._generateSummary(),
      this._analyzeSentiment()
    ]);

    const callLog = {
      id: this.id,
      profileId: this.profile.id,
      callerNumber: this.callerNumber,
      callSid: this.callSid,
      startedAt: new Date(this.startTime).toISOString(),
      endedAt: new Date().toISOString(),
      durationSeconds: this.getDuration(),
      endReason: reason,
      sentiment,
      transcript: this.transcript,
      summary,
      actions: this.actions,
      cost: this.getCost()
    };

    console.log(`[voice] Call ended: ${this.callSid} (${this.getDuration()}s, ${reason})`);
    this.onEnd(callLog);
    return callLog;
  }

  getStatus() {
    return {
      id: this.id,
      callSid: this.callSid,
      profileId: this.profile.id,
      businessName: this.profile.businessName,
      callerNumber: this.callerNumber,
      duration: this.getDuration(),
      speaking: this.speaking,
      transcriptLength: this.transcript.length,
      actionsCount: this.actions.length
    };
  }
}

module.exports = { VoiceSession, TOOLS, buildSystemPrompt };
