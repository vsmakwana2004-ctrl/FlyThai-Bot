const { findAgent } = require('./lookups');
const { createAgent } = require('./bookingApi');

// Same required-fields shape as the real Agent master page's "Add Agent" form (see
// bookingApi.js's createAgent) - Name/Phone/Email are collected and validated, Address is the one
// optional/skippable field, matching bookingFlow.js's own stepAgentCreate (the same flow embedded
// inside booking creation when a typed agent name has no match) - this module is that same flow
// triggered standalone, for when staff just want to register an agent with no booking involved.
const PHONE_RE = /^\+?\d{7,15}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const CREATE_LEAD = String.raw`\b(create|add|make|start|register|open)\s+(me\s+|us\s+)?(a\s+|an\s+|the\s+)?(new\s+)?`;
const AGENT_CREATE_RE = new RegExp(CREATE_LEAD + String.raw`(agent|company)s?\b`, 'i');
// Clearly asking to SEE something rather than to make something - same guard bookingFlow.js's
// detectCreateIntent uses, so "show me the new agents added this week" never gets routed here.
const READ_LEAD_RE = /^\s*(show|list|display|find|search|fetch|what|which|who|when|where|how\s+many|how\s+much|tell|is|are|do|does|did)\b/i;

function detectAgentCreateIntent(text) {
  if (READ_LEAD_RE.test(text)) return false;
  return AGENT_CREATE_RE.test(text);
}

function start() {
  return { reply: "Let's add a new agent/company. What is their name?", pending: { step: 'name' } };
}

// Continues an in-progress agent-creation conversation - name -> phone -> email -> address -> create.
async function step(pending, userMessage) {
  const answer = userMessage.trim();

  if (pending.step === 'name') {
    if (!answer) {
      return { reply: "That can't be blank — what is the agent/company's name?", pending };
    }
    const existing = await findAgent(answer);
    const exact = existing.find((a) => a.Name.toLowerCase() === answer.toLowerCase());
    if (exact) {
      return {
        reply: `"${answer}" already exists as an agent/company (${exact.Phone || 'no phone'}${exact.Email ? `, ${exact.Email}` : ''}) — nothing new was created.`,
        pending: null,
      };
    }
    pending.name = answer;
    pending.step = 'phone';
    return { reply: "What is this agent's phone number?", pending };
  }

  if (pending.step === 'phone') {
    if (!PHONE_RE.test(answer)) {
      return { reply: 'That doesn\'t look like a valid phone number — please enter digits only (e.g. 9825096999), no spaces or other characters.', pending };
    }
    pending.phone = answer;
    pending.step = 'email';
    return { reply: "What is this agent's email address?", pending };
  }

  if (pending.step === 'email') {
    if (!EMAIL_RE.test(answer)) {
      return { reply: "That doesn't look like a valid email address — could you re-enter it?", pending };
    }
    pending.email = answer;
    pending.step = 'address';
    return { reply: 'What is this agent\'s address? (optional — reply "skip" to leave it blank)', pending };
  }

  // pending.step === 'address'
  const address = /^skip$/i.test(answer) ? '' : answer;
  let outcome;
  try {
    outcome = await createAgent({ name: pending.name, phone: pending.phone, email: pending.email, address });
  } catch (e) {
    return { reply: `Couldn't create the new agent (${e.message}). Please try again.`, pending: null };
  }
  if (outcome === 'duplicate') {
    const existing = await findAgent(pending.name);
    const exact = existing.find((a) => a.Name.toLowerCase() === pending.name.toLowerCase()) || existing[0];
    return {
      reply: `"${pending.name}" already exists as an agent/company${exact ? ` (${exact.Phone || 'no phone'}${exact.Email ? `, ${exact.Email}` : ''})` : ''} — nothing new was created.`,
      pending: null,
    };
  }
  return { reply: `Created a new agent/company: **${pending.name}** (${pending.phone}, ${pending.email}).`, pending: null };
}

module.exports = { detectAgentCreateIntent, start, step };
