const { callLLM } = require('./llm');
const { findAgent, findDestinations, findHotel, findPickup, findVehicle, findPickupOrParticular, findSightseeing, findRestaurant, listDestinations, listVehicles, findHotelRoomType } = require('./lookups');
const { submitBooking, findBookingById, createAgent } = require('./bookingApi');
const { isWholeFlowCancel, isBareCancel } = require('./cancel');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
// Digits only (an optional leading + for a country code) - no spaces, hyphens, letters, or other
// punctuation. 7-15 digits covers the ITU E.164 range so a short local number isn't rejected while
// obvious garbage still is.
const PHONE_RE = /^\+?\d{7,15}$/;
// Whole-count fields (room count, pax) - digits only, nothing else. parseInt("5 rooms", 10) would
// silently accept that and return 5, quietly dropping the "rooms" instead of flagging the input as
// wrong - this rejects anything that isn't purely digits before parseInt ever runs.
const WHOLE_NUMBER_RE = /^\d+$/;
// Amount fields (rate per night, price per pax) - digits with an optional decimal part, nothing
// else (no currency symbols, commas, or trailing text) - same reasoning as WHOLE_NUMBER_RE above,
// against parseFloat("500 THB", ...) silently accepting 500.
const DECIMAL_NUMBER_RE = /^\d+(\.\d+)?$/;

// A message that names an existing record (FT.../FTQ...) is always about THAT record - "add hotel
// details to booking FT08261781" is a request to work on it, never a request to create a new one.
// The old loose pattern ("add" ... within 30 chars ... "booking") matched exactly that sentence and
// dropped the user into a brand-new blank booking flow.
const EXISTING_CODE_RE = /\bFTQ?\d+\b/i;

// Strong signal: a create verb sitting directly on the noun, so only the words in between are
// articles/qualifiers. "create a new booking", "add another quotation", "start a fresh booking".
// The trailing `s?` matters: "create new bookings" is phrased in the plural often enough, and
// `booking\b` silently fails on it (no word boundary between "g" and "s"). Those messages then fell
// through to the read-only planner, which truthfully answered that it cannot create anything -
// looking, to the user, like the feature simply didn't exist.
const CREATE_LEAD = String.raw`\b(create|add|make|start|register|open|book|prepare)\s+(me\s+|us\s+)?(a\s+|an\s+|the\s+)?(new\s+|another\s+|fresh\s+)?`;
const STRONG_CREATE_BOOKING_RE = new RegExp(CREATE_LEAD + String.raw`bookings?\b`, 'i');
const STRONG_CREATE_QUOTATION_RE = new RegExp(CREATE_LEAD + String.raw`(quotations?|quotes?)\b`, 'i');

// Weak signal: just the phrase "new booking" with no create verb. Real often enough to keep ("I
// need a new booking for Mr Shah"), but it also appears in plain lookups ("show me the new
// booking"), so this one is confirmed with the user before anything starts - see chat.js.
const WEAK_CREATE_BOOKING_RE = /\b(new|another)\s+bookings?\b/i;
const WEAK_CREATE_QUOTATION_RE = /\b(new|another)\s+(quotations?|quotes?)\b/i;

// Clearly asking to SEE something rather than to make something.
const READ_LEAD_RE = /^\s*(show|list|display|find|search|fetch|what|which|who|when|where|how\s+many|how\s+much|tell|is|are|do|does|did)\b/i;

// Returns null (not a create request), or { kind, confident }. confident=false means the caller
// should confirm with the user before starting the ~15-question collection flow.
function detectCreateIntent(text) {
  if (EXISTING_CODE_RE.test(text)) return null;

  if (STRONG_CREATE_QUOTATION_RE.test(text)) return { kind: 'quotation', confident: true };
  if (STRONG_CREATE_BOOKING_RE.test(text)) return { kind: 'booking', confident: true };

  if (READ_LEAD_RE.test(text)) return null;
  if (WEAK_CREATE_QUOTATION_RE.test(text)) return { kind: 'quotation', confident: false };
  if (WEAK_CREATE_BOOKING_RE.test(text)) return { kind: 'booking', confident: false };
  return null;
}

// A message that arrives with no active draft and no explicit "create a booking" wording, but is
// unmistakably a travel agent's full trip brief (a real day-by-day itinerary), is still obviously a
// create-booking request - making the user type "create a new booking" first and then paste the
// exact same message again was pure friction. Requires at least two real "Day N:" lines so it can't
// misfire on an unrelated multi-line message that happens to mention a date or "hotel" once - the
// same low bar looksLikeAgentPaste uses further down the flow would be too loose to trust here,
// since at this point nothing has confirmed the user wants to create anything at all yet.
const ITINERARY_DAY_LINE_RE = /^\s*day\s*\d+\s*:/gim;
function looksLikeStandaloneAgentPaste(text) {
  if (EXISTING_CODE_RE.test(text)) return false; // about an existing record, not a new one
  const dayLines = text.match(ITINERARY_DAY_LINE_RE) || [];
  return dayLines.length >= 2;
}

function startDraft(kind) {
  return {
    kind,
    phase: 'source',
    sourceStarted: false,
    fields: {},
    resolvedDestinations: null, // [{Id, Name}, ...] once resolved in trySubmitBasic
    hotelSelfBooked: null,
    hotels: [],
    itinerarySelfBooked: null,
    itineraryItems: [], // { type: 'transfer'|'restaurant', dayNumber, ...fields }
    members: [],
    priceFields: {},
    extraFields: {},
    destinationOptions: null, // cached full list, fetched once on first use
    vehicleOptions: null,
    basicStarted: false,
    basicCurrentStep: null,
    basicPaxAsked: false,
  };
}

// ---------- shared helpers ----------

function extractJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenced ? fenced[1] : text;
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end === -1) throw new Error('No JSON object found in model response');
  return JSON.parse(raw.slice(start, end + 1));
}

async function extractFields(systemPrompt, userMessage) {
  const raw = await callLLM(
    [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ],
    { temperature: 0.2 }
  );
  return extractJson(raw);
}

// Every "optional extras" step gives the model a prompt shaped like "Possible fields: time,
// remarks, ...". Verified directly against the live model that replying with just a bare field
// name (e.g. "time") sometimes makes it echo that word back as the field's own "value" -
// {"time": "time"} - rather than recognising nothing was actually specified. Silently accepting
// that would save garbage into a real field. Strips any value that's blank or is just the field's
// own name typed back.
function stripEchoedFields(fields) {
  const cleaned = {};
  for (const [key, value] of Object.entries(fields || {})) {
    if (typeof value === 'string') {
      const v = value.trim();
      if (!v || v.toLowerCase() === key.toLowerCase()) continue;
    }
    cleaned[key] = value;
  }
  return cleaned;
}

function parseYesNo(text) {
  const t = text.trim().toLowerCase();
  if (/^(yes|y|yeah|yep|haan|ha|sure|ok|okay|add|karo|kar do)\b/.test(t)) return true;
  if (/^(no|n|nahi|nope|skip|done|not now|later|self.?booked)\b/.test(t)) return false;
  return null;
}

// Escape hatch for when someone said "yes, add another" (hotel/transfer/restaurant) but then
// changes their mind partway through answering its required fields - none of those individual
// field prompts (name/date/category/etc.) legitimately expect "no"/"cancel" as real content, so
// this is safe to check first, at any point during that collection.
function isCancelItemIntent(text) {
  const t = text.trim().toLowerCase();
  return /^(no|n|nahi|cancel|skip|nevermind|never mind|stop)\b/.test(t) || /don'?t want|do not want|no need|no more/.test(t);
}

// Mirrors the real site's own parseDateDDMMYYYY() - rejects malformed/impossible calendar dates.
function parseDateDDMMYYYY(str) {
  if (!str || typeof str !== 'string') return null;
  const parts = str.trim().split('-');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10) - 1;
  const year = parseInt(parts[2], 10);
  if (Number.isNaN(day) || Number.isNaN(month) || Number.isNaN(year)) return null;
  const date = new Date(year, month, day);
  if (date.getFullYear() !== year || date.getMonth() !== month || date.getDate() !== day) return null;
  return date;
}

// Constructed the same way as parseDateDDMMYYYY (new Date(y, m, d) in server-local time) so the
// two are comparable regardless of what timezone the server process itself runs in - only the
// IST calendar date that goes into the constructor matters, not the server's own offset.
function todayDateObjIST() {
  const [y, m, d] = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' }).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// When the pasted message included a real day-by-day itinerary (draft._agentItineraryQueue), a
// return date earlier than the itinerary's own last day is impossible - "Day 13: ..." obviously
// means at least a 13-day trip. Generic over however many days the message actually listed, not
// hardcoded to any particular trip length.
function maxItineraryDay(draft) {
  const queue = draft._agentItineraryQueue;
  if (!Array.isArray(queue) || queue.length === 0) return null;
  const max = queue.reduce((m, item) => Math.max(m, Number(item.day) || 0), 0);
  return max > 0 ? max : null;
}

function addDaysToDateObj(dateObj, days) {
  const d = new Date(dateObj);
  d.setDate(d.getDate() + days);
  return d;
}

function formatDateObjDDMMYYYY(dateObj) {
  return `${String(dateObj.getDate()).padStart(2, '0')}-${String(dateObj.getMonth() + 1).padStart(2, '0')}-${dateObj.getFullYear()}`;
}

// The real max day of the itinerary actually built so far (every pushed item stores its own
// dayNumber, computed from travelDate at push time - see computeDayNumber) - unlike maxItineraryDay
// above, which only reads a pasted agent message's "_agentItineraryQueue" and is null for a
// manually-built itinerary. Used to suggest a return date once itinerary collection is done (see
// askReturnDateConfirm) instead of asking for it blind before any itinerary items exist.
function maxItineraryItemDay(draft) {
  const items = draft.itineraryItems;
  if (!Array.isArray(items) || items.length === 0) return null;
  const max = items.reduce((m, item) => Math.max(m, Number(item.dayNumber) || 0), 0);
  return max > 0 ? max : null;
}

// The trip's REAL length for an agent-pasted booking, from the message's own stated day-by-day
// itinerary (e.g. "Day 13: ..." -> a 13-day trip) - not just whatever's been individually added to
// draft.itineraryItems so far. Deliberately the higher of the two: items already built (dayNumber)
// AND whatever's still queued but not yet processed (draft._agentItineraryQueue's own day numbers,
// present even before a single item has been added) - so the suggested return date reflects the
// actual trip the message described, even if the user stops early via the itinerary continue/stop
// checkpoint (see stepAgentQueueContinue) partway through manually confirming each day's details.
// Reproduced live: a message describing a 13-day trip, stopped after only 2 days were confirmed in
// chat, wrongly suggested a 2-day return date - the checkpoint is about how much detail gets
// entered right now, not about how long the trip actually is.
function maxKnownItineraryDay(draft) {
  const itemsMax = maxItineraryItemDay(draft) || 0;
  const queue = draft._agentItineraryQueue;
  const queueMax = Array.isArray(queue) && queue.length > 0 ? queue.reduce((m, l) => Math.max(m, Number(l.day) || 0), 0) : 0;
  const max = Math.max(itemsMax, queueMax);
  return max > 0 ? max : null;
}

// Accepts whatever shape the user actually types - "14:30", "1430", "14.30", "2:30pm", "2pm" - and
// always normalizes to strict 24-hour "HH:mm" before it's ever stored, since that's the only format
// the real FlyThai form itself saves. Returns null if the text isn't confidently a time at all (the
// caller re-asks rather than guess). Bare 3-4 digit input ("1430"/"930") is read as HHmm/Hmm, never
// as a duration or anything else - matches how every real user actually types a clock time blind.
function parseFlexibleTime(str) {
  if (!str || typeof str !== 'string') return null;
  const t = str.trim().toLowerCase();

  const ampm = t.match(/^(\d{1,2})(?:[:.](\d{2}))?\s*(am|pm)$/);
  if (ampm) {
    let h = Number(ampm[1]);
    const min = ampm[2] ? Number(ampm[2]) : 0;
    if (h < 1 || h > 12 || min > 59) return null;
    if (ampm[3] === 'pm' && h !== 12) h += 12;
    if (ampm[3] === 'am' && h === 12) h = 0;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  const withSep = t.match(/^(\d{1,2})[:.](\d{2})$/);
  if (withSep) {
    const h = Number(withSep[1]);
    const min = Number(withSep[2]);
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  const bareDigits = t.match(/^(\d{3,4})$/);
  if (bareDigits) {
    const digits = bareDigits[1];
    const h = Number(digits.length === 4 ? digits.slice(0, 2) : digits.slice(0, 1));
    const min = Number(digits.slice(-2));
    if (h > 23 || min > 59) return null;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  }

  return null;
}

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
// The real Add Sightseeing form only lists tours flagged as running on the picked date's weekday
// (see lookups.js findSightseeing) - this derives that weekday name from a DD-MM-YYYY string.
function weekdayNameFor(dateStr) {
  const d = parseDateDDMMYYYY(dateStr);
  return d ? WEEKDAY_NAMES[d.getDay()] : null;
}

function computeDayNumber(itemDateStr, travelDateStr) {
  const itemDate = parseDateDDMMYYYY(itemDateStr);
  const travelDate = parseDateDDMMYYYY(travelDateStr);
  if (!itemDate || !travelDate) return 1;
  const diffDays = Math.round((itemDate - travelDate) / 86400000) + 1;
  return diffDays >= 1 ? diffDays : 1;
}

// An itinerary item's date must fall within the trip itself - date/pickup/etc checks only verified
// "is this a real calendar date", so a date before the travel date (or after the return date, when
// known) was silently accepted and then silently clamped to Day 1 by computeDayNumber above,
// masking the mistake instead of catching it. Reproduced live: editing an existing FT... booking
// (travel 25-12-2026 / return 28-12-2026) and adding a sightseeing item dated 24-12-2026 - before
// the trip even starts - was accepted with no warning.
function validateItineraryItemDate(dateStr, draft) {
  const itemDate = parseDateDDMMYYYY(dateStr);
  if (!itemDate) return 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?';
  const travelDate = parseDateDDMMYYYY(draft.fields.travelDate);
  if (travelDate && itemDate < travelDate) {
    return `That date is before the trip's travel date (${draft.fields.travelDate}) — could you re-enter it?`;
  }
  const returnDate = parseDateDDMMYYYY(draft.fields.returnDate);
  if (returnDate && itemDate > returnDate) {
    return `That date is after the trip's return date (${draft.fields.returnDate}) — could you re-enter it?`;
  }
  return null;
}

function formatDest(d) {
  return d.ShortCode ? `${d.Name} (${d.ShortCode})` : d.Name;
}

// ---------- phase: basic details (fully deterministic - one field at a time) ----------
// A small free LLM was found to unreliably track which of several growing fields a short reply
// answers (e.g. it merged an agent-name reply straight into guestName, then kept re-asking for
// the agent forever). Asking one question at a time and taking the raw reply directly removes
// that failure mode - no "which field does this answer" judgment call is needed at all.

// Agent is asked before phone/email (not after, like the previous order) so its Phone/Email/
// Address can be offered as a default - mirrors the real form's own getAgentDetails() behavior,
// which auto-fills the guest's phone/email/address from the selected Company/Agent record.
// returnDate is deliberately NOT in this list - it's no longer asked blind, up front. Once the
// itinerary is built, its span is used to suggest a return date and just confirm/adjust it (see
// askReturnDateConfirm, phase 'returnDateConfirm', after itineraryChoice finishes).
const BASIC_FIELD_ORDER = ['guestName', 'agentName', 'guestPhoneNumber', 'guestEmail', 'destinationNames', 'travelDate'];

function basicStepPrompt(stepKey, draft) {
  switch (stepKey) {
    case 'guestName':
      return "What is the guest's name?";
    case 'agentName':
      return "Which travel agent or company is this booked through? (start typing and select from the list, or type the exact name — if it doesn't exist yet, hit Create to add it as a new agent)";
    case 'guestPhoneNumber':
      return draft.resolvedAgent && draft.resolvedAgent.Phone
        ? `What is the guest's phone number? (reply "same" to use the agent's number: ${draft.resolvedAgent.Phone})`
        : "What is the guest's phone number?";
    case 'guestEmail':
      return draft.resolvedAgent && draft.resolvedAgent.Email
        ? `What is the guest's email address? (reply "same" to use the agent's email: ${draft.resolvedAgent.Email})`
        : "What is the guest's email address?";
    case 'destinationNames':
      return `Which destination(s) is this trip to? You can use the full name or the short code. Available: ${draft.destinationOptions.map(formatDest).join(', ')}`;
    case 'travelDate':
      return 'What is the travel date? (format DD-MM-YYYY)';
    default:
      return '';
  }
}

function nextBasicStep(draft) {
  return BASIC_FIELD_ORDER.find((key) => {
    const v = draft.fields[key];
    if (Array.isArray(v)) return v.length === 0;
    return v === undefined || v === null || v === '';
  });
}

// Called right before the 'agentName' step is about to be asked (from both basicNextPrompt and
// stepBasic's own end-of-step transition) - if the pasted agent message named its own sender (see
// agentNameHint on agentPasteSystemPrompt) and that resolves to exactly one confident real Agent
// match, stages it for a yes/change confirm instead of the blank question, same "suggest, don't
// silently apply" pattern stageHotelPreference already uses for a preferred hotel name. Tried only
// once per draft (_agentNameHintTried) so answering "change" doesn't re-trigger the same suggestion.
async function agentNameStepPrompt(draft) {
  if (draft._agentNameHint && !draft._agentNameHintTried) {
    draft._agentNameHintTried = true;
    const agents = await findAgent(draft._agentNameHint);
    // A single confident match only - several fuzzy hits (or none) fall straight through to the
    // normal question below, exactly like a same-situation manual typed answer would (see stepBasic's
    // own 'agentName' case).
    if (agents.length === 1) {
      draft._pendingAgentMatch = agents[0];
      draft.basicCurrentStep = 'agentNameConfirm';
      return `The message mentions **${agents[0].Name}** as the agent — is that correct, or would you like to select a different one?`;
    }
  }
  draft.basicCurrentStep = 'agentName';
  return basicStepPrompt('agentName', draft);
}

// ---------- phase: source (manual vs travel-agent-provided) ----------
// The very first question of any new booking/quotation: was this typed in from scratch, or is it
// based on a message a travel agent already sent with (partial) trip details? Previously asked as
// its own separate "manual booking / travel agent booking" choice before anything else - merged
// into the guest-name question instead (one fewer click for the common case): a short, single-line
// reply is taken as the guest's name and the manual flow continues from the NEXT field; a reply
// that looks like a pasted agent message (multi-line, or clearly bundles several trip details) is
// routed straight into the exact same extraction stepAgentPaste already does, without a second
// "please paste it" round-trip since this message already IS the paste. Everything downstream
// (stepAgentPaste, stepBasic, and everything after it) is completely untouched by this change.

function sourceChoicePrompt(draft) {
  return `Let's create a new ${draft.kind}. What is the guest's name?\n\n_(Or paste a travel agent's message with the trip details, and I'll pull out whatever I can from it. You can say **cancel** at any point to stop.)_`;
}

// Heuristic only, not a guarantee - a name that happens to be unusually long/detailed could still
// be misclassified as a paste (or vice versa), but a plain guest name never looks like this: it's
// one short line, no dates, no trip-shaped keywords, no several-details-bundled-with-commas shape.
// Worst case of a wrong guess is a wrong-looking Guest Name in the eventual confirmation summary,
// which is still checked by a human before anything saves - never a silently wrong save.
function looksLikeAgentPaste(text) {
  const t = text.trim();
  if (/\n/.test(t)) return true; // a real paste is almost always multi-line
  if (t.length > 60) return true; // no real guest name is ever this long
  if (/\d{1,2}[\/\-]\d{1,2}([\/\-]\d{2,4})?/.test(t)) return true; // a date
  if (/\b(nights?|pax|adults?|hotel|itinerary|check.?in|check.?out)\b/i.test(t)) return true; // trip-shaped words
  if ((t.match(/,/g) || []).length >= 2) return true; // several details bundled onto one line
  return false;
}

async function stepSource(draft, userMessage) {
  if (!draft.sourceStarted) {
    draft.sourceStarted = true;
    return { reply: sourceChoicePrompt(draft), draft };
  }

  const answer = userMessage.trim();
  if (looksLikeAgentPaste(answer)) {
    draft.phase = 'agentPaste';
    if (!draft.destinationOptions) draft.destinationOptions = await listDestinations();
    return stepAgentPaste(draft, userMessage);
  }

  draft.fields.guestName = answer;
  draft.basicStarted = true;
  draft.phase = 'basic';
  // Only the true manual path (typed straight in, not extracted from a pasted agent message) asks
  // return date directly, right after travel date - see the viaManualEntry check in basicNextPrompt/
  // stepBasic below. The agent-paste flow keeps deriving/confirming it from the itinerary instead,
  // untouched.
  draft.viaManualEntry = true;
  return { reply: await basicNextPrompt(draft), draft };
}

// ---------- phase: agentPaste (pre-fill basic fields from a pasted travel-agent message) ----------
// Only pre-fills fields that are either free text (guestName) or already confirmed against real
// records the same way the manual flow does (findDestinations) - destinations are only auto-filled
// when EVERY one resolves cleanly and unambiguously, same standard the manual destinationNames
// step itself enforces, so a bad guess never silently attaches the wrong destination Id. Anything
// the model can't confidently map to a real field (hotel categories, room-wise pax splits, day-by-
// day itinerary, special requests) is preserved verbatim as an extra note rather than dropped, since
// this codebase has no safe way to auto-resolve those against hotel/transfer/sightseeing master
// records without risking a wrong DB match on a real booking.

function agentPasteSystemPrompt(destinationOptions) {
  const d = todayDateObjIST();
  const todayStr = `${String(d.getDate()).padStart(2, '0')}-${String(d.getMonth() + 1).padStart(2, '0')}-${d.getFullYear()}`;
  return `You are reading a raw message forwarded from a travel agent describing a trip they want booked. This message may be complete or partial - it may mention MORE or FEWER details than a typical booking needs. Extract ONLY what is literally stated. Never guess, infer, assume a default, or invent a value that isn't actually supported by the text - if you are not sure about a field, or it simply isn't mentioned, leave that field out of the JSON entirely. Getting a field wrong is worse than leaving it blank, since a blank field just gets asked about normally afterwards.

Today's date is ${todayStr} (DD-MM-YYYY). Use it only to resolve a stated date that omits its year (pick the nearest sensible upcoming date) and to compute a return date from an explicit check-in date plus an explicit list of "<place> - N Nights" covering every destination mentioned - if either the check-in date or the full list of nights isn't clearly present, leave travelDate/returnDate out rather than guess.

Known destinations in the system - match the agent's place names to these (closest match only; never include a destination that the message doesn't actually name, and never invent one that isn't in this list): ${destinationOptions.map((dd) => dd.Name).join(', ')}

Fields:
- guestName: the actual traveller/guest's name, ONLY if a specific person's name is clearly given as the traveller (not the travel agent's own name/company, and not guessed from context)
- agentNameHint: the travel agent/company's OWN name if the message clearly identifies who sent it (often a heading/signature line at the very top or bottom, e.g. a company name ending in "Travels"/"Tours"/"Holidays"/similar) - this is the sender, never the traveller. Omit if the message doesn't clearly name the sending agent/company.
- destinationNames: array of destination names (from the list above) the trip covers, in visiting order if determinable - only ones actually named in the message
- travelDate: DD-MM-YYYY, only if clearly stated or unambiguously computable as described above
- returnDate: DD-MM-YYYY, only if clearly stated or unambiguously computable as described above
- guestAdults: number of adults, only if a number of adults is explicitly stated
- guestChildrens: number of children, only if explicitly stated - do NOT default to 0 just because adults were mentioned without children being mentioned; omit this field instead
- guestInfants: number of infants, only if explicitly stated - same rule, do NOT default to 0
- itineraryLines: if the message has a day-by-day plan ("Day 1: ...", "Day 2: ...", etc), one entry per day-line: {"day": <number>, "type": "transfer" | "sightseeing" | "leisure", "pickupHint": <short literal place name to search for as the start point - transfer only, else null>, "dropoffHint": <short literal place name to search for as the end point - transfer only, else null>, "transferNameHint": <a short generic transfer label like "Airport to Hotel", "Hotel to Airport", "Inter Hotel Transfer" - transfer only, else null>, "activityHint": <short literal name of the tour/activity - sightseeing only, else null>}. A day that's explicitly a free/leisure day is type "leisure" (no hints needed - and don't invent an activity for it). A day that moves between an airport and a hotel, or between two hotels/islands, is type "transfer". A day naming a specific activity/tour is type "sightseeing". If one day's line actually describes TWO separate movements (e.g. "X to Y transfer + A to B transfer"), emit TWO entries with that same day number. These hints are only used to search real records already in the system - if nothing matches, that one field is simply asked about normally afterwards, so keep each hint a short literal place/activity name, not a full sentence, and never invent one that isn't grounded in the text.
- hotelPreferences: array of {"destinationName": <one of the known destinations above>, "hotelName": <the specific hotel name mentioned for that destination, with qualifiers like "or similar"/"or similar category" stripped off>} for each destination where the message names a preferred/requested hotel. Omit a destination entirely if no specific hotel name is given for it.

Respond with ONLY JSON: {"guestName": ..., "agentNameHint": ..., "destinationNames": [...], "travelDate": ..., "returnDate": ..., "guestAdults": ..., "guestChildrens": ..., "guestInfants": ..., "itineraryLines": [...], "hotelPreferences": [...]}`;
}

// Builds the shared "what's still missing" prompt used both when the agent-provided extraction is
// accepted (stepAgentPasteConfirm) and when nothing usable was extracted at all (stepAgentPaste) -
// same end-of-basic-phase logic stepBasic itself uses (nextBasicStep -> pax question -> hotel
// choice), duplicated here rather than shared so stepBasic's own manual-flow code path is never
// touched by this feature.
async function basicNextPrompt(draft) {
  const next = nextBasicStep(draft);
  if (next === 'agentName') return agentNameStepPrompt(draft);
  if (next) {
    draft.basicCurrentStep = next;
    return basicStepPrompt(next, draft);
  }
  // Manual entry only (typed straight in, not a travel-agent paste): ask return date directly right
  // after travel date, instead of deriving/suggesting it later from the itinerary's length - a
  // manually-built itinerary's item count doesn't necessarily match the actual trip length (free/
  // unlisted days, etc). Once this is set, askReturnDateConfirm's later itinerary-done check
  // (draft.fields.returnDate already present) just passes through without re-asking or suggesting.
  if (draft.viaManualEntry && !draft.fields.returnDate) {
    draft.basicCurrentStep = 'returnDate';
    return 'What is the return date? (format DD-MM-YYYY)';
  }
  if (!draft.basicPaxAsked) {
    draft.basicPaxAsked = true;
    draft.basicCurrentStep = 'travelCount';
    return 'How many Adults/Children/Infants are travelling? e.g. "4 adults, 1 child" (optional — reply "skip" to leave this for now)';
  }
  // An agent-pasted message with its own day-by-day itinerary already states the trip's real
  // length ("Day 13: ..." -> 13 days) - decided/confirmed HERE, right as the basic details finish,
  // using that stated length (see maxKnownItineraryDay), rather than deferred until the itinerary
  // is actually built item by item later - which might get cut short by the itinerary continue/stop
  // checkpoint (stepAgentQueueContinue) and wrongly suggest a shorter trip than the message says.
  if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
    return askReturnDateConfirm(draft, 'hotelChoice').reply;
  }
  draft.phase = 'hotelChoice';
  return `Got the basic details for **${draft.fields.guestName}**. Now — is the hotel self-booked (guest arranging their own), or would you like to add hotel details? (reply "self-booked" or "add hotel")`;
}

// Extraction only ever writes into a staging object here, never straight into draft.fields - the
// LLM can misread or over/under-count a partial message, so nothing it produces is trusted onto a
// real field until a human explicitly confirms it in stepAgentPasteConfirm below. Destinations are
// additionally re-verified against real records (findDestinations) before being offered, same as
// the manual destinationNames step - a name the model got wrong or that matches ambiguously simply
// isn't offered at all, exactly like the manual flow's own behaviour on a bad/ambiguous match.
async function stepAgentPaste(draft, userMessage) {
  if (!draft.destinationOptions) draft.destinationOptions = await listDestinations();
  const answer = userMessage.trim();

  let parsed = {};
  try {
    parsed = await extractFields(agentPasteSystemPrompt(draft.destinationOptions), answer);
  } catch (e) {
    parsed = {};
  }

  const staged = {};
  const filled = [];
  let resolvedDestinations = null;
  let stagedPaxAsked = false;

  if (parsed.guestName && String(parsed.guestName).trim()) {
    staged.guestName = String(parsed.guestName).trim();
    filled.push(`Guest Name: ${staged.guestName}`);
  }

  // Not a real field itself - kept out of `staged` (which gets Object.assign'd straight onto
  // draft.fields on accept) since it's only a hint to try against real Agent records, not a value
  // to save as-is. Actually resolved (findAgent) later, lazily, once the agentName basic step is
  // about to be asked - see agentNameStepPrompt - same "suggest, don't apply outright" pattern
  // stageHotelPreference already uses for a preferred hotel name.
  let agentNameHint = null;
  if (parsed.agentNameHint && String(parsed.agentNameHint).trim()) {
    agentNameHint = String(parsed.agentNameHint).trim();
    filled.push(`Agent: ${agentNameHint}`);
  }

  if (Array.isArray(parsed.destinationNames) && parsed.destinationNames.length > 0) {
    try {
      const { matches, notFound } = await findDestinations(parsed.destinationNames);
      const ambiguous = matches.filter((m) => m.ambiguous);
      if (notFound.length === 0 && ambiguous.length === 0 && matches.length > 0) {
        resolvedDestinations = matches;
        staged.destinationNames = matches.map((m) => m.Name);
        filled.push(`Destinations: ${matches.map(formatDest).join(', ')}`);
      }
    } catch (e) {
      // leave unresolved - the normal destinationNames question below will ask for it
    }
  }

  // Day-by-day itinerary lines and per-destination hotel preferences - also staged, not applied,
  // until the same yes/no gate below. Only well-formed entries are kept (a real day number and a
  // recognised type) - anything the model returned outside that shape is dropped rather than risk
  // acting on it. Actually resolving these against real hotel/pickup/transfer/sightseeing records
  // happens later, lazily, once the itinerary/hotel phase is actually reached (see
  // processAgentItineraryQueue and applyAgentHotelPreference) - never here, and never against
  // anything other than the same lookup functions/matching rules the manual flow itself uses.
  // Computed BEFORE travelDate below so its own day-count is available for the estimated-return-date
  // preview shown right under Travel Date.
  const itineraryLines = Array.isArray(parsed.itineraryLines)
    ? parsed.itineraryLines.filter((l) => l && Number.isFinite(Number(l.day)) && ['transfer', 'sightseeing', 'leisure'].includes(l.type))
    : [];
  const hotelPreferences = Array.isArray(parsed.hotelPreferences)
    ? parsed.hotelPreferences.filter((p) => p && p.destinationName && p.hotelName)
    : [];
  // itineraryLines.length counts LINE ITEMS, not days - a day whose line describes two movements
  // ("X to Y transfer + A to B transfer") is deliberately split into two same-day entries above, so
  // a 13-day trip with one such day yields 14 items. Showing that raw count read as if it were the
  // day count ("14 day-item(s) detected" on a message that plainly says "Day 13: ...") looked like
  // the trip length itself was miscounted - reproduced live. Use only the real day count (the
  // highest day number actually seen), never the raw item count, so this can't happen again.
  const itineraryDayCount = itineraryLines.length > 0 ? new Set(itineraryLines.map((l) => Number(l.day))).size : 0;

  const travelDateObj = parsed.travelDate ? parseDateDDMMYYYY(parsed.travelDate) : null;
  if (travelDateObj && travelDateObj >= todayDateObjIST()) {
    staged.travelDate = parsed.travelDate;
    filled.push(`Travel Date: ${parsed.travelDate}`);
    // A preview only (not staged onto draft.fields.returnDate) - the itinerary-done step further
    // into this same flow (askReturnDateConfirm/maxKnownItineraryDay) still asks the user to
    // confirm or change it once the itinerary is actually built; this just surfaces that same
    // estimate here too, right under the travel date, instead of only much later. Skipped when the
    // message already gave an explicit return date (shown on its own line right below instead).
    if (!parsed.returnDate && itineraryDayCount > 0) {
      const estimatedReturnObj = new Date(travelDateObj);
      estimatedReturnObj.setDate(estimatedReturnObj.getDate() + itineraryDayCount - 1);
      const dd = String(estimatedReturnObj.getDate()).padStart(2, '0');
      const mm = String(estimatedReturnObj.getMonth() + 1).padStart(2, '0');
      filled.push(`Return Date (estimated from the ${itineraryDayCount}-day itinerary): ${dd}-${mm}-${estimatedReturnObj.getFullYear()}`);
    }
  }
  const returnDateObj = parsed.returnDate ? parseDateDDMMYYYY(parsed.returnDate) : null;
  if (returnDateObj && staged.travelDate && returnDateObj > parseDateDDMMYYYY(staged.travelDate)) {
    staged.returnDate = parsed.returnDate;
    filled.push(`Return Date: ${parsed.returnDate}`);
  }

  const adultsNum = Number(parsed.guestAdults);
  if (parsed.guestAdults != null && Number.isFinite(adultsNum) && adultsNum > 0) {
    staged.guestAdults = adultsNum;
    stagedPaxAsked = true;
    filled.push(`Adults: ${adultsNum}`);
  }
  const childrenNum = Number(parsed.guestChildrens);
  if (parsed.guestChildrens != null && Number.isFinite(childrenNum) && childrenNum >= 0) {
    staged.guestChildrens = childrenNum;
    filled.push(`Children: ${childrenNum}`);
  }
  const infantsNum = Number(parsed.guestInfants);
  if (parsed.guestInfants != null && Number.isFinite(infantsNum) && infantsNum >= 0) {
    staged.guestInfants = infantsNum;
    filled.push(`Infants: ${infantsNum}`);
  }

  if (itineraryLines.length > 0) {
    filled.push(`Itinerary: ${itineraryDayCount} day(s) found — I'll try to build these automatically once we reach that step, and only ask about whatever doesn't match a real record.`);
  }
  if (hotelPreferences.length > 0) {
    filled.push(`Hotel preferences: ${hotelPreferences.map((p) => `${p.destinationName} → ${p.hotelName}`).join(', ')}`);
  }

  // No auto-generated note - extraNote only ever gets filled if the human explicitly types one in
  // the extras step at the end of the flow (askExtras/extraSystemPrompt). An LLM-summarized note
  // isn't something anyone asked for, and its length was also what caused FlyThai's AddBooking to
  // silently reject bookings above ~350 chars (see EXTRA_NOTE_MAX_LENGTH/capExtraNote below).
  draft.agentRawMessage = answer;

  if (filled.length === 0) {
    draft.basicStarted = true;
    draft.phase = 'basic';
    const prompt = await basicNextPrompt(draft);
    return { reply: `I couldn't confidently pull any structured details from that message, so I'll ask for everything as usual.\n\n${prompt}`, draft };
  }

  draft._pendingAgentExtract = { fields: staged, resolvedDestinations, basicPaxAsked: stagedPaxAsked, itineraryLines, hotelPreferences, agentNameHint };
  draft.phase = 'agentPasteConfirm';
  return {
    reply: `I read this from the message — please double-check it against what the agent actually sent before I use it:\n${filled.map((f) => `- ${f}`).join('\n')}\n\nUse these details? Reply "yes" to continue with them, or "no" to enter the basic details manually instead.`,
    draft,
  };
}

// The human checkpoint that the staged extraction above waits on - nothing it produced reaches
// draft.fields (and therefore the eventual saved booking) unless explicitly accepted here.
async function stepAgentPasteConfirm(draft, userMessage) {
  const yn = parseYesNo(userMessage);
  if (yn === null) {
    return { reply: 'Reply "yes" to use these details, or "no" to enter the basic details manually instead.', draft };
  }

  const staged = draft._pendingAgentExtract || { fields: {}, resolvedDestinations: null, basicPaxAsked: false, itineraryLines: [], hotelPreferences: [] };
  delete draft._pendingAgentExtract;

  if (yn === true) {
    Object.assign(draft.fields, staged.fields);
    if (staged.resolvedDestinations) draft.resolvedDestinations = staged.resolvedDestinations;
    if (staged.basicPaxAsked) draft.basicPaxAsked = true;
    // Only set when non-empty, so every later check (draft._agentItineraryQueue && ...length > 0)
    // stays a single cheap truthiness test and this is provably never present for a manual draft.
    if (Array.isArray(staged.itineraryLines) && staged.itineraryLines.length > 0) draft._agentItineraryQueue = staged.itineraryLines;
    if (Array.isArray(staged.hotelPreferences) && staged.hotelPreferences.length > 0) draft._agentHotelPrefs = staged.hotelPreferences;
    if (staged.agentNameHint) draft._agentNameHint = staged.agentNameHint;
  }
  // yn === false: staged data is simply discarded - draft.fields is untouched, so every field just
  // gets asked about normally below, same as if nothing had ever been extracted.

  draft.basicStarted = true;
  draft.phase = 'basic';
  const prompt = await basicNextPrompt(draft);
  return { reply: prompt, draft };
}

// ---------- travel-agent auto-fill: hotel name preference + day-by-day itinerary queue ----------
// Both draft._agentHotelPrefs and draft._agentItineraryQueue are set ONLY from
// stepAgentPasteConfirm above (and only when non-empty) - every function below is a no-op/never
// called for a manual draft, since those properties are simply never present on one. Everything
// here resolves against real records using the exact same lookup functions and "only act on an
// unambiguous match" rule the manual per-field questions already use (resolveSequentialLookup,
// findHotel) - a hint that doesn't resolve just leaves that one field to be asked about normally,
// exactly as if the user had typed the same partial info by hand. Nothing here bypasses the
// booking-level confirm-before-save summary (buildConfirmationSummary) - every auto-added hotel/
// itinerary row still shows up there for a final human check before anything is saved.

function addDaysToDDMMYYYY(dateStr, days) {
  const d = parseDateDDMMYYYY(dateStr);
  if (!d) return null;
  const result = new Date(d.getFullYear(), d.getMonth(), d.getDate() + days);
  return `${String(result.getDate()).padStart(2, '0')}-${String(result.getMonth() + 1).padStart(2, '0')}-${result.getFullYear()}`;
}

// Same "0 matches -> treat the typed name as a new hotel entry, 1 match -> use it, 2+ -> don't
// guess" convention the manual hotelName question already applies (see stepHotelCollect) - reused
// here verbatim rather than reimplemented, so a preference resolves exactly the way the same name
// would if the user had typed it themselves.
async function tryResolveHotelName(candidateName) {
  const found = await findHotel(candidateName);
  if (found.length === 1) return { hotelName: found[0].Name, resolvedHotelId: found[0].Id };
  if (found.length === 0) return { hotelName: candidateName, resolvedHotelId: 0 };
  return null; // ambiguous - leave it to the normal hotelName question instead of guessing
}

// Called once a hotel row's destination is known (either auto-picked for a single-destination
// trip, or just answered for a multi-destination one) - looks up whether the travel agent named a
// preferred hotel for that destination (e.g. "Phuket: Andakira or similar category" - the "or
// similar" qualifier is already stripped off by the extraction prompt, see hotelPreferences above)
// and, if it resolves to exactly one real hotel, STAGES it for confirmation rather than silently
// applying it - "or similar" is explicitly not a firm choice, so the user gets to say yes or pick a
// different one (via the same hotel dropdown the manual question already shows) before it's used,
// instead of it being locked in from a single fuzzy text match with no visibility. A name with no
// match, or an ambiguous one (2+ hotels), returns null unchanged - falls through to the normal
// hotelName question exactly as before, since there's nothing confident enough to even suggest.
async function stageHotelPreference(draft, h) {
  if (!draft._agentHotelPrefs || !h._destId) return null;
  const dest = draft.resolvedDestinations.find((d) => d.Id === h._destId);
  if (!dest) return null;
  const pref = draft._agentHotelPrefs.find((p) => p.destinationName && dest.Name.toLowerCase() === String(p.destinationName).toLowerCase());
  if (!pref) return null;
  const resolved = await tryResolveHotelName(pref.hotelName);
  if (!resolved || resolved.resolvedHotelId === 0) return null;
  h._pendingHotelPrefName = resolved.hotelName;
  h._pendingHotelPrefId = resolved.resolvedHotelId;
  return resolved;
}

async function tryResolvePoint(hint) {
  if (!hint) return null;
  const rows = await findPickup(hint);
  return rows.length === 1 ? rows[0] : null;
}

async function tryResolveTransferParticular(hint) {
  if (!hint) return null;
  const rows = await findPickupOrParticular(hint);
  if (rows.length === 1) return rows[0];
  // A hint that's an exact (case-insensitive) name match for ONE of several fuzzy-matched rows -
  // e.g. "Phuket Airport to Phuket Hotel" is itself a plain substring of the real, separate
  // "Phuket Airport to Phuket Hotel (Enroute Lunch)" record, so the LIKE search above always
  // returns both - is still a confident single answer, not a real ambiguity.
  if (rows.length > 1) {
    const exact = rows.filter((r) => r.Name.toLowerCase() === hint.toLowerCase());
    if (exact.length === 1) return exact[0];
  }
  return null;
}

// A pasted itinerary line's pickup/dropoff hint is often a placeholder, not a specific real
// location - "HKT hotel"/"Phuket hotel" means "wherever the guest's hotel booking for Phuket ends
// up being", which will never match a specific Pickup record (there is no literal "Phuket Hotel"
// row - real hotels have their own names). But the transfer catalog itself has generic named
// products for exactly this ("Phuket Airport to Phuket Hotel", confirmed live) - if the hint text
// mentions one of the trip's own known destinations (by name or short code, e.g. "HKT" -> Phuket),
// "<that destination> Hotel" is a reasonable stand-in to try in tryResolveTransferParticular's
// query, even though it was never resolved as a real Pickup point itself.
function guessDestinationHotelPlaceholder(hintText, resolvedDestinations) {
  if (!hintText || !Array.isArray(resolvedDestinations)) return null;
  const t = hintText.toLowerCase();
  const dest = resolvedDestinations.find((d) => t.includes(d.Name.toLowerCase()) || (d.ShortCode && t.includes(String(d.ShortCode).toLowerCase())));
  return dest ? `${dest.Name} Hotel` : null;
}

async function tryResolveSightseeing(hint, weekday) {
  if (!hint) return null;
  const rows = await findSightseeing(hint, weekday);
  return rows.length === 1 ? rows[0] : null;
}

// askItineraryChoice() also offers "self-booked", which reads oddly once real items already exist
// on this draft - the manual flow never hits that case (it only ever calls askItineraryChoice()
// before the first item), but the auto-queue below can resume this function after items already
// exist, so it picks the more apt continuation phrasing itself.
function itineraryContinuePrompt(draft) {
  return draft.itineraryItems.length > 0 ? askAddMoreItinerary() : askItineraryChoice();
}

// The single entry/resume point for the auto-queue - called both when a travel-agent-sourced draft
// first reaches the itinerary phase (from stepHotelChoice/stepHotelAddAnother/the hotel-cancel
// branch) and again after each auto-started item finishes (from the transfer/sightseeing/
// restaurant/leisure "item added" tails), until the queue is empty. Leisure entries need no
// per-field questions at all, so a whole run of them is added silently in one pass; a transfer/
// sightseeing entry pre-fills whatever resolves and then hands off to the ordinary
// stepTransferCollect/stepSightseeingCollect dispatch (unmodified) for whatever's still missing.
async function processAgentItineraryQueue(draft, prefix) {
  draft.phase = 'itineraryChoice';
  const queue = draft._agentItineraryQueue;
  if (!queue || queue.length === 0) {
    return { reply: `${prefix}${itineraryContinuePrompt(draft)}`, draft };
  }

  // Once at least one real (non-leisure) item has actually been added from the message, pause
  // before pulling the next one instead of barrelling through the whole rest of a long itinerary
  // (a 13-day trip can mean a dozen transfer/sightseeing items in a row, each needing its own
  // pickup/time/etc confirmed) - gives an explicit, easy exit at every step instead of only at the
  // very end. Leisure days need no back-and-forth at all, so a run of them is still added silently
  // in one pass either way (see below) - this only ever interrupts BETWEEN real items.
  if (draft._agentQueueRealItemAdded && queue.length > 0) {
    draft.phase = 'agentQueueContinue';
    const dayWord = queue.length === 1 ? 'day' : 'days';
    return {
      reply: `${prefix}${queue.length} more ${dayWord} left in the message's itinerary. Continue adding them, or is this enough?`,
      draft,
      // Lets the frontend visually set this message apart from a normal reply (see chat.js/app.js)
      // - it's a checkpoint pause, not just conversation, so it should read as one at a glance on a
      // long 13-day itinerary with a dozen of these in a row.
      checkpoint: true,
    };
  }

  let leisureAdded = 0;
  while (queue.length > 0 && queue[0].type === 'leisure') {
    const line = queue.shift();
    const dateStr = addDaysToDDMMYYYY(draft.fields.travelDate, Number(line.day) - 1);
    if (!dateStr || validateItineraryItemDate(dateStr, draft)) continue; // out of the trip's own date range - skip rather than guess
    draft.itineraryItems.push({
      type: 'sightseeing', // same shape stepLeisureDayCollect itself pushes for a leisure day
      id: '',
      dayNumber: computeDayNumber(dateStr, draft.fields.travelDate),
      date: dateStr,
      time: '',
      pickupPointId: '',
      pickupPointName: '',
      particularId: '',
      transferName: '',
      transferCode: '',
      totalAdult: '0',
      adultPrice: '0',
      totalChild: '0',
      childPrice: '0',
      currency: draft.fields.currency || 'THB',
      remarks: '',
      selfBooked: true,
      finalPrice: 0,
      costPerAdult: 0,
      costPerChild: 0,
      costPerInfant: 0,
      totalInfant: String(draft.fields.guestInfants || 0),
      flightNo: null,
    });
    leisureAdded += 1;
  }
  const leisureNote = leisureAdded > 0 ? `Auto-added ${leisureAdded} leisure day(s) from the message. ` : '';

  if (queue.length === 0) {
    return { reply: `${prefix}${leisureNote}${itineraryContinuePrompt(draft)}`, draft };
  }

  const line = queue.shift();
  const dateStr = addDaysToDDMMYYYY(draft.fields.travelDate, Number(line.day) - 1);
  if (!dateStr || validateItineraryItemDate(dateStr, draft)) {
    // Can't safely place this one (falls outside the trip's own travel/return range, or the day
    // count didn't add up) - drop it rather than guess; it can still be added manually afterwards.
    return processAgentItineraryQueue(draft, prefix + leisureNote);
  }

  if (line.type === 'transfer') {
    draft._agentQueueRealItemAdded = true;
    if (!draft.vehicleOptions) draft.vehicleOptions = await listVehicles();
    const t = { date: dateStr };
    const matched = [];
    // Staged, NOT applied directly - same reasoning as transferName below (see that comment): a
    // guessed pickup/drop-off from ambient message text is still a guess about which real point was
    // meant, not a certainty, so it's confirmed (see nextTransferStepReply) before being locked in.
    const pickup = await tryResolvePoint(line.pickupHint);
    if (pickup) { t._pendingPickupPointConfirm = pickup; matched.push(`pickup: ${pickup.Name}`); }
    const dropoff = await tryResolvePoint(line.dropoffHint);
    if (dropoff) { t._pendingDropOffPointConfirm = dropoff; matched.push(`drop-off: ${dropoff.Name}`); }
    // Real transfer master records are named "<Destination> Airport to <Destination> Hotel"
    // (verified live against the DB, e.g. "Phuket Airport to Phuket Hotel") using the DESTINATION's
    // own full name, NOT necessarily whatever a specific Pickup record happens to be named - "HKT
    // Airport" (the real Pickup row) doesn't textually match "Phuket Airport to Phuket Hotel" at
    // all, even though it's the exact same place, because the trip's short code ("HKT") and the
    // catalog's naming convention (spelled-out destination name) don't line up. So the purely
    // destination-name-based guess is tried FIRST (highest confidence, matches the demonstrated
    // catalog pattern directly), before the resolved-Pickup-record combination, before the model's
    // own free-text guess. Tried in order; the first one that resolves to exactly one record wins.
    const lineText = `${line.pickupHint || ''} ${line.dropoffHint || ''} ${line.transferNameHint || ''}`;
    const lineDest = draft.resolvedDestinations.find((d) => {
      const t = lineText.toLowerCase();
      return t.includes(d.Name.toLowerCase()) || (d.ShortCode && t.includes(String(d.ShortCode).toLowerCase()));
    });
    const candidateQueries = [];
    if (lineDest) candidateQueries.push(`${lineDest.Name} Airport to ${lineDest.Name} Hotel`);
    // The catalog names its products with the generic "<Destination> Hotel" placeholder, not
    // whichever specific hotel a Pickup record happens to resolve to (see
    // guessDestinationHotelPlaceholder's own comment) - reproduced live: "Bangkok Hotel to DMK
    // Airport" is a real catalog record, but pickup resolved to the specific Pickup row "Happihaus
    // Bangkok Hotel", so the old specific-name-only candidate below ("Happihaus Bangkok Hotel to DMK
    // Airport") never matched it and the bot asked instead of auto-picking a record that was right
    // there. Tried for BOTH sides independently, not just when only one side failed to resolve to a
    // Pickup record at all - a resolved specific hotel is still worth trying as the generic
    // placeholder first, before falling back to its own specific name.
    const pickupDestPlaceholder = guessDestinationHotelPlaceholder(line.pickupHint, draft.resolvedDestinations);
    const dropoffDestPlaceholder = guessDestinationHotelPlaceholder(line.dropoffHint, draft.resolvedDestinations);
    const pickupSide = pickupDestPlaceholder || (pickup && pickup.Name);
    const dropoffSide = dropoffDestPlaceholder || (dropoff && dropoff.Name);
    if ((pickupDestPlaceholder || dropoffDestPlaceholder) && pickupSide && dropoffSide) {
      candidateQueries.push(`${pickupSide} to ${dropoffSide}`);
    }
    if (pickup && dropoff) candidateQueries.push(`${pickup.Name} to ${dropoff.Name}`);
    if (line.transferNameHint) candidateQueries.push(line.transferNameHint);
    if (line.pickupHint) candidateQueries.push(line.pickupHint);

    let particular = null;
    for (const q of candidateQueries) {
      particular = await tryResolveTransferParticular(q);
      if (particular) break;
    }
    // Staged, NOT applied directly - a same-worded match ("HKT airport to HKT hotel" -> "Phuket
    // Airport to Phuket Hotel") is a guess about which of several real transfer records was meant,
    // not a certainty, so it's confirmed (see nextTransferStepReply) before being locked in, instead
    // of silently applied with only a passing "(auto-matched)" mention nobody could act on.
    if (particular) t._pendingTransferNameConfirm = particular;

    draft.phase = 'transferCollect';
    draft.currentItemDraft = t;
    const matchedNote = matched.length > 0 ? ` (auto-matched ${matched.join(', ')})` : '';
    const stepReply = nextTransferStepReply(draft, t);
    if (!stepReply) {
      draft.phase = 'transferOptionalCollect';
      return { reply: `${prefix}${leisureNote}Day ${line.day} (${dateStr}) — transfer auto-matched${matchedNote}. Optional: number of vehicles, vehicle price, flight no, remarks. Reply with any of these, or "skip".`, draft };
    }
    return { reply: `${prefix}${leisureNote}Day ${line.day} (${dateStr}) — transfer from the message${matchedNote}. ${stepReply}`, draft };
  }

  if (line.type === 'sightseeing') {
    draft._agentQueueRealItemAdded = true;
    const weekday = weekdayNameFor(dateStr);
    const s = { date: dateStr };
    const matched = [];
    const particular = await tryResolveSightseeing(line.activityHint, weekday);
    if (particular) { s.sightseeingName = particular.Name; s._sightseeingNameRow = particular; matched.push(particular.Name); }

    draft.phase = 'sightseeingCollect';
    draft.currentItemDraft = s;
    const next = SIGHTSEEING_FIELD_ORDER.find((k) => s[k] === undefined || s[k] === null || s[k] === '');
    const matchedNote = matched.length > 0 ? ` (auto-matched: ${matched.join(', ')})` : '';
    if (!next) {
      draft.phase = 'sightseeingOptionalCollect';
      const adults = draft.fields.guestAdults || 0;
      const children = draft.fields.guestChildrens || 0;
      const paxNote = children > 0 ? `${adults} adult(s), ${children} child(ren)` : `${adults} adult(s)`;
      return { reply: `${prefix}${leisureNote}Day ${line.day} (${dateStr}) — sightseeing auto-matched${matchedNote}. Optional: a different adults/children count, remarks. Reply with any, or "skip" to save it for ${paxNote} — the trip's full group.`, draft };
    }
    draft.itemStep = next;
    return { reply: `${prefix}${leisureNote}Day ${line.day} (${dateStr}) — sightseeing from the message${matchedNote}. ${sightseeingStepPrompt(next)}`, draft };
  }

  // Only transfer/sightseeing/leisure are ever queued (see the filter in stepAgentPaste) - nothing
  // else should reach here, but fall through safely (continue the queue) rather than get stuck.
  return processAgentItineraryQueue(draft, prefix + leisureNote);
}

// Answers the "N more days left - continue, or is this enough?" pause above. Stopping here mirrors
// exactly what saying "done" does in the manual stepItineraryChoice flow - whatever's left in
// draft._agentItineraryQueue is simply never processed (whether it's build manually later, from
// this same message via "Edit and resend", or not at all is entirely up to the user from here).
async function stepAgentQueueContinue(draft, userMessage) {
  const yn = parseYesNo(userMessage);
  const wantsStop = yn === false || /\b(done|enough|stop|no more)\b/i.test(userMessage);
  if (wantsStop) {
    if (draft.editMode) return askConfirmItineraryEdit(draft);
    return askReturnDateConfirm(draft);
  }
  if (yn === true || /\bcontinue\b/i.test(userMessage)) {
    // Cleared just for this one re-entry, so processAgentItineraryQueue's own pause check (right
    // above the leisure-batch loop) doesn't immediately re-trigger on the item this "continue" is
    // FOR - it gets set again once (and only once) that next real item is actually dequeued below.
    draft._agentQueueRealItemAdded = false;
    return processAgentItineraryQueue(draft, '');
  }
  return { reply: 'Reply "continue" to keep adding the rest of the itinerary, or "done" if this is enough.', draft };
}

async function stepBasic(draft, userMessage) {
  if (!draft.destinationOptions) draft.destinationOptions = await listDestinations();

  // The very first call is triggered by the "create a booking" message itself (e.g. "create a
  // new booking") - that isn't an answer to anything, so just ask the first question.
  if (!draft.basicStarted) {
    draft.basicStarted = true;
    draft.basicCurrentStep = 'guestName';
    // The exit is advertised up front - a user who lands in this flow by accident shouldn't have to
    // guess that there is a way out of it.
    return { reply: `Let's create a new ${draft.kind}. ${basicStepPrompt('guestName', draft)}\n\n_(You can say **cancel** at any point to stop.)_`, draft };
  }

  if (/^(cancel|stop|start over|nevermind|never mind)\b/i.test(userMessage.trim())) {
    return { reply: `Okay, cancelled the new ${draft.kind}. Let me know if you'd like to start again.`, draft: null };
  }

  const current = draft.basicCurrentStep;
  const answer = userMessage.trim();

  switch (current) {
    case 'guestName':
      draft.fields.guestName = answer;
      break;

    case 'guestPhoneNumber': {
      const phone = /^same$/i.test(answer) && draft.resolvedAgent && draft.resolvedAgent.Phone ? draft.resolvedAgent.Phone : answer;
      if (!PHONE_RE.test(phone)) {
        return { reply: 'That doesn\'t look like a valid phone number — please enter digits only (e.g. 9825096999), no spaces or other characters.', draft };
      }
      draft.fields.guestPhoneNumber = phone;
      break;
    }

    case 'guestEmail': {
      const email = /^same$/i.test(answer) && draft.resolvedAgent && draft.resolvedAgent.Email ? draft.resolvedAgent.Email : answer;
      if (!EMAIL_RE.test(email)) {
        return { reply: "That doesn't look like a valid email address — could you re-enter it?", draft };
      }
      draft.fields.guestEmail = email;
      break;
    }

    // The agent named in a pasted message (see agentNameStepPrompt), staged for a yes/change
    // confirm rather than applied outright - same pattern as hotelCollect's own 'hotelPrefConfirm'.
    case 'agentNameConfirm': {
      const yn = parseYesNo(answer);
      if (yn === true) {
        draft.resolvedAgent = draft._pendingAgentMatch;
        draft.fields.agentName = draft._pendingAgentMatch.Name;
        delete draft._pendingAgentMatch;
        break;
      }
      if (yn === false || /change|different|edit|select/i.test(answer)) {
        delete draft._pendingAgentMatch;
        draft.basicCurrentStep = 'agentName';
        return { reply: basicStepPrompt('agentName', draft), draft };
      }
      return { reply: `Is **${draft._pendingAgentMatch.Name}** the right agent? Reply "yes" to keep it, or "change" to pick a different one.`, draft };
    }

    case 'agentName': {
      const agents = await findAgent(answer);
      // findAgent tries an exact (case-insensitive) name match first and only falls back to a fuzzy
      // substring search if that comes up empty - so a single result here is always a genuine
      // resolution, never a fuzzy coincidence. Several results only ever come from that fuzzy
      // fallback (e.g. typing "sa" fuzzy-matches "Om Sai Tour", "Sacred Holidays", "Saavi Tourism"...)
      // - those exist for browsing via the live dropdown above the input (clicking one there resends
      // its exact Name, which resolves through the branch below), not a reason to block creating a
      // new agent literally named what was typed. Mirrors the Send-button's own "Create" rule in
      // app.js, which likewise only disables for an exact match, not a fuzzy one.
      if (agents.length === 1) {
        draft.resolvedAgent = agents[0];
        draft.fields.agentName = agents[0].Name;
        break;
      }

      // No exact match - collect the new agent's own phone/email before creating it (mirrors the
      // real Agent master form's own required fields), then offer to reuse them for the guest too,
      // instead of creating it blank outright. Fuzzy substring matches (e.g. typing "sa" matching
      // "Om Sai Tour", "Sacred Holidays", ...) don't block this - those exist for browsing via the
      // live dropdown above the input, not a reason to stop creating a new agent literally named
      // what was typed.
      draft._pendingNewAgentName = answer;
      draft.phase = 'agentCreate';
      draft.agentCreateStep = 'phone';
      return { reply: `No agent/company named "${answer}" exists yet — let's create it. What is this agent's phone number?`, draft };
    }

    case 'destinationNames': {
      const destNames = answer.split(/,| and | & /i).map((s) => s.trim()).filter(Boolean);
      const { matches, notFound } = await findDestinations(destNames);
      const ambiguous = matches.filter((m) => m.ambiguous);
      if (notFound.length > 0) {
        return { reply: `I couldn't find a destination matching: ${notFound.join(', ')}. Available: ${draft.destinationOptions.map(formatDest).join(', ')}. Could you try again?`, draft };
      }
      if (ambiguous.length > 0) {
        const opts = ambiguous.map((a) => `"${a.name}" could be: ${a.options.map((o) => o.Name).join(', ')}`).join('\n');
        return { reply: `A couple of destinations are ambiguous:\n${opts}\nCould you be more specific?`, draft };
      }
      draft.resolvedDestinations = matches;
      draft.fields.destinationNames = matches.map((m) => m.Name);
      break;
    }

    case 'travelDate': {
      const travelDateObj = parseDateDDMMYYYY(answer);
      if (!travelDateObj) {
        return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
      }
      if (travelDateObj < todayDateObjIST()) {
        return { reply: `Travel date can't be in the past — could you re-enter it?`, draft };
      }
      draft.fields.travelDate = answer;
      break;
    }

    case 'returnDate': {
      const returnDateObj = parseDateDDMMYYYY(answer);
      if (!returnDateObj) {
        return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
      }
      const travelDateObj = parseDateDDMMYYYY(draft.fields.travelDate);
      if (returnDateObj <= travelDateObj) {
        return { reply: `Return date must be later than the travel date (${draft.fields.travelDate}) — could you re-enter it?`, draft };
      }
      draft.fields.returnDate = answer;
      break;
    }

    case 'travelCount': {
      if (!/^skip$/i.test(answer)) {
        const adultsMatch = answer.match(/(\d+)\s*adult/i);
        const childrenMatch = answer.match(/(\d+)\s*child/i);
        const infantsMatch = answer.match(/(\d+)\s*infant/i);
        const bareNumber = answer.match(/^\d+$/);
        if (adultsMatch) draft.fields.guestAdults = Number(adultsMatch[1]);
        else if (bareNumber) draft.fields.guestAdults = Number(bareNumber[0]);
        if (childrenMatch) draft.fields.guestChildrens = Number(childrenMatch[1]);
        if (infantsMatch) draft.fields.guestInfants = Number(infantsMatch[1]);
      }
      break;
    }

    default:
      break;
  }

  const next = nextBasicStep(draft);
  if (next === 'agentName') return { reply: await agentNameStepPrompt(draft), draft };
  if (next) {
    draft.basicCurrentStep = next;
    return { reply: basicStepPrompt(next, draft), draft };
  }

  // See basicNextPrompt's identical check above (reached from the OTHER entry point into this same
  // end-of-basic-phase transition) - manual entry only, asks return date directly right after travel
  // date rather than deriving it from the itinerary later.
  if (draft.viaManualEntry && !draft.fields.returnDate) {
    draft.basicCurrentStep = 'returnDate';
    return { reply: 'What is the return date? (format DD-MM-YYYY)', draft };
  }

  if (!draft.basicPaxAsked) {
    draft.basicPaxAsked = true;
    draft.basicCurrentStep = 'travelCount';
    return { reply: 'How many Adults/Children/Infants are travelling? e.g. "4 adults, 1 child" (optional — reply "skip" to leave this for now)', draft };
  }

  // See basicNextPrompt's identical check above (reached from the OTHER entry point into this same
  // end-of-basic-phase transition - this is stepBasic's own per-answer path).
  if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
    return askReturnDateConfirm(draft, 'hotelChoice');
  }

  draft.phase = 'hotelChoice';
  return {
    reply: `Got the basic details for **${draft.fields.guestName}**. Now — is the hotel self-booked (guest arranging their own), or would you like to add hotel details? (reply "self-booked" or "add hotel")`,
    draft,
  };
}

// ---------- phase: agentCreate (typing an agent name with no existing match, per stepBasic's
// 'agentName' case, lands here) ----------
// Collects the new agent/company's own phone + email + address (mirroring the real Agent master
// form's own fields - address is the one optional/skippable one, phone and email are validated the
// same as the guest's own) before actually creating it via the real API, then offers to copy the
// phone/email straight onto the guest/passenger - a single explicit yes/no instead of relying on
// the per-field "reply same" shortcut quickRepliesFor already offers once draft.resolvedAgent has a
// Phone/Email (that shortcut still works too if this gate is answered "no" and the guest steps are
// reached normally below).
async function stepAgentCreate(draft, userMessage) {
  const answer = userMessage.trim();

  if (draft.agentCreateStep === 'phone') {
    if (!PHONE_RE.test(answer)) {
      return { reply: 'That doesn\'t look like a valid phone number — please enter digits only (e.g. 9825096999), no spaces or other characters.', draft };
    }
    draft._pendingNewAgentPhone = answer;
    draft.agentCreateStep = 'email';
    return { reply: "What is this agent's email address?", draft };
  }

  if (draft.agentCreateStep === 'email') {
    if (!EMAIL_RE.test(answer)) {
      return { reply: "That doesn't look like a valid email address — could you re-enter it?", draft };
    }
    draft._pendingNewAgentEmail = answer;
    draft.agentCreateStep = 'address';
    return { reply: 'What is this agent\'s address? (optional — reply "skip" to leave it blank)', draft };
  }

  if (draft.agentCreateStep === 'address') {
    const address = /^skip$/i.test(answer) ? '' : answer;

    const name = draft._pendingNewAgentName;
    const phone = draft._pendingNewAgentPhone;
    const email = draft._pendingNewAgentEmail;
    let outcome;
    try {
      outcome = await createAgent({ name, phone, email, address });
    } catch (e) {
      return { reply: `Couldn't create a new agent for "${name}" (${e.message}). Please try again or check the spelling.`, draft };
    }
    const rechecked = await findAgent(name);
    const created = rechecked.find((a) => a.Name.toLowerCase() === name.toLowerCase()) || rechecked[0];
    if (!created) {
      return { reply: `Something went wrong creating "${name}" — could you try again?`, draft };
    }
    draft.resolvedAgent = created;
    draft.fields.agentName = created.Name;
    delete draft._pendingNewAgentName;
    delete draft._pendingNewAgentPhone;
    delete draft._pendingNewAgentEmail;

    // outcome === 'duplicate' means the API's own case-insensitive exact-name check found a match
    // our own lookup missed (a genuine race - two people creating the same agent at once) - the
    // re-fetch above still lands on the real existing record either way, so both branches end up
    // with a correct draft.resolvedAgent; only the message (and whose phone/email get offered next)
    // differs.
    const notice =
      outcome === 'duplicate'
        ? `"${name}" already exists as an agent/company — using the existing record (${created.Phone || 'no phone'}${created.Email ? `, ${created.Email}` : ''}).`
        : `Created a new agent/company: **${created.Name}** (${created.Phone}, ${created.Email}).`;

    // A pre-existing record hit via the 'duplicate' race can have no phone/email on file - nothing
    // to offer copying onto the guest in that case, so skip straight past the gate instead of
    // asking "same as X" about a blank value.
    if (!created.Phone || !created.Email) {
      delete draft.agentCreateStep;
      draft.phase = 'basic';
      return { reply: `${notice}\n\n${await basicNextPrompt(draft)}`, draft };
    }

    draft.agentCreateStep = 'sameAsGuest';
    return { reply: `${notice}\n\nUse the same phone number and email for the guest/passenger too? (yes/no)`, draft };
  }

  // agentCreateStep === 'sameAsGuest'
  const yn = parseYesNo(answer);
  if (yn === null) {
    return { reply: 'Reply "yes" to use the same phone/email for the guest, or "no" to enter the guest\'s own details.', draft };
  }
  if (yn === true) {
    draft.fields.guestPhoneNumber = draft.resolvedAgent.Phone;
    draft.fields.guestEmail = draft.resolvedAgent.Email;
  }
  delete draft.agentCreateStep;
  draft.phase = 'basic';
  return { reply: await basicNextPrompt(draft), draft };
}

// ---------- phase: hotel (fully deterministic - one field at a time, same reasoning as Basic) ----------

async function stepHotelChoice(draft, userMessage) {
  const wantsAdd = /\b(add|hotel details|book)\b/i.test(userMessage) && !/self.?book/i.test(userMessage);
  const selfBooked = parseYesNo(userMessage) === false || /self.?book/i.test(userMessage);

  if (selfBooked && !wantsAdd) {
    draft.hotelSelfBooked = true;
    return processAgentItineraryQueue(draft, '');
  }
  if (wantsAdd || parseYesNo(userMessage) === true) {
    draft.hotelSelfBooked = false;
    draft.phase = 'hotelCollect';
    return { reply: await startHotelCollect(draft), draft };
  }
  return { reply: 'Sorry, could you clarify — reply "self-booked" or "add hotel"?', draft };
}

const HOTEL_FIELD_ORDER = ['destinationName', 'hotelName', 'checkInDate', 'checkOutDate', 'roomCategory', 'totalRooms', 'ratePerNight'];

function hotelStepPrompt(stepKey, draft) {
  switch (stepKey) {
    case 'destinationName':
      return `Which destination is this hotel for? Available: ${draft.resolvedDestinations.map(formatDest).join(', ')}`;
    case 'hotelName':
      return "What is the hotel's name?";
    case 'checkInDate':
      return 'What is the check-in date? (DD-MM-YYYY)';
    case 'checkOutDate':
      return 'What is the check-out date? (DD-MM-YYYY)';
    case 'roomCategory':
      return 'What is the room category? (e.g. "Superior Room Sin/Dou")';
    case 'totalRooms':
      return 'How many rooms?';
    case 'ratePerNight': {
      const h = draft.currentHotelDraft;
      if (h && h._roomTypeRate != null) {
        return `What is the rate per night? (reply "same" to use this room type's own rate: ${h._roomTypeRate} ${h._roomTypeCurrency || draft.fields.currency || 'THB'})`;
      }
      return `What is the rate per night? (just the number - currency defaults to ${draft.fields.currency || 'THB'})`;
    }
    default:
      return '';
  }
}

// Starts (or restarts, for a second/third hotel) collection of one hotel row. If the trip only
// has one destination there's nothing to choose, so "which destination is this hotel for?" is
// skipped entirely and that destination is used directly - only trips with several destinations
// still ask, via a single-select dropdown scoped to just this trip's own destinations.
async function startHotelCollect(draft) {
  draft.currentHotelDraft = {};
  const h = draft.currentHotelDraft;
  if (draft.resolvedDestinations.length === 1) {
    const dest = draft.resolvedDestinations[0];
    h.destinationName = dest.Name;
    h._destId = dest.Id;
    // Travel-agent-sourced draft only (see stageHotelPreference) - no-op for a manual one.
    const resolved = await stageHotelPreference(draft, h);
    if (resolved) {
      draft.hotelStep = 'hotelPrefConfirm';
      return `The message mentions **${resolved.hotelName}** for ${h.destinationName} — is that correct, or would you like to change it?`;
    }
    draft.hotelStep = 'hotelName';
    return hotelStepPrompt('hotelName', draft);
  }
  draft.hotelStep = 'destinationName';
  return hotelStepPrompt('destinationName', draft);
}

async function stepHotelCollect(draft, userMessage) {
  const h = draft.currentHotelDraft;
  const answer = userMessage.trim();

  if (isCancelItemIntent(answer)) {
    draft.currentHotelDraft = null;
    if (draft.hotels.length > 0) {
      return processAgentItineraryQueue(draft, 'Okay, not adding this hotel. ');
    }
    draft.phase = 'hotelChoice';
    return { reply: `Okay, not adding this hotel. Is the hotel self-booked (guest arranging their own), or would you like to add hotel details? (reply "self-booked" or "add hotel")`, draft };
  }

  // Resolve a pending "which hotel did you mean?" question from the previous turn first - like
  // the Agent field's live-search dropdown on the real form, show real matches instead of
  // silently accepting whatever the user typed.
  if (h._hotelNameOptions) {
    const picked = h._hotelNameOptions.find((o) => o.Name.toLowerCase() === answer.toLowerCase());
    if (picked) {
      h.hotelName = picked.Name;
      h._resolvedHotelId = picked.Id;
    } else if (/^new\b/i.test(answer)) {
      h._resolvedHotelId = 0;
    } else {
      const opts = h._hotelNameOptions.map((o) => `- ${o.Name}`).join('\n');
      return { reply: `Please reply with the exact hotel name from the list, or "new" to add "${h.hotelName}" as a new entry:\n${opts}`, draft };
    }
    delete h._hotelNameOptions;
  } else {
    switch (draft.hotelStep) {
      case 'destinationName': {
        const destQuery = answer.toLowerCase();
        const dest = draft.resolvedDestinations.find(
          (d) => d.Name.toLowerCase() === destQuery || (d.ShortCode && d.ShortCode.toLowerCase() === destQuery)
        );
        if (!dest) {
          return { reply: `"${answer}" isn't one of this trip's destinations (${draft.resolvedDestinations.map(formatDest).join(', ')}). Which one is this hotel for?`, draft };
        }
        h.destinationName = dest.Name;
        h._destId = dest.Id;
        // Multi-destination trip - the single-destination case is handled in startHotelCollect;
        // this covers the same "does the agent's message name a hotel for this destination"
        // check once the destination question (only asked when there's more than one) is answered.
        // No-op for a manual draft (see stageHotelPreference).
        const resolved = await stageHotelPreference(draft, h);
        if (resolved) {
          draft.hotelStep = 'hotelPrefConfirm';
          return { reply: `The message mentions **${resolved.hotelName}** for ${h.destinationName} — is that correct, or would you like to change it?`, draft };
        }
        break;
      }
      case 'hotelPrefConfirm': {
        const yn = parseYesNo(answer);
        if (yn === true) {
          h.hotelName = h._pendingHotelPrefName;
          h._resolvedHotelId = h._pendingHotelPrefId;
          delete h._pendingHotelPrefName;
          delete h._pendingHotelPrefId;
          break;
        }
        if (yn === false || /change|different|edit/i.test(answer)) {
          delete h._pendingHotelPrefName;
          delete h._pendingHotelPrefId;
          draft.hotelStep = 'hotelName';
          return { reply: hotelStepPrompt('hotelName', draft), draft };
        }
        return { reply: `Is **${h._pendingHotelPrefName}** the right hotel for ${h.destinationName}? Reply "yes" to keep it, or "change" to pick a different one.`, draft };
      }
      case 'hotelName': {
        const found = await findHotel(answer);
        if (found.length > 1) {
          h._hotelNameOptions = found;
          h.hotelName = answer;
          const opts = found.map((o) => `- ${o.Name}`).join('\n');
          return { reply: `A few hotels match "${answer}":\n${opts}\nWhich one did you mean? (or reply "new" to add "${answer}" as a new hotel entry)`, draft };
        }
        h.hotelName = found.length === 1 ? found[0].Name : answer;
        h._resolvedHotelId = found.length === 1 ? found[0].Id : 0;
        break;
      }
      case 'checkInDate': {
        // Same trip-range check as itinerary items (see validateItineraryItemDate) - this field
        // previously only checked "is this a real calendar date", so a check-in before the trip's
        // travel date (or even in the past) was silently accepted.
        const err = validateItineraryItemDate(answer, draft);
        if (err) return { reply: err, draft };
        h.checkInDate = answer;
        break;
      }
      case 'checkOutDate': {
        const checkOut = parseDateDDMMYYYY(answer);
        if (!checkOut) {
          return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
        }
        if (checkOut <= parseDateDDMMYYYY(h.checkInDate)) {
          return { reply: 'Check-out date must be after check-in date — could you re-enter it?', draft };
        }
        const returnDate = parseDateDDMMYYYY(draft.fields.returnDate);
        if (returnDate && checkOut > returnDate) {
          return { reply: `Check-out date can't be after the trip's return date (${draft.fields.returnDate}) — could you re-enter it?`, draft };
        }
        h.checkOutDate = answer;
        break;
      }
      case 'roomCategory': {
        h.roomCategory = answer;
        // Not a strict lookup - roomCategory stays free text either way (BookingHotel.RoomCategory
        // has no FK) - this only captures the rate/currency for the "same" shortcut below, when the
        // typed/picked name happens to match one of this hotel's own registered room types exactly.
        const roomType = h._resolvedHotelId ? await findHotelRoomType(h._resolvedHotelId, answer) : null;
        if (roomType) {
          h._roomTypeRate = roomType.RatePerNight;
          h._roomTypeCurrency = roomType.Currency;
        }
        break;
      }
      case 'totalRooms': {
        if (!WHOLE_NUMBER_RE.test(answer.trim())) {
          return { reply: 'That needs to be digits only, no other text — how many rooms?', draft };
        }
        const n = parseInt(answer, 10);
        if (n <= 0) return { reply: 'That needs to be a whole number greater than 0 — how many rooms?', draft };
        h.totalRooms = n;
        break;
      }
      case 'ratePerNight': {
        if (/^same$/i.test(answer) && h._roomTypeRate != null) {
          h.ratePerNight = Number(h._roomTypeRate);
          break;
        }
        if (!DECIMAL_NUMBER_RE.test(answer.trim())) {
          return { reply: 'That needs to be digits only, no currency symbol or other text — what is the rate per night?', draft };
        }
        h.ratePerNight = parseFloat(answer);
        break;
      }
      default:
        break;
    }
  }

  const next = HOTEL_FIELD_ORDER.find((k) => h[k] === undefined || h[k] === null || h[k] === '');
  if (next) {
    draft.hotelStep = next;
    return { reply: hotelStepPrompt(next, draft), draft };
  }

  draft.phase = 'hotelOptionalCollect';
  {
    // Same "default to the booking's own total pax" rule as sightseeing/restaurant (see
    // finishSightseeingItem/finishRestaurantItem) - totalAdults below already defaulted from
    // draft.fields.guestAdults when unset, this just makes that default visible/confirmable
    // instead of a silent guess.
    const adults = draft.fields.guestAdults || 0;
    const children = draft.fields.guestChildrens || 0;
    const paxNote = children > 0 ? `${adults} adult(s), ${children} child(ren)` : `${adults} adult(s)`;
    return {
      reply: `Optional for this hotel: breakfast option, a different adults/children/infants count, currency (default THB), address/contact/email/remarks, sharing type. Reply with any of these, or "skip" to save it for ${paxNote} — the trip's full group.`,
      draft,
    };
  }
}

function hotelOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a hotel booking row.
Possible fields: breakfast, adults (number), children (number), infants (number), currency (e.g. "THB"), hotelAddress, hotelContact, hotelEmail, roomRemarks, sharingType (e.g. "double sharing"/"triple sharing"/"single sharing").
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
}

async function stepHotelOptionalCollect(draft, userMessage) {
  const h = draft.currentHotelDraft;
  const answer = userMessage.trim();
  if (!/^skip$/i.test(answer)) {
    try {
      const parsed = await extractFields(hotelOptionalSystemPrompt(h), answer);
      Object.assign(h, stripEchoedFields(parsed.fields));
    } catch (e) {
      // optional - ignore parse failures
    }
  }

  const dest = draft.resolvedDestinations.find((d) => d.Id === h._destId);
  const checkIn = parseDateDDMMYYYY(h.checkInDate);
  const checkOut = parseDateDDMMYYYY(h.checkOutDate);
  const totalNights = Math.round((checkOut - checkIn) / 86400000);
  const sharingMap = {
    double: 'Per Adult cost on Double sharing',
    triple: 'Per Adult cost on Triple sharing',
    single: 'Per Adult cost on Single sharing',
  };
  const sharingKey = h.sharingType ? Object.keys(sharingMap).find((k) => String(h.sharingType).toLowerCase().includes(k)) : null;

  draft.hotels.push({
    id: 0,
    destinationId: dest.Id,
    hotelId: h._resolvedHotelId || 0,
    name: h.hotelName,
    roomCategory: h.roomCategory,
    totalRooms: Number(h.totalRooms) || 1,
    totalNights,
    checkInDate: h.checkInDate,
    checkOutDate: h.checkOutDate,
    roomRemarks: h.roomRemarks || '',
    address: h.hotelAddress || '',
    contact: h.hotelContact || '',
    Email: h.hotelEmail || '',
    ratePerNight: Number(h.ratePerNight) || 0,
    ratePerNightCurrency: h.currency || draft.fields.currency || 'THB',
    totalAdults: String(h.adults != null ? h.adults : draft.fields.guestAdults || 0),
    children: h.children != null ? Number(h.children) : Number(draft.fields.guestChildrens) || 0,
    infants: h.infants != null ? Number(h.infants) : Number(draft.fields.guestInfants) || 0,
    Destinationname: dest.Name,
    selfBooked: false,
    confirmationId: '',
    attributes: [],
    adultCostType: sharingKey ? sharingMap[sharingKey] : '',
    childCostType: '',
    breakfast: h.breakfast || '',
  });

  draft.currentHotelDraft = null;
  draft.phase = 'hotelAddAnother';
  return { reply: `Added **${h.hotelName}** (${h.roomCategory}, ${totalNights} night(s)). Add another hotel? (yes/no)`, draft };
}

async function stepHotelAddAnother(draft, userMessage) {
  const yn = parseYesNo(userMessage);
  if (yn === true) {
    draft.phase = 'hotelCollect';
    return { reply: await startHotelCollect(draft), draft };
  }
  // An unrecognized reply (typo, "yeah", etc.) previously fell through as a silent "no", skipping
  // straight past adding the hotel the user actually meant to add with no way back except
  // cancelling and redoing the whole booking - now it re-asks instead, matching every other
  // yes/no gate in this file.
  if (yn !== false) {
    return { reply: `Sorry, I didn't catch that. Add another hotel? (yes/no)`, draft };
  }
  return processAgentItineraryQueue(draft, '');
}

// ---------- phase: itinerary (transfer + restaurant only, fully deterministic) ----------

function askItineraryChoice() {
  return `Now the itinerary — the real form requires at least one item. Would you like to add a **Transfer** (e.g. airport pickup/drop), **Sightseeing**, a **Restaurant**, or mark it a **Leisure Day**?`;
}

async function stepItineraryChoice(draft, userMessage) {
  const t = userMessage.toLowerCase();
  if (/transfer/i.test(t)) {
    draft.phase = 'transferCollect';
    draft.currentItemDraft = {};
    draft.itemStep = 'date';
    if (!draft.vehicleOptions) draft.vehicleOptions = await listVehicles();
    return { reply: transferStepPrompt('date', draft), draft };
  }
  if (/sight ?see/i.test(t)) {
    draft.phase = 'sightseeingCollect';
    draft.currentItemDraft = {};
    draft.itemStep = 'date';
    return { reply: sightseeingStepPrompt('date'), draft };
  }
  if (/restaurant/i.test(t)) {
    draft.phase = 'restaurantCollect';
    draft.currentItemDraft = {};
    draft.itemStep = 'date';
    return { reply: restaurantStepPrompt('date'), draft };
  }
  if (/leisure/i.test(t)) {
    draft.phase = 'leisureDayCollect';
    // Unused by stepLeisureDayCollect itself - set only so itemLevelCancelApplies() treats a bare
    // "cancel" here as "don't add this leisure day" rather than wiping the whole booking, matching
    // every other single-item collection phase (transfer/sightseeing/restaurant/hotel).
    draft.currentItemDraft = {};
    return { reply: 'Which date is this a Leisure Day? (DD-MM-YYYY)', draft };
  }
  if (draft.itineraryItems.length > 0 && (parseYesNo(userMessage) === false || /done|no more/i.test(t))) {
    if (draft.editMode) return askConfirmItineraryEdit(draft);
    return askReturnDateConfirm(draft);
  }
  return {
    reply: `The real form needs at least one itinerary item. Please reply "transfer", "sightseeing", "restaurant", or "leisure".`,
    draft,
  };
}

// ---------- phase: returnDateConfirm (suggest a return date from the itinerary just built, confirm
// or let it be changed) ----------
// Asking for the return date up front (before any itinerary item exists) meant it could only ever
// be validated against a MINIMUM day count from a pasted agent message's "Day N:" lines
// (maxItineraryDay/_agentItineraryQueue) - a manually-built itinerary (the common case) had nothing
// to check against at all. Now that the itinerary is already built by the time this runs,
// maxItineraryItemDay reads its REAL last day directly, so the return date is suggested outright
// (travelDate + last itinerary day - 1) instead of asked blind - the user just confirms it's right
// or picks a different one via the same calendar every other trip date uses.
// Where to resume once the return date is settled (confirmed as suggested, entered manually, or
// already known and never even asked about - see below): 'hotelChoice' when called EARLY, right as
// the basic details finish, for an agent-pasted itinerary that already states its own trip length
// (see basicNextPrompt/stepBasic's own hook) - hotel/itinerary collection hasn't started yet at that
// point. 'priceCollect' (the default) when called LATE, the original case - itinerary collection
// (manual or the agent auto-queue) has just finished. Stashed on the draft, not just a parameter,
// since stepReturnDateConfirm/finishReturnDateEntry resume this later from the user's own next
// message and don't receive this argument directly.
function proceedAfterReturnDate(draft) {
  const nextPhase = draft._returnDateConfirmNextPhase || 'priceCollect';
  delete draft._returnDateConfirmNextPhase;
  if (nextPhase === 'hotelChoice') {
    draft.phase = 'hotelChoice';
    return {
      reply: `Got the basic details for **${draft.fields.guestName}**. Now — is the hotel self-booked (guest arranging their own), or would you like to add hotel details? (reply "self-booked" or "add hotel")`,
      draft,
    };
  }
  draft.phase = 'priceCollect';
  return { reply: askAddMembers(), draft };
}

function askReturnDateConfirm(draft, nextPhase = 'priceCollect') {
  draft._returnDateConfirmNextPhase = nextPhase;
  // Already decided - either explicitly stated in a pasted message ("Return Date: ...", extracted
  // verbatim - a stated fact, not a guess, so there's nothing to confirm) or already confirmed
  // earlier in this same draft (the early hook above, once hotel/itinerary collection reaches this
  // same "itinerary is done" point later via stepAgentQueueContinue's "done"/stepItineraryChoice's
  // "done", which still call this function unconditionally) - don't re-ask, just move straight on.
  if (draft.fields.returnDate) {
    return proceedAfterReturnDate(draft);
  }
  const travelDateObj = parseDateDDMMYYYY(draft.fields.travelDate);
  const maxDay = maxKnownItineraryDay(draft);
  if (!travelDateObj || !maxDay) {
    // No dated itinerary item to infer from (shouldn't normally happen - the itinerary phase
    // requires at least one item - but fall back to asking outright rather than guessing wrong).
    draft.phase = 'returnDateConfirm';
    draft.returnDateConfirmStep = 'entering';
    return { reply: 'What is the return date? (format DD-MM-YYYY)', draft };
  }
  const suggestedStr = formatDateObjDDMMYYYY(addDaysToDateObj(travelDateObj, maxDay - 1));
  draft.fields.returnDate = suggestedStr;
  draft.phase = 'returnDateConfirm';
  draft.returnDateConfirmStep = 'confirm';
  return {
    reply: `Based on the itinerary (through Day ${maxDay}), the return date should be **${suggestedStr}** — is that correct, or would you like to change it?`,
    draft,
  };
}

async function stepReturnDateConfirm(draft, userMessage) {
  if (draft.returnDateConfirmStep === 'entering') {
    return finishReturnDateEntry(draft, userMessage);
  }
  const yn = parseYesNo(userMessage);
  if (yn === true) {
    return proceedAfterReturnDate(draft);
  }
  if (yn === false || /change|edit|different|wrong|update/i.test(userMessage)) {
    draft.returnDateConfirmStep = 'entering';
    return { reply: 'What should the return date be instead? (format DD-MM-YYYY)', draft };
  }
  return { reply: `Is **${draft.fields.returnDate}** the right return date? Reply "yes" to keep it, or "change" to pick a different one.`, draft };
}

function finishReturnDateEntry(draft, answer) {
  const returnDateObj = parseDateDDMMYYYY(answer);
  if (!returnDateObj) {
    return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
  }
  const travelDateObj = parseDateDDMMYYYY(draft.fields.travelDate);
  if (returnDateObj <= travelDateObj) {
    return { reply: `Return date must be later than the travel date (${draft.fields.travelDate}) — could you re-enter it?`, draft };
  }
  const maxDay = maxKnownItineraryDay(draft);
  if (maxDay) {
    const minReturnObj = addDaysToDateObj(travelDateObj, maxDay - 1);
    if (returnDateObj < minReturnObj) {
      return { reply: `The itinerary runs through Day ${maxDay}, so the return date can't be before ${formatDateObjDDMMYYYY(minReturnObj)} — could you re-enter it?`, draft };
    }
  }
  draft.fields.returnDate = answer;
  return proceedAfterReturnDate(draft);
}

// Asked right after an item's date is captured (transfer/sightseeing only - the two types with a
// pickup point), as a per-day alternative to the old whole-itinerary "self-booked" shortcut that
// used to sit on the initial askItineraryChoice() fork. Lets the guest's own itinerary be a mix of
// real items and self-arranged days instead of an all-or-nothing choice.
function askItemSelfBookedGate() {
  return `Is this self-booked (guest arranging their own), or would you like to add the pickup point details?`;
}

// Same shape as a real transfer item (see finishTransferItem) with pickup/dropoff/vehicle left
// blank - mirrors the proven-correct self-booked shape the Leisure Day flow already sends.
function finishSelfBookedTransferItem(draft) {
  const t = draft.currentItemDraft;
  draft.itineraryItems.push({
    type: 'transfer',
    id: '',
    dayNumber: computeDayNumber(t.date, draft.fields.travelDate),
    date: t.date,
    time: '',
    pickupPointId: '',
    pickupPointName: '',
    dropOffPointId: '',
    dropOffPointName: '',
    particularId: '',
    transferCode: '',
    transferName: '',
    vehicleId: '',
    vehicleName: '',
    vehicleCount: '0',
    vehiclePrice: '0',
    vehiclePriceCurrency: draft.fields.currency || 'THB',
    currency: draft.fields.currency || 'THB',
    capacity: '',
    remarks: '',
    flightNo: '',
    selfBooked: true,
    finalPrice: 0,
    costPerAdult: 0,
    costPerChild: 0,
    costPerInfant: 0,
    totalAdult: String(draft.fields.guestAdults || 0),
    totalChild: String(draft.fields.guestChildrens || 0),
    totalInfant: String(draft.fields.guestInfants || 0),
  });

  draft.currentItemDraft = null;
  const addedMsg = `Added a self-booked day for ${t.date}. `;
  if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
    return processAgentItineraryQueue(draft, addedMsg);
  }
  draft.phase = 'itineraryChoice';
  return { reply: `${addedMsg}${askAddMoreItinerary()}`, draft };
}

async function stepTransferSelfBookedGate(draft, userMessage) {
  const answer = userMessage.trim();
  if (isCancelItemIntent(answer)) {
    draft.currentItemDraft = null;
    if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
      return processAgentItineraryQueue(draft, 'Okay, not adding this transfer. ');
    }
    draft.phase = 'itineraryChoice';
    return { reply: `Okay, not adding this transfer. ${askItineraryChoice()}`, draft };
  }
  const wantsAdd = /\b(add|pickup|detail)\b/i.test(answer) && !/self.?book/i.test(answer);
  const selfBooked = parseYesNo(answer) === false || /self.?book/i.test(answer);
  if (selfBooked && !wantsAdd) return finishSelfBookedTransferItem(draft);
  if (wantsAdd || parseYesNo(answer) === true) {
    draft.phase = 'transferCollect';
    // Whichever field is next per TRANSFER_FIELD_ORDER (time, if not already answered before this
    // gate; pickupPointName otherwise) - not hardcoded, so a required field added to that order
    // (e.g. 'time') is never silently skipped here.
    const stepReply = nextTransferStepReply(draft, draft.currentItemDraft);
    return { reply: stepReply, draft };
  }
  return { reply: `Sorry, could you clarify — reply "self-booked" or "add pickup point details"?`, draft };
}

// Same shape as a real sightseeing item (see finishSightseeingItem) with time/pickup/particular
// left blank - identical to what a Leisure Day already sends (see finishLeisureDay-equivalent push
// in stepLeisureDayCollect below), since a self-booked sightseeing day and a Leisure Day are the
// same record shape on the real site.
function finishSelfBookedSightseeingItem(draft) {
  const s = draft.currentItemDraft;
  draft.itineraryItems.push({
    type: 'sightseeing',
    id: '',
    dayNumber: computeDayNumber(s.date, draft.fields.travelDate),
    date: s.date,
    time: '',
    pickupPointId: '',
    pickupPointName: '',
    particularId: '',
    transferName: '',
    transferCode: '',
    totalAdult: '0',
    adultPrice: '0',
    totalChild: '0',
    childPrice: '0',
    currency: draft.fields.currency || 'THB',
    remarks: '',
    selfBooked: true,
    finalPrice: 0,
    costPerAdult: 0,
    costPerChild: 0,
    costPerInfant: 0,
    totalInfant: String(draft.fields.guestInfants || 0),
    flightNo: null,
  });

  draft.currentItemDraft = null;
  const addedMsg = `Added a self-booked day for ${s.date}. `;
  if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
    return processAgentItineraryQueue(draft, addedMsg);
  }
  draft.phase = 'itineraryChoice';
  return { reply: `${addedMsg}${askAddMoreItinerary()}`, draft };
}

async function stepSightseeingSelfBookedGate(draft, userMessage) {
  const answer = userMessage.trim();
  if (isCancelItemIntent(answer)) {
    draft.currentItemDraft = null;
    if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
      return processAgentItineraryQueue(draft, 'Okay, not adding this sightseeing. ');
    }
    draft.phase = 'itineraryChoice';
    return { reply: `Okay, not adding this sightseeing. ${askItineraryChoice()}`, draft };
  }
  const wantsAdd = /\b(add|pickup|detail)\b/i.test(answer) && !/self.?book/i.test(answer);
  const selfBooked = parseYesNo(answer) === false || /self.?book/i.test(answer);
  if (selfBooked && !wantsAdd) return finishSelfBookedSightseeingItem(draft);
  if (wantsAdd || parseYesNo(answer) === true) {
    draft.phase = 'sightseeingCollect';
    draft.itemStep = 'time';
    return { reply: sightseeingStepPrompt('time'), draft };
  }
  return { reply: `Sorry, could you clarify — reply "self-booked" or "add pickup point details"?`, draft };
}

// --- edit mode: adding itinerary items to an ALREADY-SAVED booking/quotation ---
// Reuses stepItineraryChoice/stepTransferCollect/stepRestaurantCollect unchanged (draft.editMode
// just redirects the two "no more items" exits here instead of into the price-collection phase,
// which only makes sense when building a brand-new record from scratch).

// Builds a draft that enters directly at the itinerary phase, seeded from an EXISTING record
// (fetched via convertBooking.js's fetchRawRecord, the same GetBookingById-based read used for
// booking conversion) rather than from a blank slate. Only the fields the itinerary-collection
// helpers actually read are populated - see stepTransferCollect/stepRestaurantCollect for what
// those are (fields.travelDate for day-number math, fields.currency/guestAdults/.../guestInfants
// as defaults for new items).
function startItineraryEditDraft(raw, code, guestName) {
  const isoToDDMMYYYY = (iso) => {
    const d = new Date(iso);
    return `${String(d.getUTCDate()).padStart(2, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${d.getUTCFullYear()}`;
  };
  return {
    kind: raw.isBooking ? 'booking' : 'quotation',
    phase: 'itineraryChoice',
    fields: {
      travelDate: isoToDDMMYYYY(raw.travelDate),
      returnDate: isoToDDMMYYYY(raw.returnDate),
      currency: raw.currency || 'THB',
      guestAdults: raw.guestAdults,
      guestChildrens: raw.guestChildrens,
      guestInfants: raw.guestInfants,
    },
    itineraryItems: [], // ONLY newly-added items this session - existing ones are never re-parsed,
    // see finishItineraryEdit, which appends these into the existing itinearyDetails untouched.
    itinerarySelfBooked: false,
    currentItemDraft: null,
    itemStep: null,
    destinationOptions: null,
    vehicleOptions: null,
    editMode: true,
    editContext: { raw, code, guestName },
  };
}

// Called once the user is done adding items (or picks self-booked) - asks for an explicit yes/no
// before actually saving, matching every other real write in this file (stepConfirm for a new
// booking, the convert/field-edit/status flows in chat.js). Previously this went STRAIGHT from
// "self-booked"/"done" to submitBooking() with no confirmation at all - reproduced live: replying
// "self-booked" to the very first itinerary-edit prompt saved to production immediately.
function askConfirmItineraryEdit(draft) {
  const { code, guestName } = draft.editContext;
  const summary = draft.itinerarySelfBooked
    ? 'marking the itinerary as self-booked (no items)'
    : `adding ${draft.itineraryItems.length} new itinerary item(s)`;
  draft.phase = 'confirmItineraryEdit';
  return { reply: `Ready to save **${code}** (${guestName}) — ${summary}. This will update the live record and can't be undone from here. Proceed? (yes/no)`, draft };
}

async function stepConfirmItineraryEdit(draft, userMessage) {
  const yn = parseYesNo(userMessage);
  if (yn === false) {
    return { reply: `Okay, cancelled — nothing was saved.`, draft: null };
  }
  if (yn !== true) {
    return { reply: `Reply "yes" to save this itinerary update, or "no" to cancel.`, draft };
  }
  return finishItineraryEdit(draft);
}

// Called once the user has explicitly confirmed (see askConfirmItineraryEdit/
// stepConfirmItineraryEdit above). Merges the newly-collected items into the EXISTING
// itinearyDetails by day, leaving every previously-saved day/item exactly as GetBookingById
// returned it - the new items are the only thing built by this codebase, so they're the only thing
// whose shape we need to trust.
async function finishItineraryEdit(draft) {
  const { raw, code, guestName } = draft.editContext;
  const merged = { ...(raw.itinearyDetails || {}) };
  for (const item of draft.itineraryItems) {
    const day = String(item.dayNumber);
    merged[day] = merged[day] ? [...merged[day], item] : [item];
  }
  // The real site ALSO submits a flat itinearies[] alongside the day-keyed itinearyDetails
  // (managebookings.js's convertItineraryData() flattens the same dict into {...item, day: dayKey}
  // right before every save) - a first attempt that set only itinearyDetails silently saved
  // nothing, so both are populated here the same way.
  const itinearies = Object.entries(merged).flatMap(([day, items]) => items.map((item) => ({ ...item, day })));
  // This function is only reached once at least one real item has been added (see
  // stepItineraryChoice - the old whole-itinerary "self-booked" shortcut that used to set
  // draft.itinerarySelfBooked no longer exists), so a booking/quotation that was previously saved
  // self-booked must have that flag cleared now - otherwise raw.selfBookedItineary carries the old
  // "true" forward even though real itinerary rows are being added, the same staleness bug hit live
  // on the hotel side (see startAddHotel's saveRawPatch in chat.js).
  const patched = {
    ...raw,
    itinearyDetails: merged,
    itinearies,
    selfBookedItineary: false,
  };

  const trySave = async (allowSalesEntry) => submitBooking(patched, !!patched.isBooking, { allowSalesEntry });
  try {
    await trySave(true);
  } catch (err) {
    if (err.code !== 'AGENT_ACCOUNT_NOT_FOUND') {
      // draft.phase is still 'confirmItineraryEdit' here (unchanged) - kept, not cleared, so a
      // transient failure (e.g. a network hiccup reaching the FlyThai site - see bookingApi.js's
      // safeFetch) doesn't force the user to re-answer every itinerary question from scratch.
      // Matches trySubmit's own error handling for a brand-new booking/quotation.
      return { reply: `Sorry, saving the itinerary failed: ${err.message}. Nothing was saved — reply "yes" to try again once that's fixed, or "no" to cancel.`, draft };
    }
    try {
      await trySave(false);
    } catch (err2) {
      return { reply: `Sorry, saving the itinerary failed: ${err2.message}. Nothing was saved — reply "yes" to try again once that's fixed, or "no" to cancel.`, draft };
    }
  }
  return { reply: `Done — itinerary updated for **${code}** (${guestName}).`, draft: null };
}

// Handles one "ask for a name, resolve it via DB lookup, disambiguate if needed" field. Returns
// { resolved: true } once item[fieldKey]/item[rowKey] are set (caller continues to the next
// field), or { reply } if the caller should show that and wait for the next message instead.
// formatOption renders each candidate for both display AND matching - defaults to just the bare
// Name, but several master tables (VehicalMaster in particular - see VEHICLE_FORMAT_OPTION below)
// have several rows sharing the exact same Name (e.g. five separate "Bus" rows, one per seating
// capacity). Listing bare names there produced a disambiguation list where every bullet read
// identically ("Bus" x5) with no way for the user to tell them apart or to answer it - reproduced
// live. A caller with that kind of data passes a formatOption that includes the distinguishing
// detail (capacity, address, etc.) so each option is actually distinct on screen.
async function resolveSequentialLookup(item, fieldKey, rowKey, lookupFn, label, userAnswer, formatOption = (o) => o.Name) {
  if (item._pendingField === fieldKey) {
    const picked = item._pendingRows.find((o) => formatOption(o).toLowerCase() === userAnswer.toLowerCase());
    if (!picked) {
      // The reply didn't match any of the options just offered - rather than repeat that same
      // list forever (reproduced live: replying "SUV" while a "Bus" x5 disambiguation was pending
      // just re-showed the identical "Bus" list, with no way to escape it except cancelling the
      // whole item), clear the pending state and treat this reply as a brand-new search instead.
      // It still only ever resolves onto a real record (via the same lookupFn below), so this can't
      // introduce a wrong/invented answer - it just stops a legitimate change of mind from getting stuck.
      delete item._pendingField;
      delete item._pendingRows;
      return resolveSequentialLookup(item, fieldKey, rowKey, lookupFn, label, userAnswer, formatOption);
    }
    item[fieldKey] = picked.Name;
    item[rowKey] = picked;
    delete item._pendingField;
    delete item._pendingRows;
    return { resolved: true };
  }

  const rows = await lookupFn(userAnswer);
  if (rows.length === 0) {
    return { reply: `I couldn't find a ${label} matching "${userAnswer}" — could you check the spelling?` };
  }
  if (rows.length > 1) {
    item._pendingField = fieldKey;
    item._pendingRows = rows;
    const opts = rows.map((r) => `- ${formatOption(r)}`).join('\n');
    return { reply: `A few ${label} options match "${userAnswer}":\n${opts}\nWhich one did you mean? Please reply with the exact option as shown above.` };
  }
  item[fieldKey] = rows[0].Name;
  item[rowKey] = rows[0];
  return { resolved: true };
}

// VehicalMaster rows are frequently duplicated by Name with only Capacity distinguishing them
// (see the comment on resolveSequentialLookup above) - every vehicle-type lookup uses this.
function formatVehicleOption(v) {
  return v.Capacity != null ? `${v.Name} (${v.Capacity} seats)` : v.Name;
}

// A transfer's Name is often a substring of a DIFFERENT transfer's Name (e.g. "Bangkok Hotel (10
// Hrs Disposal)" inside "Pattaya Hotel to Bangkok Hotel (10 Hrs Disposal)") - showing/matching by
// Code (unique per row) instead of bare Name avoids exactly the same "picking any option re-asks
// forever" failure this file already fixed for vehicles (see findPickupOrParticular's own comment).
// Shared by transfer AND sightseeing lookups - both are Category-scoped rows of the same Particular
// table, with the same Code/Name shape and the same substring-collision risk.
function formatParticularOption(t) {
  return t.Code ? `${t.Code} — ${t.Name}` : t.Name;
}

// 'time' is required, right after date - matches the real Add Transfer form itself, where Date and
// Time are both marked mandatory and shown first, before Pickup/DropOff/Transfer Name.
const TRANSFER_FIELD_ORDER = ['date', 'time', 'pickupPointName', 'dropOffPointName', 'transferName', 'vehicleTypeName'];
const TRANSFER_LOOKUPS = {
  pickupPointName: [findPickup, 'pickup point'],
  dropOffPointName: [findPickup, 'drop-off point'],
  transferName: [findPickupOrParticular, 'transfer name', formatParticularOption],
  vehicleTypeName: [findVehicle, 'vehicle type', formatVehicleOption],
};

function transferStepPrompt(stepKey, draft) {
  switch (stepKey) {
    case 'date':
      return 'What date is this transfer? (DD-MM-YYYY)';
    case 'time':
      return 'What time is this transfer? (e.g. "09:30", "930", or "2:30pm")';
    case 'pickupPointName':
      return 'What is the pickup point?';
    case 'dropOffPointName':
      return 'What is the drop-off point?';
    case 'transferName':
      return 'What is the transfer code or name (e.g. "061" or "Airport to Hotel")?';
    case 'vehicleTypeName':
      // formatVehicleOption, not bare .Name - VehicalMaster has several rows sharing one name
      // (e.g. 5 separate "Bus" rows, one per seating capacity) - listing bare names here produced
      // "Available: Bus, Bus, Bus, Bus, Bus, Car, SUV, Van" with no way to tell them apart.
      return `What vehicle type? Available: ${draft.vehicleOptions.map(formatVehicleOption).join(', ')}`;
    default:
      return '';
  }
}

// Shared by processAgentItineraryQueue (auto-queue dequeue) and stepTransferCollect (every manual
// field answer) - single place that decides what's next for a transfer item, so a same-worded
// transferName match staged via t._pendingTransferNameConfirm (see processAgentItineraryQueue)
// gets confirmed instead of asked blind, no matter which of those two callers reaches it first
// (pickup/dropoff may already be resolved when queued, or may only finish after manual answers).
// Sets draft.itemStep as a side effect, matching every other step-prompt call site's convention.
// Returns null once every field (including transferName) is filled - caller moves on from there.
function nextTransferStepReply(draft, t) {
  const next = TRANSFER_FIELD_ORDER.find((k) => t[k] === undefined || t[k] === null || t[k] === '');
  if (next === 'pickupPointName' && t._pendingPickupPointConfirm) {
    draft.itemStep = 'pickupPointConfirm';
    return `The message suggests the pickup point is **${t._pendingPickupPointConfirm.Name}** — is that correct, or would you like to change it?`;
  }
  if (next === 'dropOffPointName' && t._pendingDropOffPointConfirm) {
    draft.itemStep = 'dropOffPointConfirm';
    return `The message suggests the drop-off point is **${t._pendingDropOffPointConfirm.Name}** — is that correct, or would you like to change it?`;
  }
  if (next === 'transferName' && t._pendingTransferNameConfirm) {
    draft.itemStep = 'transferNameConfirm';
    return `The message suggests the transfer is **${t._pendingTransferNameConfirm.Name}** — is that correct, or would you like to change it?`;
  }
  if (!next) return null;
  draft.itemStep = next;
  return transferStepPrompt(next, draft);
}

async function stepTransferCollect(draft, userMessage) {
  if (!draft.vehicleOptions) draft.vehicleOptions = await listVehicles();
  const t = draft.currentItemDraft;
  const answer = userMessage.trim();

  if (isCancelItemIntent(answer)) {
    draft.currentItemDraft = null;
    if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
      return processAgentItineraryQueue(draft, 'Okay, not adding this transfer. ');
    }
    draft.phase = 'itineraryChoice';
    return { reply: `Okay, not adding this transfer. ${askItineraryChoice()}`, draft };
  }

  if (t._pendingField) {
    const [lookupFn, label, formatOption] = TRANSFER_LOOKUPS[t._pendingField];
    const res = await resolveSequentialLookup(t, t._pendingField, `_${t._pendingField}Row`, lookupFn, label, answer, formatOption);
    if (!res.resolved) return { reply: res.reply, draft };
  } else {
    switch (draft.itemStep) {
      case 'date': {
        const err = validateItineraryItemDate(answer, draft);
        if (err) return { reply: err, draft };
        t.date = answer;
        draft.phase = 'transferSelfBookedGate';
        return { reply: askItemSelfBookedGate(), draft };
      }
      case 'time': {
        const parsedTime = parseFlexibleTime(answer);
        if (!parsedTime) {
          return { reply: 'That needs to be a real time (e.g. "09:30", "930", or "2:30pm") — could you re-enter it?', draft };
        }
        t.time = parsedTime;
        break;
      }
      case 'pickupPointName':
      case 'dropOffPointName':
      case 'transferName':
      case 'vehicleTypeName': {
        const [lookupFn, label, formatOption] = TRANSFER_LOOKUPS[draft.itemStep];
        const res = await resolveSequentialLookup(t, draft.itemStep, `_${draft.itemStep}Row`, lookupFn, label, answer, formatOption);
        if (!res.resolved) return { reply: res.reply, draft };
        break;
      }
      case 'transferNameConfirm': {
        const yn = parseYesNo(answer);
        if (yn === true) {
          t.transferName = t._pendingTransferNameConfirm.Name;
          t._transferNameRow = t._pendingTransferNameConfirm;
          delete t._pendingTransferNameConfirm;
          break;
        }
        if (yn === false || /change|different|edit/i.test(answer)) {
          delete t._pendingTransferNameConfirm;
          draft.itemStep = 'transferName';
          return { reply: transferStepPrompt('transferName', draft), draft };
        }
        return { reply: `Is **${t._pendingTransferNameConfirm.Name}** the right transfer? Reply "yes" to keep it, or "change" to pick a different one.`, draft };
      }
      case 'pickupPointConfirm': {
        const yn = parseYesNo(answer);
        if (yn === true) {
          t.pickupPointName = t._pendingPickupPointConfirm.Name;
          t._pickupPointNameRow = t._pendingPickupPointConfirm;
          delete t._pendingPickupPointConfirm;
          break;
        }
        if (yn === false || /change|different|edit/i.test(answer)) {
          delete t._pendingPickupPointConfirm;
          draft.itemStep = 'pickupPointName';
          return { reply: transferStepPrompt('pickupPointName', draft), draft };
        }
        return { reply: `Is **${t._pendingPickupPointConfirm.Name}** the right pickup point? Reply "yes" to keep it, or "change" to pick a different one.`, draft };
      }
      case 'dropOffPointConfirm': {
        const yn = parseYesNo(answer);
        if (yn === true) {
          t.dropOffPointName = t._pendingDropOffPointConfirm.Name;
          t._dropOffPointNameRow = t._pendingDropOffPointConfirm;
          delete t._pendingDropOffPointConfirm;
          break;
        }
        if (yn === false || /change|different|edit/i.test(answer)) {
          delete t._pendingDropOffPointConfirm;
          draft.itemStep = 'dropOffPointName';
          return { reply: transferStepPrompt('dropOffPointName', draft), draft };
        }
        return { reply: `Is **${t._pendingDropOffPointConfirm.Name}** the right drop-off point? Reply "yes" to keep it, or "change" to pick a different one.`, draft };
      }
      default:
        break;
    }
  }

  const stepReply = nextTransferStepReply(draft, t);
  if (stepReply) return { reply: stepReply, draft };

  draft.phase = 'transferOptionalGate';
  return { reply: askTransferOptionalGate(), draft };
}

function transferOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a transfer itinerary item.
Possible fields: numberOfVehicles (number), vehiclePrice (number), flightNo, remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
}

// One-tap gate before the actual optional-details form - most transfers need none of this, so
// staff with nothing to add skip straight to "item added" instead of being shown a form to skip.
// Same pattern as askExtraGate()/stepExtraGate() below for the final booking-level extras. Time
// itself is required and already asked earlier (see TRANSFER_FIELD_ORDER) - not offered again here.
function askTransferOptionalGate() {
  return `Want to add optional details for this transfer — number of vehicles, vehicle price, flight no, remarks?`;
}

async function stepTransferOptionalGate(draft, userMessage) {
  if (parseYesNo(userMessage) === false) return finishTransferItem(draft);
  draft.phase = 'transferOptionalCollect';
  return { reply: 'Fill in what you\'d like below, or reply "skip".', draft };
}

async function stepTransferOptionalCollect(draft, userMessage) {
  const t = draft.currentItemDraft;
  const answer = userMessage.trim();
  if (!/^skip$/i.test(answer)) {
    let parsed;
    try {
      parsed = await extractFields(transferOptionalSystemPrompt(t), answer);
    } catch (e) {
      parsed = null; // optional - ignore parse failures
    }
    // A reply that named a field but gave no actual value (e.g. just "time") extracts nothing
    // usable - silently proceeding would save the item with that field still blank (or, worse,
    // with the field name itself saved as its own "value" - see stripEchoedFields), with no sign
    // anything went wrong. Ask once for an example instead; give up after one retry so a user who
    // really meant something unparseable isn't stuck in a loop.
    const cleanFields = stripEchoedFields(parsed && parsed.fields);
    const hasFields = Object.keys(cleanFields).length > 0;
    if (!hasFields && !draft._transferOptionalRetried) {
      draft._transferOptionalRetried = true;
      return { reply: `I couldn't pick out a value from that — could you give it with the actual value, e.g. "14:30, 2 vehicles" or "flight AI131"? Or reply "skip".`, draft };
    }
    if (hasFields) Object.assign(t, cleanFields);
  }
  delete draft._transferOptionalRetried;
  return finishTransferItem(draft);
}

// Builds and pushes the finished transfer item - shared by the "skip" path (gate says no, nothing
// to merge) and the "add details" path (stepTransferOptionalCollect, after merging whatever fields
// the form/free-text supplied).
function finishTransferItem(draft) {
  const t = draft.currentItemDraft;
  const pickup = t._pickupPointNameRow;
  const dropoff = t._dropOffPointNameRow;
  const particular = t._transferNameRow;
  const vehicle = t._vehicleTypeNameRow;
  const vehicleCount = Number(t.numberOfVehicles) || 1;
  const vehiclePrice = Number(t.vehiclePrice) || 0;

  draft.itineraryItems.push({
    type: 'transfer',
    id: '', // must be a string ("" for new/unsaved) - the server 500s on a numeric 0 here, unlike hotel rows
    dayNumber: computeDayNumber(t.date, draft.fields.travelDate),
    date: t.date,
    time: t.time || '',
    pickupPointId: String(pickup.Id),
    pickupPointName: pickup.Name,
    dropOffPointId: String(dropoff.Id),
    dropOffPointName: dropoff.Name,
    particularId: String(particular.Id),
    transferCode: particular.Code || '',
    transferName: particular.Name,
    vehicleId: String(vehicle.Id),
    vehicleName: vehicle.Name,
    vehicleCount: String(vehicleCount),
    vehiclePrice: String(vehiclePrice),
    vehiclePriceCurrency: draft.fields.currency || 'THB',
    currency: draft.fields.currency || 'THB',
    capacity: vehicle.Capacity != null ? String(vehicle.Capacity) : '',
    remarks: t.remarks || '',
    flightNo: t.flightNo || '',
    selfBooked: false,
    finalPrice: vehiclePrice * vehicleCount,
    costPerAdult: 0,
    costPerChild: 0,
    costPerInfant: 0,
    totalAdult: String(draft.fields.guestAdults || 0),
    totalChild: String(draft.fields.guestChildrens || 0),
    totalInfant: String(draft.fields.guestInfants || 0),
  });

  draft.currentItemDraft = null;
  const addedMsg = `Added the transfer (${pickup.Name} → ${dropoff.Name}). `;
  if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
    return processAgentItineraryQueue(draft, addedMsg);
  }
  draft.phase = 'itineraryChoice';
  return { reply: `${addedMsg}${askAddMoreItinerary()}`, draft };
}

// ---------- itinerary item: sightseeing ----------
// Payload shape (type/field names/what's left null) copied field-for-field from the real site's
// own bookingItineraryManagement.js #btn-save-sightseeing handler - not guessed, since a wrong
// shape here would silently write bad data into a live production quotation/booking (see the
// itinearies[] flattening note above for a real past example of that exact failure mode).
const SIGHTSEEING_FIELD_ORDER = ['date', 'time', 'pickupPointName', 'sightseeingName'];

function sightseeingStepPrompt(stepKey) {
  switch (stepKey) {
    case 'date':
      return 'What date is this sightseeing for? (DD-MM-YYYY)';
    case 'time':
      return 'What time? (e.g. "09:30", "930", or "2:30pm")';
    case 'pickupPointName':
      return 'What is the pickup point?';
    case 'sightseeingName':
      return 'What is the sightseeing code or name (e.g. "0405" or "Phi Phi Island Tour")?';
    default:
      return '';
  }
}

async function stepSightseeingCollect(draft, userMessage) {
  const s = draft.currentItemDraft;
  const answer = userMessage.trim();

  if (isCancelItemIntent(answer)) {
    draft.currentItemDraft = null;
    if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
      return processAgentItineraryQueue(draft, 'Okay, not adding this sightseeing. ');
    }
    draft.phase = 'itineraryChoice';
    return { reply: `Okay, not adding this sightseeing. ${askItineraryChoice()}`, draft };
  }

  // Only tours flagged as running on this date's weekday are offered - same restriction the real
  // Add Sightseeing form applies once a date is picked (see lookups.js findSightseeing).
  const sightseeingLookup = (q) => findSightseeing(q, weekdayNameFor(s.date));

  if (s._pendingField) {
    const res = await resolveSequentialLookup(s, 'sightseeingName', '_sightseeingNameRow', sightseeingLookup, 'sightseeing', answer, formatParticularOption);
    if (!res.resolved) return { reply: res.reply, draft };
  } else {
    switch (draft.itemStep) {
      case 'date': {
        const err = validateItineraryItemDate(answer, draft);
        if (err) return { reply: err, draft };
        s.date = answer;
        draft.phase = 'sightseeingSelfBookedGate';
        return { reply: askItemSelfBookedGate(), draft };
      }
      case 'time': {
        const parsedTime = parseFlexibleTime(answer);
        if (!parsedTime) {
          return { reply: 'That needs to be a real time (e.g. "09:30", "930", or "2:30pm") — could you re-enter it?', draft };
        }
        s.time = parsedTime;
        break;
      }
      case 'pickupPointName': {
        const res = await resolveSequentialLookup(s, 'pickupPointName', '_pickupPointNameRow', findPickup, 'pickup point', answer);
        if (!res.resolved) return { reply: res.reply, draft };
        break;
      }
      case 'sightseeingName': {
        const res = await resolveSequentialLookup(s, 'sightseeingName', '_sightseeingNameRow', sightseeingLookup, 'sightseeing', answer, formatParticularOption);
        if (!res.resolved) return { reply: res.reply, draft };
        break;
      }
      default:
        break;
    }
  }

  const next = SIGHTSEEING_FIELD_ORDER.find((k) => s[k] === undefined || s[k] === null || s[k] === '');
  if (next) {
    draft.itemStep = next;
    return { reply: sightseeingStepPrompt(next), draft };
  }

  draft.phase = 'sightseeingOptionalGate';
  return { reply: askSightseeingOptionalGate(draft), draft };
}

function sightseeingOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a sightseeing itinerary item.
Possible fields: totalAdult (number), adultPrice (number, overrides the master rate), totalChild (number), childPrice (number, overrides the master rate), remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
}

// See askTransferOptionalGate/stepTransferOptionalGate above for the pattern this mirrors. Adults/
// children default to the booking's own total pax if left unanswered (see finishSightseeingItem) -
// stated up front here so that's a visible default being confirmed, not a silent guess.
function askSightseeingOptionalGate(draft) {
  const adults = draft.fields.guestAdults || 0;
  const children = draft.fields.guestChildrens || 0;
  const paxNote = children > 0 ? `${adults} adult(s), ${children} child(ren)` : `${adults} adult(s)`;
  return `Want to add optional details for this sightseeing (remarks, or a different adults/children count)? Reply "skip" to save it for ${paxNote} — the trip's full group.`;
}

async function stepSightseeingOptionalGate(draft, userMessage) {
  if (parseYesNo(userMessage) === false) return finishSightseeingItem(draft);
  draft.phase = 'sightseeingOptionalCollect';
  return { reply: 'Fill in what you\'d like below, or reply "skip".', draft };
}

async function stepSightseeingOptionalCollect(draft, userMessage) {
  const s = draft.currentItemDraft;
  const answer = userMessage.trim();
  if (!/^skip$/i.test(answer)) {
    try {
      const parsed = await extractFields(sightseeingOptionalSystemPrompt(s), answer);
      Object.assign(s, stripEchoedFields(parsed.fields));
    } catch (e) {
      // optional - ignore parse failures
    }
  }
  return finishSightseeingItem(draft);
}

// Builds and pushes the finished sightseeing item - shared by the "skip" path (gate says no,
// nothing to merge) and the "add details" path (after merging whatever the form/free-text gave).
function finishSightseeingItem(draft) {
  const s = draft.currentItemDraft;
  const particular = s._sightseeingNameRow;
  const pickup = s._pickupPointNameRow;
  // Unless staff explicitly gave a different count, default to the booking's own total pax (same
  // convention BookingHotel rows already use - see totalAdults in buildModel's hotel mapping) rather
  // than 0 - a sightseeing/restaurant item with nobody down for it looked like a mistake in every
  // real trip tested, since the whole group normally goes on everything in the itinerary.
  const totalAdult = s.totalAdult != null ? Number(s.totalAdult) : Number(draft.fields.guestAdults) || 0;
  const totalChild = s.totalChild != null ? Number(s.totalChild) : Number(draft.fields.guestChildrens) || 0;
  const adultPrice = s.adultPrice != null ? Number(s.adultPrice) : Number(particular.AdultsPrice) || 0;
  const childPrice = s.childPrice != null ? Number(s.childPrice) : Number(particular.ChildrenPrice) || 0;
  const finalPrice = Math.round((totalAdult * adultPrice + totalChild * childPrice) * 100) / 100;

  draft.itineraryItems.push({
    type: 'sightseeing',
    id: '', // must be a string ("" for new/unsaved) - same as transfer/restaurant items
    dayNumber: computeDayNumber(s.date, draft.fields.travelDate),
    date: s.date,
    time: s.time,
    pickupPointId: String(pickup.Id),
    pickupPointName: pickup.Name,
    particularId: String(particular.Id),
    transferName: particular.Name, // yes, "transferName"/"transferCode" - the real form reuses these keys for sightseeing too
    transferCode: particular.Code || '',
    totalAdult: String(totalAdult),
    adultPrice: String(adultPrice),
    totalChild: String(totalChild),
    childPrice: String(childPrice),
    currency: particular.Currency || draft.fields.currency || 'THB',
    remarks: s.remarks || '',
    selfBooked: false,
    finalPrice,
    costPerAdult: adultPrice,
    costPerChild: childPrice,
    costPerInfant: 0,
    totalInfant: String(draft.fields.guestInfants || 0),
    flightNo: null,
  });

  draft.currentItemDraft = null;
  const addedMsg = `Added the sightseeing (${particular.Name}). `;
  if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
    return processAgentItineraryQueue(draft, addedMsg);
  }
  draft.phase = 'itineraryChoice';
  return { reply: `${addedMsg}${askAddMoreItinerary()}`, draft };
}

// ---------- itinerary item: leisure day ----------
// The real site's "Add Leisure" button opens the exact same Add Sightseeing modal, pre-checks its
// Self Booked box, and auto-submits immediately - no other field is asked (see selfBooked in
// createLeisureDayCard, which renders the whole day as just a "Leisure Day" badge). Mirrored here
// as a single-question step: only the date is needed, everything else matches what that auto-save
// would send with a blank/self-booked form.
async function stepLeisureDayCollect(draft, userMessage) {
  const answer = userMessage.trim();
  if (isCancelItemIntent(answer)) {
    draft.currentItemDraft = null;
    draft.phase = 'itineraryChoice';
    return { reply: `Okay, not adding a leisure day. ${askItineraryChoice()}`, draft };
  }
  const dateErr = validateItineraryItemDate(answer, draft);
  if (dateErr) return { reply: dateErr, draft };

  draft.itineraryItems.push({
    type: 'sightseeing',
    id: '',
    dayNumber: computeDayNumber(answer, draft.fields.travelDate),
    date: answer,
    time: '',
    pickupPointId: '',
    pickupPointName: '',
    particularId: '',
    transferName: '',
    transferCode: '',
    totalAdult: '0',
    adultPrice: '0',
    totalChild: '0',
    childPrice: '0',
    currency: draft.fields.currency || 'THB',
    remarks: '',
    selfBooked: true,
    finalPrice: 0,
    costPerAdult: 0,
    costPerChild: 0,
    costPerInfant: 0,
    totalInfant: String(draft.fields.guestInfants || 0),
    flightNo: null,
  });

  draft.currentItemDraft = null;
  const addedMsg = `Added a Leisure Day for ${answer}. `;
  if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
    return processAgentItineraryQueue(draft, addedMsg);
  }
  draft.phase = 'itineraryChoice';
  return { reply: `${addedMsg}${askAddMoreItinerary()}`, draft };
}

// 'time' is required, right after date - matches Transfer/Sightseeing (see TRANSFER_FIELD_ORDER/
// SIGHTSEEING_FIELD_ORDER).
const RESTAURANT_FIELD_ORDER = ['date', 'time', 'restaurantName'];

function restaurantStepPrompt(stepKey) {
  switch (stepKey) {
    case 'date':
      return 'What date is this restaurant for? (DD-MM-YYYY)';
    case 'time':
      return 'What time? (e.g. "09:30", "930", or "2:30pm")';
    case 'restaurantName':
      return 'What is the restaurant name?';
    default:
      return '';
  }
}

async function stepRestaurantCollect(draft, userMessage) {
  const r = draft.currentItemDraft;
  const answer = userMessage.trim();

  if (isCancelItemIntent(answer)) {
    draft.currentItemDraft = null;
    draft.phase = 'itineraryChoice';
    return { reply: `Okay, not adding this restaurant. ${askItineraryChoice()}`, draft };
  }

  if (r._pendingField) {
    const res = await resolveSequentialLookup(r, 'restaurantName', '_restaurantNameRow', findRestaurant, 'restaurant', answer);
    if (!res.resolved) return { reply: res.reply, draft };
  } else {
    switch (draft.itemStep) {
      case 'date': {
        const err = validateItineraryItemDate(answer, draft);
        if (err) return { reply: err, draft };
        r.date = answer;
        break;
      }
      case 'time': {
        const parsedTime = parseFlexibleTime(answer);
        if (!parsedTime) {
          return { reply: 'That needs to be a real time (e.g. "09:30", "930", or "2:30pm") — could you re-enter it?', draft };
        }
        r.time = parsedTime;
        break;
      }
      case 'restaurantName': {
        const res = await resolveSequentialLookup(r, 'restaurantName', '_restaurantNameRow', findRestaurant, 'restaurant', answer);
        if (!res.resolved) return { reply: res.reply, draft };
        break;
      }
      default:
        break;
    }
  }

  const next = RESTAURANT_FIELD_ORDER.find((k) => r[k] === undefined || r[k] === null || r[k] === '');
  if (next) {
    draft.itemStep = next;
    return { reply: restaurantStepPrompt(next), draft };
  }

  draft.phase = 'restaurantOptionalGate';
  return { reply: askRestaurantOptionalGate(draft), draft };
}

function restaurantOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a restaurant itinerary item.
Possible fields: lunchAdultCount, lunchAdultPrice, lunchChildCount, lunchChildPrice, dinnerAdultCount, dinnerAdultPrice, dinnerChildCount, dinnerChildPrice, remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
}

// See askTransferOptionalGate/stepTransferOptionalGate above for the pattern this mirrors. Lunch
// and dinner adults/children default to the booking's own total pax if left unanswered entirely
// (see finishRestaurantItem) - stated up front here so that's a visible default being confirmed.
function askRestaurantOptionalGate(draft) {
  const adults = draft.fields.guestAdults || 0;
  const children = draft.fields.guestChildrens || 0;
  const paxNote = children > 0 ? `${adults} adult(s), ${children} child(ren)` : `${adults} adult(s)`;
  return `Want to add optional details for this restaurant (prices, or different lunch/dinner adults/children counts)? Reply "skip" to save both lunch and dinner for ${paxNote} — the trip's full group.`;
}

async function stepRestaurantOptionalGate(draft, userMessage) {
  if (parseYesNo(userMessage) === false) return finishRestaurantItem(draft);
  draft.phase = 'restaurantOptionalCollect';
  return { reply: 'Fill in what you\'d like below, or reply "skip".', draft };
}

async function stepRestaurantOptionalCollect(draft, userMessage) {
  const r = draft.currentItemDraft;
  const answer = userMessage.trim();
  if (!/^skip$/i.test(answer)) {
    try {
      const parsed = await extractFields(restaurantOptionalSystemPrompt(r), answer);
      Object.assign(r, stripEchoedFields(parsed.fields));
    } catch (e) {
      // optional - ignore parse failures
    }
  }
  return finishRestaurantItem(draft);
}

// Builds and pushes the finished restaurant item - shared by the "skip" path (gate says no,
// nothing to merge) and the "add details" path (after merging whatever the form/free-text gave).
function finishRestaurantItem(draft) {
  const r = draft.currentItemDraft;
  const restaurant = r._restaurantNameRow;
  // Same "default to the booking's own total pax" rule as sightseeing (see finishSightseeingItem) -
  // but only when NEITHER meal's count was ever mentioned (a fully skipped optional step). If staff
  // gave a count for one meal specifically (e.g. "dinner for 6"), that's a deliberate choice, not
  // something to blindly mirror onto the other meal too.
  const neitherMealSpecified = r.lunchAdultCount == null && r.dinnerAdultCount == null;
  const defaultAdultCount = neitherMealSpecified ? Number(draft.fields.guestAdults) || 0 : 0;
  const defaultChildCount = neitherMealSpecified ? Number(draft.fields.guestChildrens) || 0 : 0;
  const lunchAdultCount = r.lunchAdultCount != null ? Number(r.lunchAdultCount) : defaultAdultCount;
  const lunchAdultPrice = r.lunchAdultPrice != null ? Number(r.lunchAdultPrice) : Number(restaurant.LunchPriceForAdults) || 0;
  const lunchChildCount = r.lunchChildCount != null ? Number(r.lunchChildCount) : defaultChildCount;
  const lunchChildPrice = Number(r.lunchChildPrice) || 0;
  const dinnerAdultCount = r.dinnerAdultCount != null ? Number(r.dinnerAdultCount) : defaultAdultCount;
  const dinnerAdultPrice = r.dinnerAdultPrice != null ? Number(r.dinnerAdultPrice) : Number(restaurant.DinnerPriceForAdults) || 0;
  const dinnerChildCount = r.dinnerChildCount != null ? Number(r.dinnerChildCount) : defaultChildCount;
  const dinnerChildPrice = Number(r.dinnerChildPrice) || 0;

  const totalAdult = Math.max(lunchAdultCount, dinnerAdultCount);
  const totalChild = Math.max(lunchChildCount, dinnerChildCount);
  const finalPrice = Math.round(((lunchAdultCount * lunchAdultPrice) + (dinnerAdultCount * dinnerAdultPrice) + (lunchChildCount * lunchChildPrice) + (dinnerChildCount * dinnerChildPrice)) * 100) / 100;

  draft.itineraryItems.push({
    type: 'restaurant',
    id: '', // must be a string ("" for new/unsaved) - same as transfer items
    dayNumber: computeDayNumber(r.date, draft.fields.travelDate),
    date: r.date,
    restaurantId: String(restaurant.Id),
    restaurantName: restaurant.Name,
    lunchAdultCount: String(lunchAdultCount),
    lunchAdultPrice: String(lunchAdultPrice),
    lunchChildCount: String(lunchChildCount),
    lunchChildPrice: String(lunchChildPrice),
    dinnerAdultCount: String(dinnerAdultCount),
    dinnerAdultPrice: String(dinnerAdultPrice),
    dinnerChildCount: String(dinnerChildCount),
    dinnerChildPrice: String(dinnerChildPrice),
    remarks: r.remarks || '',
    selfBooked: false,
    finalPrice,
    totalAdult: String(totalAdult),
    totalChild: String(totalChild),
    costPerAdult: totalAdult > 0 ? Math.round((finalPrice / totalAdult) * 100) / 100 : 0,
    costPerChild: 0,
    costPerInfant: 0,
    totalInfant: String(draft.fields.guestInfants || 0),
    currency: draft.fields.currency || 'THB',
    flightNo: null,
    time: r.time || null,
    dropOffPointId: null,
    dropOffPointName: null,
    pickupPointId: null,
    pickupPointName: null,
    particularId: null,
    transferCode: null,
    transferName: null,
    vehicleId: null,
    vehicleName: null,
    vehicleCount: null,
    vehiclePrice: null,
    vehiclePriceCurrency: null,
    capacity: null,
    adultPrice: null,
    childPrice: null,
  });

  draft.currentItemDraft = null;
  const addedMsg = `Added the restaurant (${restaurant.Name}). `;
  if (draft._agentItineraryQueue && draft._agentItineraryQueue.length > 0) {
    return processAgentItineraryQueue(draft, addedMsg);
  }
  draft.phase = 'itineraryChoice';
  return { reply: `${addedMsg}${askAddMoreItinerary()}`, draft };
}

function askAddMoreItinerary() {
  return 'Add another itinerary item ("transfer"/"sightseeing"/"restaurant"/"leisure"), or say "done"?';
}

// ---------- phase: price / member details (fully deterministic) ----------

function askAddMembers() {
  return `Now traveller pricing (optional) — e.g. "Adult/Double: 8 pax at 3645 THB". Add a pricing line, or say "skip"?`;
}

const MEMBER_FIELD_ORDER = ['type', 'pax', 'price'];

function memberStepPrompt(stepKey) {
  switch (stepKey) {
    case 'type':
      return 'What traveller type is this pricing for? (e.g. "Adult / Double", "Adult / Single", "Child")';
    case 'pax':
      return 'How many pax?';
    case 'price':
      return 'What is the price per pax?';
    default:
      return '';
  }
}

async function stepPriceCollect(draft, userMessage) {
  if (!draft.currentItemDraft) {
    if (parseYesNo(userMessage) === false) {
      draft.phase = 'priceExtras';
      return { reply: askPriceExtras(), draft };
    }
    draft.currentItemDraft = {};
    draft.itemStep = 'type';
    return { reply: memberStepPrompt('type'), draft };
  }

  const m = draft.currentItemDraft;
  const answer = userMessage.trim();

  if (isCancelItemIntent(answer)) {
    draft.currentItemDraft = null;
    draft.phase = 'priceExtras';
    return { reply: `Okay, not adding this pricing line. ${askPriceExtras()}`, draft };
  }

  switch (draft.itemStep) {
    case 'type':
      m.type = answer;
      break;
    case 'pax': {
      if (!WHOLE_NUMBER_RE.test(answer)) {
        return { reply: 'That needs to be digits only, no other text — how many pax?', draft };
      }
      const n = parseInt(answer, 10);
      if (n <= 0) return { reply: 'That needs to be a whole number greater than 0 — how many pax?', draft };
      m.pax = n;
      break;
    }
    case 'price': {
      if (!DECIMAL_NUMBER_RE.test(answer)) {
        return { reply: 'That needs to be digits only, no currency symbol or other text — what is the price per pax?', draft };
      }
      m.price = parseFloat(answer);
      break;
    }
    default:
      break;
  }

  const next = MEMBER_FIELD_ORDER.find((k) => m[k] === undefined || m[k] === null || m[k] === '');
  if (next) {
    draft.itemStep = next;
    return { reply: memberStepPrompt(next), draft };
  }

  // pax/price must be strings (server 500s on numbers here, opposite convention from itinerary
  // item ids) - verified via live testing against the real endpoint.
  draft.members.push({ id: 0, price: String(Number(m.price) || 0), pax: String(Number(m.pax) || 0), type: m.type });
  draft.currentItemDraft = null;
  draft.phase = 'priceCollectAnother';
  return { reply: `Added **${m.type}**: ${m.pax} pax @ ${m.price}. Add another pricing line? (yes/no)`, draft };
}

async function stepPriceCollectAnother(draft, userMessage) {
  const yn = parseYesNo(userMessage);
  if (yn === true) {
    draft.phase = 'priceCollect';
    draft.currentItemDraft = {};
    draft.itemStep = 'type';
    return { reply: memberStepPrompt('type'), draft };
  }
  // See stepHotelAddAnother's comment above - an unrecognized reply must re-ask, not silently act
  // as "no" and move on past a pricing line the user may still have wanted to add.
  if (yn !== false) {
    return { reply: `Sorry, I didn't catch that. Add another traveller-type pricing line? (yes/no)`, draft };
  }
  draft.phase = 'priceExtras';
  return { reply: askPriceExtras(), draft };
}

function askPriceExtras() {
  return `Any of these to set? ROE rate/charge, tax amount/%, invoice discount, invoice due date, final selling rate. All optional — reply with any you want, or "skip".`;
}

function priceExtrasSystemPrompt(fields) {
  return `You are collecting optional pricing fields for a booking: roeRate, roeCharge, taxAmount, taxPercentage, invoiceDiscount, invoiceDueDate (DD-MM-YYYY), landSelling (final selling rate, a number).
Fields so far (JSON): ${JSON.stringify(fields)}
Merge the user's latest message into the fields (only include ones the user actually mentioned). If the user says "skip"/"no"/"none"/"done", set done true. Otherwise set done true once you've captured what they mentioned (this is a single-turn optional step, don't ask follow-ups).
Respond with ONLY JSON: {"reply": "...", "fields": {...merged...}, "done": <bool>}`;
}

async function stepPriceExtras(draft, userMessage) {
  let parsed;
  try {
    parsed = await extractFields(priceExtrasSystemPrompt(draft.priceFields), userMessage);
  } catch (e) {
    parsed = { fields: {}, done: true, reply: '' };
  }
  const mergedFields = { ...draft.priceFields, ...stripEchoedFields(parsed.fields) };
  // invoiceDueDate is the one date field extracted freeform by the LLM rather than typed against
  // parseDateDDMMYYYY directly (this step never re-prompts - see note above) - so unlike
  // travelDate/returnDate/checkIn/etc., nothing else here catches a mis-parsed or malformed value.
  // Silently drop rather than save a value that isn't actually a valid DD-MM-YYYY date.
  if (mergedFields.invoiceDueDate && !parseDateDDMMYYYY(mergedFields.invoiceDueDate)) {
    delete mergedFields.invoiceDueDate;
  }
  draft.priceFields = mergedFields;
  draft.phase = 'extraGate';
  return { reply: askExtraGate(), draft };
}

// ---------- phase: extra note / emergency contact / booking by / PDF permissions ----------

// A one-tap gate before the actual form - most bookings need none of this, so staff with nothing
// to add get straight to confirm instead of being shown a form to skip. Only saying yes/otherwise
// opens askExtras()'s actual field-collection step below.
function askExtraGate() {
  return `Last bit (all optional): extra note, emergency contact, who this is booked by, and PDF download permissions for the agent. Want to add any of these?`;
}

async function stepExtraGate(draft, userMessage) {
  if (parseYesNo(userMessage) === false) {
    draft.phase = 'confirm';
    return { reply: buildConfirmationSummary(draft), draft };
  }
  draft.phase = 'extraCollect';
  return { reply: askExtras(), draft };
}

function askExtras() {
  return `Extra note, emergency contact, who this is booked by, and/or PDF download permissions — reply with any of these, or "skip".`;
}

function extraSystemPrompt(fields) {
  return `You are collecting optional final details for a booking: extraNote, emergencyContact, bookingBy, allowVoucherPdf (boolean), allowInvoicePdf (boolean), allowItineraryPdf (boolean) - each independently whether the agent may download that specific PDF type (hotel voucher / invoice / itinerary), default false if not mentioned.
Fields so far (JSON): ${JSON.stringify(fields)}
Merge the user's latest message (only fields the user actually mentioned). This is a single-turn optional step - always set done true.
Respond with ONLY JSON: {"reply": "", "fields": {...merged...}, "done": true}`;
}

async function stepExtraCollect(draft, userMessage) {
  let parsed;
  try {
    parsed = await extractFields(extraSystemPrompt(draft.extraFields), userMessage);
  } catch (e) {
    parsed = { fields: {} };
  }
  draft.extraFields = { ...draft.extraFields, ...stripEchoedFields(parsed.fields) };
  draft.phase = 'confirm';
  return { reply: buildConfirmationSummary(draft), draft };
}

// ---------- phase: confirm + submit ----------

// Deterministic (no LLM) - mirrors the ### section/table style already used for read-side
// "booking detail" answers, so what the user confirms looks like what they'd see afterward.
function buildConfirmationSummary(draft) {
  const f = draft.fields;
  let out = `Here's the new ${draft.kind} — please review before I save it:\n\n`;
  out += `### Booking Summary\n`;
  out += `Guest Name: ${f.guestName}\nPhone: ${f.guestPhoneNumber}\nEmail: ${f.guestEmail}\nAgent: ${draft.resolvedAgent.Name}\nDestinations: ${draft.resolvedDestinations.map((d) => d.Name).join(', ')}\nTravel Date: ${f.travelDate}\nReturn Date: ${f.returnDate}\nAdults/Children/Infants: ${f.guestAdults || 0}/${f.guestChildrens || 0}/${f.guestInfants || 0}\n\n`;

  out += `### Hotel Details\n`;
  if (draft.hotelSelfBooked || draft.hotels.length === 0) {
    out += `Self-booked (guest arranging own hotel)\n\n`;
  } else {
    out += `| Hotel Name | Check-in | Check-out | Room Type | Rooms | Nights |\n|---|---|---|---|---|---|\n`;
    for (const h of draft.hotels) {
      out += `| ${h.name} | ${h.checkInDate} | ${h.checkOutDate} | ${h.roomCategory} | ${h.totalRooms} | ${h.totalNights} |\n`;
    }
    out += `\n`;
  }

  out += `### Itinerary Details\n`;
  if (draft.itinerarySelfBooked || draft.itineraryItems.length === 0) {
    out += `Self-booked (guest arranging own itinerary)\n\n`;
  } else {
    for (const item of draft.itineraryItems) {
      if (item.selfBooked) {
        out += `- Day ${item.dayNumber} (${item.date}): Self-booked\n`;
      } else if (item.type === 'transfer') {
        out += `- Day ${item.dayNumber} (${item.date}): Transfer — ${item.pickupPointName} → ${item.dropOffPointName}, ${item.vehicleName}\n`;
      } else if (item.type === 'sightseeing') {
        out += `- Day ${item.dayNumber} (${item.date}): Sightseeing — ${item.transferName} (${item.pickupPointName}, ${item.time})\n`;
      } else {
        out += `- Day ${item.dayNumber} (${item.date}): Restaurant — ${item.restaurantName}\n`;
      }
    }
    out += `\n`;
  }

  if (draft.members.length > 0) {
    out += `### Cost Breakdown\n| Traveller | Pax | Amount |\n|---|---|---|\n`;
    for (const m of draft.members) {
      out += `| ${m.type} | ${m.pax} | ${m.price} ${f.currency || 'THB'} |\n`;
    }
    out += `\n`;
  }

  const extraLines = [];
  if (draft.extraFields.extraNote) extraLines.push(`Note: ${draft.extraFields.extraNote}`);
  if (draft.extraFields.emergencyContact) extraLines.push(`Emergency Contact: ${draft.extraFields.emergencyContact}`);
  if (draft.extraFields.bookingBy) extraLines.push(`Booking By: ${draft.extraFields.bookingBy}`);
  const allowedPdfs = [];
  if (draft.extraFields.allowVoucherPdf) allowedPdfs.push('Voucher');
  if (draft.extraFields.allowInvoicePdf) allowedPdfs.push('Invoice');
  if (draft.extraFields.allowItineraryPdf) allowedPdfs.push('Itinerary');
  if (allowedPdfs.length > 0) extraLines.push(`Agent may download PDFs: ${allowedPdfs.join(', ')}`);
  if (extraLines.length > 0) {
    out += `### Payments / Job Sheet / Other\n${extraLines.join('\n')}\n\n`;
  }

  out += `Reply "yes" to save this, or "no" to cancel.`;
  return out;
}

// FlyThai's AddBooking endpoint silently rejects the ENTIRE booking (returns "0", no valid id,
// no error detail) if extraNote is too long - confirmed live by bisection: 350 chars OK, 360+
// rejected. Auto-generated notes on complex multi-destination bookings routinely exceed that, so
// cap it well under the threshold rather than let a long note silently kill the whole save.
const EXTRA_NOTE_MAX_LENGTH = 300;
function capExtraNote(note) {
  const trimmed = String(note || '').trim();
  if (trimmed.length <= EXTRA_NOTE_MAX_LENGTH) return trimmed;
  return `${trimmed.slice(0, EXTRA_NOTE_MAX_LENGTH - 1)}…`;
}

function buildModel(draft) {
  const f = draft.fields;
  const itinearyDetails = {};
  for (const item of draft.itineraryItems) {
    const day = String(item.dayNumber);
    if (!itinearyDetails[day]) itinearyDetails[day] = [];
    itinearyDetails[day].push(item);
  }
  // The real site's own save also submits a flat itinearies[] alongside the day-keyed
  // itinearyDetails (managebookings.js flattens the same dict via convertItineraryData() right
  // before every AddBooking call). Proven live: submitting itinearyDetails alone silently saves
  // NO itinerary rows at all - the server accepts the request and returns a valid id, but
  // GetBookingById shows an empty itinerary afterwards. This hardcoded `itinearies: []` (below,
  // now replaced) was that exact same bug in the CREATE path - every booking/quotation made
  // through this chat flow with itinerary items likely lost them silently, the same way.
  const itinearies = Object.entries(itinearyDetails).flatMap(([day, items]) => items.map((item) => ({ ...item, day })));

  return {
    id: 0,
    destinations: draft.resolvedDestinations.map((d) => d.Id).join(','),
    agentId: String(draft.resolvedAgent.Id),
    guestCompany: f.guestCompany || draft.resolvedAgent.Name || '',
    guestEmail: f.guestEmail,
    guestAddress: f.guestAddress || draft.resolvedAgent.Address || '',
    guestAdults: f.guestAdults != null ? String(f.guestAdults) : '',
    guestChildrens: f.guestChildrens != null ? String(f.guestChildrens) : '',
    guestInfants: f.guestInfants != null ? String(f.guestInfants) : '',
    travelDate: f.travelDate,
    returnDate: f.returnDate,
    hotelDetails: draft.hotelSelfBooked ? null : draft.hotels,
    itinearyDetails,
    lunchDetails: '',
    dinnerDetails: '',
    lunchRemarks: '',
    dinnerRemarks: '',
    currency: f.currency || 'THB',
    memberDetails: draft.members,
    // roeRate/roeCharge/taxAmount/taxPercentage/invoiceDiscount are extracted freeform by the LLM
    // (priceExtrasSystemPrompt), which returns numbers, not strings - unlike LandSelling just below
    // (already String()'d), these were passed straight through. Reproduced live: a booking with
    // real values here ("ROE rate 2.5, tax 500, ...") got a bare 500 from the real API with an
    // empty body - the same "server 500s on a number where it wants a string" failure mode already
    // seen and fixed elsewhere in this file (pax/price, hotel/itinerary item ids).
    roerate: draft.priceFields.roeRate != null ? String(draft.priceFields.roeRate) : '',
    roecharge: draft.priceFields.roeCharge != null ? String(draft.priceFields.roeCharge) : '',
    taxAmount: draft.priceFields.taxAmount != null ? String(draft.priceFields.taxAmount) : '',
    taxPercentage: draft.priceFields.taxPercentage != null ? String(draft.priceFields.taxPercentage) : '',
    LandSelling: draft.priceFields.landSelling != null ? String(draft.priceFields.landSelling) : '0',
    LandSellingCurrency: f.currency || 'THB',
    invoiceDueDate: draft.priceFields.invoiceDueDate || '',
    invoiceDiscount: draft.priceFields.invoiceDiscount != null ? String(draft.priceFields.invoiceDiscount) : '',
    selfBookedHotel: !!draft.hotelSelfBooked,
    selfBookedItineary: !!draft.itinerarySelfBooked,
    guestName: f.guestName,
    guestPhoneNumber: f.guestPhoneNumber,
    TotalAdults: String(f.guestAdults || 0),
    // Also LLM-extracted (extraSystemPrompt) - a bare digit string can come back as a JSON number,
    // same failure mode as roerate/taxAmount above.
    emergencyContact: draft.extraFields.emergencyContact != null ? String(draft.extraFields.emergencyContact) : null,
    bookingBy: draft.extraFields.bookingBy || '',
    // Was missing entirely - extraNote was captured, shown back in the confirmation summary (so it
    // LOOKED saved), but never actually included in the payload sent to the real API. Every note
    // anyone typed through this flow was silently discarded before this fix.
    extraNote: capExtraNote(draft.extraFields.extraNote),
    HotelIds: '',
    ItinearyIds: '',
    // The real site (managebookings.js) submits these as three independent checkboxes
    // (allowVoucher/allowInvoice/allowItinerary) - previously this used one combined
    // allowPdfDownloads flag for all three, so there was no way to allow just one PDF type.
    IsAllowForInvoice: !!draft.extraFields.allowInvoicePdf,
    IsAllowForItinerary: !!draft.extraFields.allowItineraryPdf,
    IsAllowForVoucher: !!draft.extraFields.allowVoucherPdf,
    itinearies,
    inquiryId: 0,
  };
}

async function stepConfirm(draft, userMessage) {
  const yn = parseYesNo(userMessage);
  if (yn === false) {
    return { reply: `Okay, cancelled — nothing was saved.`, draft: null };
  }
  if (yn !== true) {
    return { reply: `Reply "yes" to save this ${draft.kind}, or "no" to cancel.`, draft };
  }
  return trySubmit(draft, true);
}

async function trySubmit(draft, allowSalesEntry) {
  const isBooking = draft.kind === 'booking';
  const model = buildModel(draft);

  let newId;
  try {
    newId = await submitBooking(model, isBooking, { allowSalesEntry });
  } catch (err) {
    if (err.code === 'AGENT_ACCOUNT_NOT_FOUND') {
      draft.phase = 'confirmNoSalesEntry';
      return { reply: `FlyThai couldn't find a matching agent account for sales entry. Save anyway without a sales entry? (yes/no)`, draft };
    }
    return { reply: `I couldn't save this: ${err.message}. Nothing was created — you can try confirming again once that's fixed.`, draft };
  }

  // submitBooking above has ALREADY succeeded - the record is live - so a failure in this lookup
  // must never propagate uncaught. An uncaught throw here would leave draft.phase stuck at
  // 'confirm' (session.draft is only ever updated by the CALLER once step() resolves), so a user
  // who saw a generic error and didn't know the save had actually gone through could reply "yes"
  // again and create a second, duplicate real booking via a second submitBooking() call with the
  // identical payload. Treated the same as the existing "found no row" case below instead.
  let created = null;
  try {
    created = await findBookingById(newId);
  } catch {
    created = null;
  }
  const code = created ? (isBooking ? created.BookingId : created.QuotationId) : null;

  const successMsg = code
    ? `Done! I've created the ${draft.kind} for **${draft.fields.guestName}** — reference **${code}**. You can open it in the Booking panel for any further edits.`
    : `The ${draft.kind} was saved (id ${newId}), but I couldn't look up its reference code — please check the list for "${draft.fields.guestName}".`;

  // Surfaced so chat.js can set session.lastBookingCode to the record just created - otherwise a
  // same-session follow-up like "download this quotation" right after creation kept resolving
  // against whichever OLDER code the user had last typed themselves (lastBookingCode is only ever
  // updated from the user's own message - see chat.js), silently returning a completely different
  // record's document instead of the one just created.
  return { reply: successMsg, draft: null, createdCode: code || undefined };
}

async function stepConfirmNoSalesEntry(draft, userMessage) {
  const yn = parseYesNo(userMessage);
  if (yn === true) return trySubmit(draft, false);
  return { reply: `Okay, cancelled — nothing was saved.`, draft: null };
}

// ---------- dispatcher ----------

// Phases that collect ONE item (a hotel row, a transfer, a restaurant, a pricing line) already
// give "cancel"/"no" a narrower meaning via isCancelItemIntent - "don't add this one", not "throw
// the whole booking away". A bare "cancel" is left to them; only the explicit whole-flow wording
// (isWholeFlowCancel) overrides it there.
const ITEM_LEVEL_CANCEL_PHASES = new Set(['hotelCollect', 'transferCollect', 'transferSelfBookedGate', 'sightseeingCollect', 'sightseeingSelfBookedGate', 'restaurantCollect', 'leisureDayCollect', 'priceCollect']);

function itemLevelCancelApplies(draft) {
  const midItem = !!(draft.currentHotelDraft || draft.currentItemDraft);
  return midItem && ITEM_LEVEL_CANCEL_PHASES.has(draft.phase);
}

async function step(draft, userMessage) {
  // Global escape hatch, checked before any phase handler: without it the only phase that honoured
  // "cancel" was 'basic', so from the hotel question onwards the user was stuck repeating the same
  // prompt with no way back to normal questions.
  if (isWholeFlowCancel(userMessage) || (isBareCancel(userMessage) && !itemLevelCancelApplies(draft))) {
    return {
      reply: `Okay, I've cancelled the new ${draft.kind} — nothing was saved. What would you like to know?`,
      draft: null,
    };
  }

  switch (draft.phase) {
    case 'source':
      return stepSource(draft, userMessage);
    case 'agentPaste':
      return stepAgentPaste(draft, userMessage);
    case 'agentPasteConfirm':
      return stepAgentPasteConfirm(draft, userMessage);
    case 'basic':
      return stepBasic(draft, userMessage);
    case 'agentCreate':
      return stepAgentCreate(draft, userMessage);
    case 'hotelChoice':
      return stepHotelChoice(draft, userMessage);
    case 'hotelCollect':
      return stepHotelCollect(draft, userMessage);
    case 'hotelOptionalCollect':
      return stepHotelOptionalCollect(draft, userMessage);
    case 'hotelAddAnother':
      return stepHotelAddAnother(draft, userMessage);
    case 'itineraryChoice':
      return stepItineraryChoice(draft, userMessage);
    case 'agentQueueContinue':
      return stepAgentQueueContinue(draft, userMessage);
    case 'returnDateConfirm':
      return stepReturnDateConfirm(draft, userMessage);
    case 'confirmItineraryEdit':
      return stepConfirmItineraryEdit(draft, userMessage);
    case 'transferCollect':
      return stepTransferCollect(draft, userMessage);
    case 'transferSelfBookedGate':
      return stepTransferSelfBookedGate(draft, userMessage);
    case 'transferOptionalGate':
      return stepTransferOptionalGate(draft, userMessage);
    case 'transferOptionalCollect':
      return stepTransferOptionalCollect(draft, userMessage);
    case 'sightseeingCollect':
      return stepSightseeingCollect(draft, userMessage);
    case 'sightseeingSelfBookedGate':
      return stepSightseeingSelfBookedGate(draft, userMessage);
    case 'sightseeingOptionalGate':
      return stepSightseeingOptionalGate(draft, userMessage);
    case 'sightseeingOptionalCollect':
      return stepSightseeingOptionalCollect(draft, userMessage);
    case 'leisureDayCollect':
      return stepLeisureDayCollect(draft, userMessage);
    case 'restaurantCollect':
      return stepRestaurantCollect(draft, userMessage);
    case 'restaurantOptionalGate':
      return stepRestaurantOptionalGate(draft, userMessage);
    case 'restaurantOptionalCollect':
      return stepRestaurantOptionalCollect(draft, userMessage);
    case 'priceCollect':
      return stepPriceCollect(draft, userMessage);
    case 'priceCollectAnother':
      return stepPriceCollectAnother(draft, userMessage);
    case 'priceExtras':
      return stepPriceExtras(draft, userMessage);
    case 'extraGate':
      return stepExtraGate(draft, userMessage);
    case 'extraCollect':
      return stepExtraCollect(draft, userMessage);
    case 'confirm':
      return stepConfirm(draft, userMessage);
    case 'confirmNoSalesEntry':
      return stepConfirmNoSalesEntry(draft, userMessage);
    default:
      return { reply: "Something went wrong with this booking draft — let's start over. What would you like to create?", draft: null };
  }
}

module.exports = { step, startDraft, detectCreateIntent, looksLikeStandaloneAgentPaste, parseYesNo, startItineraryEditDraft, askItineraryChoice, nextBasicStep, maxItineraryDay, maxItineraryItemDay, maxKnownItineraryDay };
