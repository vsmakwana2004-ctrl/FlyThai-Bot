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

// Strict 24-hour HH:MM, matching the real Add Sightseeing form's time input.
function parseTimeHHMM(str) {
  if (!str || typeof str !== 'string') return null;
  return /^([01]\d|2[0-3]):([0-5]\d)$/.test(str.trim()) ? str.trim() : null;
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
const BASIC_FIELD_ORDER = ['guestName', 'agentName', 'guestPhoneNumber', 'guestEmail', 'destinationNames', 'travelDate', 'returnDate'];

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
    case 'returnDate':
      return 'What is the return date? (format DD-MM-YYYY)';
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
  return { reply: basicNextPrompt(draft), draft };
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
- destinationNames: array of destination names (from the list above) the trip covers, in visiting order if determinable - only ones actually named in the message
- travelDate: DD-MM-YYYY, only if clearly stated or unambiguously computable as described above
- returnDate: DD-MM-YYYY, only if clearly stated or unambiguously computable as described above
- guestAdults: number of adults, only if a number of adults is explicitly stated
- guestChildrens: number of children, only if explicitly stated - do NOT default to 0 just because adults were mentioned without children being mentioned; omit this field instead
- guestInfants: number of infants, only if explicitly stated - same rule, do NOT default to 0
- itineraryLines: if the message has a day-by-day plan ("Day 1: ...", "Day 2: ...", etc), one entry per day-line: {"day": <number>, "type": "transfer" | "sightseeing" | "leisure", "pickupHint": <short literal place name to search for as the start point - transfer only, else null>, "dropoffHint": <short literal place name to search for as the end point - transfer only, else null>, "transferNameHint": <a short generic transfer label like "Airport to Hotel", "Hotel to Airport", "Inter Hotel Transfer" - transfer only, else null>, "activityHint": <short literal name of the tour/activity - sightseeing only, else null>}. A day that's explicitly a free/leisure day is type "leisure" (no hints needed - and don't invent an activity for it). A day that moves between an airport and a hotel, or between two hotels/islands, is type "transfer". A day naming a specific activity/tour is type "sightseeing". If one day's line actually describes TWO separate movements (e.g. "X to Y transfer + A to B transfer"), emit TWO entries with that same day number. These hints are only used to search real records already in the system - if nothing matches, that one field is simply asked about normally afterwards, so keep each hint a short literal place/activity name, not a full sentence, and never invent one that isn't grounded in the text.
- hotelPreferences: array of {"destinationName": <one of the known destinations above>, "hotelName": <the specific hotel name mentioned for that destination, with qualifiers like "or similar"/"or similar category" stripped off>} for each destination where the message names a preferred/requested hotel. Omit a destination entirely if no specific hotel name is given for it.
- notes: a thorough plain-text summary of everything else mentioned that isn't already captured above - hotel categories requested (star rating etc, not a specific name - those go in hotelPreferences), room-wise pax breakdown (including any children's ages), special requests (gala dinner, pool party, shows, etc). This is kept as a reference note for staff, so include detail rather than drop it - unlike the fields above, being thorough here carries no risk since nothing here is auto-saved into a structured field.

Respond with ONLY JSON: {"guestName": ..., "destinationNames": [...], "travelDate": ..., "returnDate": ..., "guestAdults": ..., "guestChildrens": ..., "guestInfants": ..., "itineraryLines": [...], "hotelPreferences": [...], "notes": "..."}`;
}

// Builds the shared "what's still missing" prompt used both when the agent-provided extraction is
// accepted (stepAgentPasteConfirm) and when nothing usable was extracted at all (stepAgentPaste) -
// same end-of-basic-phase logic stepBasic itself uses (nextBasicStep -> pax question -> hotel
// choice), duplicated here rather than shared so stepBasic's own manual-flow code path is never
// touched by this feature.
function basicNextPrompt(draft) {
  const next = nextBasicStep(draft);
  if (next) {
    draft.basicCurrentStep = next;
    return basicStepPrompt(next, draft);
  }
  if (!draft.basicPaxAsked) {
    draft.basicPaxAsked = true;
    draft.basicCurrentStep = 'travelCount';
    return 'How many Adults/Children/Infants are travelling? e.g. "4 adults, 1 child" (optional — reply "skip" to leave this for now)';
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

  const travelDateObj = parsed.travelDate ? parseDateDDMMYYYY(parsed.travelDate) : null;
  if (travelDateObj && travelDateObj >= todayDateObjIST()) {
    staged.travelDate = parsed.travelDate;
    filled.push(`Travel Date: ${parsed.travelDate}`);
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

  // Day-by-day itinerary lines and per-destination hotel preferences - also staged, not applied,
  // until the same yes/no gate below. Only well-formed entries are kept (a real day number and a
  // recognised type) - anything the model returned outside that shape is dropped rather than risk
  // acting on it. Actually resolving these against real hotel/pickup/transfer/sightseeing records
  // happens later, lazily, once the itinerary/hotel phase is actually reached (see
  // processAgentItineraryQueue and applyAgentHotelPreference) - never here, and never against
  // anything other than the same lookup functions/matching rules the manual flow itself uses.
  const itineraryLines = Array.isArray(parsed.itineraryLines)
    ? parsed.itineraryLines.filter((l) => l && Number.isFinite(Number(l.day)) && ['transfer', 'sightseeing', 'leisure'].includes(l.type))
    : [];
  const hotelPreferences = Array.isArray(parsed.hotelPreferences)
    ? parsed.hotelPreferences.filter((p) => p && p.destinationName && p.hotelName)
    : [];
  if (itineraryLines.length > 0) {
    filled.push(`Itinerary: ${itineraryLines.length} day-item(s) detected — I'll try to build these automatically once we reach that step, and only ask about whatever doesn't match a real record.`);
  }
  if (hotelPreferences.length > 0) {
    filled.push(`Hotel preferences: ${hotelPreferences.map((p) => `${p.destinationName} → ${p.hotelName}`).join(', ')}`);
  }

  // Free-text reference note - not a structured field the rest of the flow trusts or acts on, so
  // it's kept regardless of whether the human accepts/rejects the structured fields above.
  if (parsed.notes && String(parsed.notes).trim()) {
    const note = String(parsed.notes).trim();
    draft.extraFields.extraNote = draft.extraFields.extraNote ? `${draft.extraFields.extraNote}\n${note}` : note;
  }
  draft.agentRawMessage = answer;

  if (filled.length === 0) {
    draft.basicStarted = true;
    draft.phase = 'basic';
    const prompt = basicNextPrompt(draft);
    return { reply: `I couldn't confidently pull any structured details from that message, so I'll ask for everything as usual.\n\n${prompt}`, draft };
  }

  draft._pendingAgentExtract = { fields: staged, resolvedDestinations, basicPaxAsked: stagedPaxAsked, itineraryLines, hotelPreferences };
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
  }
  // yn === false: staged data is simply discarded - draft.fields is untouched, so every field just
  // gets asked about normally below, same as if nothing had ever been extracted.

  draft.basicStarted = true;
  draft.phase = 'basic';
  const prompt = basicNextPrompt(draft);
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
// preferred hotel for that destination and, if so, pre-fills it onto the in-progress hotel draft.
async function applyAgentHotelPreference(draft, h) {
  if (!draft._agentHotelPrefs || !h._destId) return false;
  const dest = draft.resolvedDestinations.find((d) => d.Id === h._destId);
  if (!dest) return false;
  const pref = draft._agentHotelPrefs.find((p) => p.destinationName && dest.Name.toLowerCase() === String(p.destinationName).toLowerCase());
  if (!pref) return false;
  const resolved = await tryResolveHotelName(pref.hotelName);
  if (!resolved) return false;
  h.hotelName = resolved.hotelName;
  h._resolvedHotelId = resolved.resolvedHotelId;
  return true;
}

async function tryResolvePoint(hint) {
  if (!hint) return null;
  const rows = await findPickup(hint);
  return rows.length === 1 ? rows[0] : null;
}

async function tryResolveTransferParticular(hint) {
  if (!hint) return null;
  const rows = await findPickupOrParticular(hint);
  return rows.length === 1 ? rows[0] : null;
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
    if (!draft.vehicleOptions) draft.vehicleOptions = await listVehicles();
    const t = { date: dateStr };
    const matched = [];
    const pickup = await tryResolvePoint(line.pickupHint);
    if (pickup) { t.pickupPointName = pickup.Name; t._pickupPointNameRow = pickup; matched.push(`pickup: ${pickup.Name}`); }
    const dropoff = await tryResolvePoint(line.dropoffHint);
    if (dropoff) { t.dropOffPointName = dropoff.Name; t._dropOffPointNameRow = dropoff; matched.push(`drop-off: ${dropoff.Name}`); }
    // Real transfer master records are named "<Pickup Point> to <Drop-off Point>" (verified live
    // against the DB, e.g. "Phuket Airport to Phuket Hotel") - once both points are themselves
    // resolved to real records, searching on their exact names together is far more reliable than
    // the model's own free-text transferNameHint guess, which is only used as a fallback.
    const particularQuery = pickup && dropoff ? `${pickup.Name} to ${dropoff.Name}` : line.transferNameHint || line.pickupHint;
    const particular = await tryResolveTransferParticular(particularQuery);
    if (particular) { t.transferName = particular.Name; t._transferNameRow = particular; matched.push(`transfer: ${particular.Name}`); }

    draft.phase = 'transferCollect';
    draft.currentItemDraft = t;
    const next = TRANSFER_FIELD_ORDER.find((k) => t[k] === undefined || t[k] === null || t[k] === '');
    const matchedNote = matched.length > 0 ? ` (auto-matched ${matched.join(', ')})` : '';
    if (!next) {
      draft.phase = 'transferOptionalCollect';
      return { reply: `${prefix}${leisureNote}Day ${line.day} (${dateStr}) — transfer auto-matched${matchedNote}. Optional: time, number of vehicles, vehicle price, flight no, remarks. Reply with any of these, or "skip".`, draft };
    }
    draft.itemStep = next;
    return { reply: `${prefix}${leisureNote}Day ${line.day} (${dateStr}) — transfer from the message${matchedNote}. ${transferStepPrompt(next, draft)}`, draft };
  }

  if (line.type === 'sightseeing') {
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
      return { reply: `${prefix}${leisureNote}Day ${line.day} (${dateStr}) — sightseeing auto-matched${matchedNote}. Optional: number of adults/children going, remarks. Reply with any, or "skip".`, draft };
    }
    draft.itemStep = next;
    return { reply: `${prefix}${leisureNote}Day ${line.day} (${dateStr}) — sightseeing from the message${matchedNote}. ${sightseeingStepPrompt(next)}`, draft };
  }

  // Only transfer/sightseeing/leisure are ever queued (see the filter in stepAgentPaste) - nothing
  // else should reach here, but fall through safely (continue the queue) rather than get stuck.
  return processAgentItineraryQueue(draft, prefix + leisureNote);
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
      const maxDay = maxItineraryDay(draft);
      if (maxDay && travelDateObj) {
        const minReturnObj = addDaysToDateObj(travelDateObj, maxDay - 1);
        if (returnDateObj < minReturnObj) {
          const minReturnStr = `${String(minReturnObj.getDate()).padStart(2, '0')}-${String(minReturnObj.getMonth() + 1).padStart(2, '0')}-${minReturnObj.getFullYear()}`;
          return { reply: `The itinerary runs through Day ${maxDay}, so the return date can't be before ${minReturnStr} — could you re-enter it?`, draft };
        }
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
  if (next) {
    draft.basicCurrentStep = next;
    return { reply: basicStepPrompt(next, draft), draft };
  }

  if (!draft.basicPaxAsked) {
    draft.basicPaxAsked = true;
    draft.basicCurrentStep = 'travelCount';
    return { reply: 'How many Adults/Children/Infants are travelling? e.g. "4 adults, 1 child" (optional — reply "skip" to leave this for now)', draft };
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
      return { reply: `${notice}\n\n${basicNextPrompt(draft)}`, draft };
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
  return { reply: basicNextPrompt(draft), draft };
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
    // Travel-agent-sourced draft only (see applyAgentHotelPreference) - no-op for a manual one.
    const usedPref = await applyAgentHotelPreference(draft, h);
    if (usedPref) {
      const next = HOTEL_FIELD_ORDER.find((k) => h[k] === undefined || h[k] === null || h[k] === '');
      draft.hotelStep = next;
      return `Using **${h.hotelName}** for ${h.destinationName} (from the message). ${hotelStepPrompt(next, draft)}`;
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
        // No-op for a manual draft (see applyAgentHotelPreference).
        await applyAgentHotelPreference(draft, h);
        break;
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
  return { reply: 'Optional for this hotel: breakfast option, adults/children/infants staying, currency (default THB), address/contact/email/remarks, sharing type. Reply with any of these, or "skip".', draft };
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
  return `Now the itinerary — the real form requires at least one item (unless self-booked). Would you like to add a **Transfer** (e.g. airport pickup/drop), **Sightseeing**, a **Restaurant**, or mark it a **Leisure Day**? Or reply "self-booked" if the guest is arranging their own itinerary.`;
}

async function stepItineraryChoice(draft, userMessage) {
  const t = userMessage.toLowerCase();
  // "self-booked" is the ONLY thing that should set itinerarySelfBooked - it must not be
  // conflated with "done adding items" (parseYesNo treats "done" as a no-ish answer, which
  // previously tripped this same branch even after real items had already been added, silently
  // flagging self-booked while still sending real itinerary data - a real bug found via a live test).
  if (/self.?book/i.test(t)) {
    draft.itinerarySelfBooked = true;
    if (draft.editMode) return askConfirmItineraryEdit(draft);
    draft.phase = 'priceCollect';
    return { reply: askAddMembers(), draft };
  }
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
    draft.phase = 'priceCollect';
    return { reply: askAddMembers(), draft };
  }
  return {
    reply: `The real form needs at least one itinerary item. Please reply "transfer", "sightseeing", "restaurant", "leisure", or "self-booked".`,
    draft,
  };
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
  const patched = {
    ...raw,
    itinearyDetails: merged,
    itinearies,
    selfBookedItineary: draft.itinerarySelfBooked || !!raw.selfBookedItineary,
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

const TRANSFER_FIELD_ORDER = ['date', 'pickupPointName', 'dropOffPointName', 'transferName', 'vehicleTypeName'];
const TRANSFER_LOOKUPS = {
  pickupPointName: [findPickup, 'pickup point'],
  dropOffPointName: [findPickup, 'drop-off point'],
  transferName: [findPickupOrParticular, 'transfer name'],
  vehicleTypeName: [findVehicle, 'vehicle type', formatVehicleOption],
};

function transferStepPrompt(stepKey, draft) {
  switch (stepKey) {
    case 'date':
      return 'What date is this transfer? (DD-MM-YYYY)';
    case 'pickupPointName':
      return 'What is the pickup point?';
    case 'dropOffPointName':
      return 'What is the drop-off point?';
    case 'transferName':
      return 'What is the transfer code or name (e.g. "061" or "Airport to Hotel")?';
    case 'vehicleTypeName':
      return `What vehicle type? Available: ${draft.vehicleOptions.map((v) => v.Name).join(', ')}`;
    default:
      return '';
  }
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
      default:
        break;
    }
  }

  const next = TRANSFER_FIELD_ORDER.find((k) => t[k] === undefined || t[k] === null || t[k] === '');
  if (next) {
    draft.itemStep = next;
    return { reply: transferStepPrompt(next, draft), draft };
  }

  draft.phase = 'transferOptionalGate';
  return { reply: askTransferOptionalGate(), draft };
}

function transferOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a transfer itinerary item.
Possible fields: time, numberOfVehicles (number), vehiclePrice (number), flightNo, remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
}

// One-tap gate before the actual optional-details form - most transfers need none of this, so
// staff with nothing to add skip straight to "item added" instead of being shown a form to skip.
// Same pattern as askExtraGate()/stepExtraGate() below for the final booking-level extras.
function askTransferOptionalGate() {
  return `Want to add optional details for this transfer — time, number of vehicles, vehicle price, flight no, remarks?`;
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
      return 'What time? (24-hour HH:MM, e.g. "09:30")';
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
    const res = await resolveSequentialLookup(s, 'sightseeingName', '_sightseeingNameRow', sightseeingLookup, 'sightseeing', answer);
    if (!res.resolved) return { reply: res.reply, draft };
  } else {
    switch (draft.itemStep) {
      case 'date': {
        const err = validateItineraryItemDate(answer, draft);
        if (err) return { reply: err, draft };
        s.date = answer;
        break;
      }
      case 'time':
        if (!parseTimeHHMM(answer)) {
          return { reply: 'That needs to be a real 24-hour time in HH:MM format (e.g. "09:30") — could you re-enter it?', draft };
        }
        s.time = answer;
        break;
      case 'pickupPointName': {
        const res = await resolveSequentialLookup(s, 'pickupPointName', '_pickupPointNameRow', findPickup, 'pickup point', answer);
        if (!res.resolved) return { reply: res.reply, draft };
        break;
      }
      case 'sightseeingName': {
        const res = await resolveSequentialLookup(s, 'sightseeingName', '_sightseeingNameRow', sightseeingLookup, 'sightseeing', answer);
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
  return { reply: askSightseeingOptionalGate(), draft };
}

function sightseeingOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a sightseeing itinerary item.
Possible fields: totalAdult (number), adultPrice (number, overrides the master rate), totalChild (number), childPrice (number, overrides the master rate), remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
}

// See askTransferOptionalGate/stepTransferOptionalGate above for the pattern this mirrors.
function askSightseeingOptionalGate() {
  return `Want to add optional details for this sightseeing — number of adults/children going, remarks?`;
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
  const totalAdult = Number(s.totalAdult) || 0;
  const totalChild = Number(s.totalChild) || 0;
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

const RESTAURANT_FIELD_ORDER = ['date', 'restaurantName'];

function restaurantStepPrompt(stepKey) {
  switch (stepKey) {
    case 'date':
      return 'What date is this restaurant for? (DD-MM-YYYY)';
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
  return { reply: askRestaurantOptionalGate(), draft };
}

function restaurantOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a restaurant itinerary item.
Possible fields: lunchAdultCount, lunchAdultPrice, lunchChildCount, lunchChildPrice, dinnerAdultCount, dinnerAdultPrice, dinnerChildCount, dinnerChildPrice, remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
}

// See askTransferOptionalGate/stepTransferOptionalGate above for the pattern this mirrors.
function askRestaurantOptionalGate() {
  return `Want to add optional details for this restaurant — adults/children for lunch and/or dinner (with prices), remarks?`;
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
  const lunchAdultCount = Number(r.lunchAdultCount) || 0;
  const lunchAdultPrice = r.lunchAdultPrice != null ? Number(r.lunchAdultPrice) : Number(restaurant.LunchPriceForAdults) || 0;
  const lunchChildCount = Number(r.lunchChildCount) || 0;
  const lunchChildPrice = Number(r.lunchChildPrice) || 0;
  const dinnerAdultCount = Number(r.dinnerAdultCount) || 0;
  const dinnerAdultPrice = r.dinnerAdultPrice != null ? Number(r.dinnerAdultPrice) : Number(restaurant.DinnerPriceForAdults) || 0;
  const dinnerChildCount = Number(r.dinnerChildCount) || 0;
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
    time: null,
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
      if (item.type === 'transfer') {
        out += `- Day ${item.dayNumber} (${item.date}): Transfer — ${item.pickupPointName} → ${item.dropOffPointName}, ${item.vehicleName}\n`;
      } else if (item.type === 'sightseeing' && item.selfBooked) {
        out += `- Day ${item.dayNumber} (${item.date}): Leisure Day\n`;
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
    extraNote: draft.extraFields.extraNote || '',
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
const ITEM_LEVEL_CANCEL_PHASES = new Set(['hotelCollect', 'transferCollect', 'sightseeingCollect', 'restaurantCollect', 'leisureDayCollect', 'priceCollect']);

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
    case 'confirmItineraryEdit':
      return stepConfirmItineraryEdit(draft, userMessage);
    case 'transferCollect':
      return stepTransferCollect(draft, userMessage);
    case 'transferOptionalGate':
      return stepTransferOptionalGate(draft, userMessage);
    case 'transferOptionalCollect':
      return stepTransferOptionalCollect(draft, userMessage);
    case 'sightseeingCollect':
      return stepSightseeingCollect(draft, userMessage);
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

module.exports = { step, startDraft, detectCreateIntent, looksLikeStandaloneAgentPaste, parseYesNo, startItineraryEditDraft, askItineraryChoice, nextBasicStep, maxItineraryDay };
