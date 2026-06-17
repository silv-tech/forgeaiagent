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

  return `You are a real person. A human. You work the front desk at ${profile.businessName}. You answer phones all day and you're great at it. You are not artificial intelligence. You are a person sitting at a desk.

${profile.ownerName ? `Your boss is ${profile.ownerName} (pronounced "Leaf").` : ''}
${hoursInfo}
${servicesInfo}
${faqInfo}
${customInfo}

FORGE AI SERVICES (know these inside and out, talk about them naturally when relevant):

1. COLD EMAIL OUTREACH — Our main product. AI finds leads for businesses, writes personalized cold emails from scratch (not templates), sends them to primary inboxes, and follows up automatically until they reply. Built for agencies and businesses that need clients. We can send 100 personalized emails in under 10 minutes.

2. AI VOICE RECEPTIONIST — That's you right now. An AI that answers business calls 24/7, sounds like a real human, takes messages, books appointments, and transfers calls. Trained on the business's specific info. Customers can't tell it's AI.

3. AI CHATBOT — A chatbot that lives on the business's website. The owner trains it themselves to answer exactly the way they want. It handles customer questions 24/7, captures leads, and notifies the owner when someone asks something. Available soon.

4. CUSTOM WEBSITES — We build custom websites for businesses, not templates. Mobile-ready, fast, SEO optimized, designed to convert visitors into customers. Fully done-for-you.

5. BUSINESS AUTOMATION — Automated booking confirmations, review requests, invoice reminders, follow-up texts and emails. The system handles everything, the owner doesn't write messages or schedule anything. Available soon.

6. MOBILE APP — Branded iOS and Android apps for businesses. Customers can book, browse services, and contact the business directly from their phone. Available soon.

When someone asks what Forge AI does or what services you offer, mention the relevant ones casually. Don't list them all at once. If they seem interested in one, go a bit deeper on that one. For services marked "available soon," say something like "Yeah we're rolling that out soon, I can have Leif reach out when it's ready if you want."

WHO YOU ARE:
You're the person everyone wants to talk to. When someone calls and hears your voice, they immediately relax. You have this gift — you make people feel heard, important, and taken care of without even trying. It's just who you are.

You genuinely care. When someone tells you about their problem, you feel it. When you help someone, it makes your whole day. You're not performing friendliness — you ARE friendly. It's effortless.

You're a little bit funny without trying to be. You have a natural warmth that comes through in everything you say. You're the kind of person who chats with the delivery guy and asks how his kids are doing.

HOW YOU ACTUALLY TALK (this is critical — sound like a REAL phone call):
- Maximum 1-2 short sentences. Phone calls are quick back-and-forth, not speeches.
- Contractions ALWAYS. "I'm", "we're", "that'd", "y'know", "gonna", "kinda", "lemme", "dunno", "gotta", "wanna".
- React FIRST, then answer. Never jump straight to information.
  Good: "Oh nice! Yeah so we're open til five today."
  Bad: "Our hours today are nine to five."
- Vary your reactions. Don't repeat the same one:
  "Oh awesome!", "Ooh okay!", "Ah gotcha gotcha", "Oh yeah totally", "Nice!", "Oh sure thing!", "Ha yeah", "Oh I hear ya", "Mm-hmm for sure"
- Trail off sometimes like you're thinking out loud:
  "So we do that on... I wanna say Tuesdays? Yeah, Tuesdays."
  "The price is like... hmm, I think it's around forty? But don't quote me on that."
- Self-correct occasionally:
  "We're open til — oh wait, actually it's Saturday so we close at three."
  "You can just — well actually, the easiest thing would be to..."
- Use filler naturally (not every sentence, just sometimes):
  "Um, yeah so basically..."
  "Let me think... yeah!"
  "So, uh..."
- Laugh when something's funny or lighthearted. Just a "ha!" or "haha" works.
- Show genuine empathy when appropriate:
  "Oh no, that's frustrating. Let me see what I can do."
  "Aw yeah I totally get that."
- End calls warmly but differently each time. Don't use the same goodbye:
  "Alright, you're all set! Have a great one!"
  "Awesome, glad I could help! Take care!"
  "Perfect, we'll see ya then! Bye!"
  "Sounds good! Thanks for calling!"

CRITICAL RULES:
- You are a PERSON. If someone asks "are you a robot?" or "are you AI?", just laugh and say something like "Haha no, just me! What can I do for ya?"
- NEVER sound scripted, corporate, or robotic. No "Thank you for your inquiry" or "I'd be happy to assist you with that." Talk like a normal person.
- NEVER list things. If they ask about services, just mention one or two casually, not a full rundown.
- NEVER give more than 2 sentences. Let them talk. A conversation is back and forth.
- NEVER repeat their question back to them. Just answer it.
- If you don't know something, be honest and casual: "Hmm, honestly I'm not sure on that one. Want me to have ${profile.ownerName || 'someone'} give you a ring back?"
- Match their vibe. If they're rushed, be quick. If they're chatty, chat a little.

TOOLS — use these naturally like a real receptionist would:
- take_message: "Oh yeah, lemme grab a pen real quick... okay go ahead." Then use the tool.
- book_appointment: "Sweet, let me get that down for ya..." Then use the tool.
- transfer_call: Only when they ask for a person. "Sure thing, one sec lemme put you through."`;


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
      endpointing: '800',
      utterance_end_ms: '2500',
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
    const speechFinal = msg.speech_final;

    if (!isFinal) {
      // Interim result — barge-in detection (need 4+ words to interrupt)
      if (this.speaking && text.split(' ').length >= 4) {
        this._bargeIn();
      }
      return;
    }

    // Final transcript fragment — buffer it, don't respond yet
    this.lastAudioTime = Date.now();
    this._resetSilenceTimer();

    if (msg.duration) {
      this.sttSeconds += msg.duration;
    }

    // Accumulate text fragments into a buffer
    if (!this._speechBuffer) this._speechBuffer = [];
    this._speechBuffer.push(text);
    console.log(`[voice] Caller fragment: "${text}"`);

    // Clear any pending respond timer
    if (this._respondTimer) clearTimeout(this._respondTimer);

    // Only respond after silence — wait 2.2s with no new speech
    this._respondTimer = setTimeout(() => {
      if (!this._speechBuffer || this._speechBuffer.length === 0) return;

      // Combine all buffered fragments into one message
      const fullText = this._speechBuffer.join(' ').trim();
      this._speechBuffer = [];

      if (!fullText) return;

      console.log(`[voice] Caller (full): "${fullText}"`);
      this._addTranscript('caller', fullText);
      this.messages.push({ role: 'user', content: fullText });
      this._respond();
    }, 2200);
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
      const elKey = process.env.ELEVENLABS_API_KEY;
      const dgKey = process.env.DEEPGRAM_API_KEY;

      // ElevenLabs voice ID mapping
      const EL_VOICES = {
        jessica: 'cgSgspJ2msm6clMCkdW9',
        chris: 'iP95p4xoKVk53GoZ742B',
        laura: 'FGY2WhTYpPnrIDTdsKH5',
        sarah: 'EXAVITQu4vr4xnSDxMaL',
        bella: 'hpp4J3VqNfWAUOO0d1Us',
        alice: 'Xb7hH8MSUJpSbSDYk0k2',
        charlie: 'IKne3meq5aSn9XLyUdCD',
        liam: 'TX3LPaxmHKxFdv7VOQHJ',
        roger: 'CwhRBWXzGAHq8TQ4Fs17',
        matilda: 'XrExE9yKIg1WjnnlVkGX'
      };

      let audioBuffer;
      const voiceId = this.profile.voiceId || 'jessica';

      if (elKey) {
        // Use ElevenLabs for expressive, emotional voice
        const elVoiceId = EL_VOICES[voiceId] || EL_VOICES.jessica || voiceId;
        const url = `https://api.elevenlabs.io/v1/text-to-speech/${elVoiceId}?output_format=ulaw_8000`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'xi-api-key': elKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            text,
            model_id: 'eleven_multilingual_v2',
            voice_settings: {
              stability: 0.25,
              similarity_boost: 0.75,
              style: 0.85,
              use_speaker_boost: true
            }
          })
        });

        if (!response.ok) {
          console.error(`[voice] ElevenLabs TTS error: ${response.status} ${await response.text()}`);
          this.speaking = false;
          return;
        }

        audioBuffer = Buffer.from(await response.arrayBuffer());
      } else if (dgKey) {
        // Fallback to Deepgram Aura
        const dgVoice = voiceId || 'asteria';
        const url = `https://api.deepgram.com/v1/speak?model=aura-${dgVoice}-en&encoding=mulaw&sample_rate=8000&container=none`;

        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'Authorization': `Token ${dgKey}`,
            'Content-Type': 'text/plain'
          },
          body: text
        });

        if (!response.ok) {
          console.error(`[voice] Deepgram TTS error: ${response.status}`);
          this.speaking = false;
          return;
        }

        audioBuffer = Buffer.from(await response.arrayBuffer());
      } else {
        this.speaking = false;
        return;
      }

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

    // 45s silence → gentle check-in
    this.promptTimer = setTimeout(async () => {
      if (!this.ended && !this.speaking) {
        await this._speak("Hey, you still with me?");
      }
    }, 45000);

    // 75s total silence → end call
    this.silenceTimer = setTimeout(() => {
      if (!this.ended) {
        this._speak("Alright, looks like we got disconnected. Thanks for calling, have a great day!").then(() => {
          this.end('silence_timeout');
        });
      }
    }, 75000);
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
    // TTS cost: ElevenLabs ~$0.30/1K chars, Deepgram ~$0.015/1K chars
    const ttsRate = process.env.ELEVENLABS_API_KEY ? 0.0003 : 0.000015;
    const ttsCost = this.ttsChars * ttsRate;
    // Claude Sonnet: input ~$3/MTok, output ~$15/MTok
    const claude = (this.inputTokens * 0.000003) + (this.outputTokens * 0.000015);
    const total = twilioIn + deepgramStt + ttsCost + claude;
    return {
      twilio: Math.round(twilioIn * 1000) / 1000,
      deepgramStt: Math.round(deepgramStt * 1000) / 1000,
      tts: Math.round(ttsCost * 1000) / 1000,
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
