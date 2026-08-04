const { callLLM } = require('./llm');
const { findAgent, findDestinations, findHotel, findPickup, findVehicle, findPickupOrParticular, findSightseeing, findRestaurant, listDestinations, listVehicles } = require('./lookups');
const { submitBooking, findBookingById } = require('./bookingApi');
const { isWholeFlowCancel, isBareCancel } = require('./cancel');

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

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

function startDraft(kind) {
  return {
    kind,
    phase: 'basic',
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
      return 'Which travel agent or company is this booked through?';
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

    case 'guestPhoneNumber':
      if (/^same$/i.test(answer) && draft.resolvedAgent && draft.resolvedAgent.Phone) {
        draft.fields.guestPhoneNumber = draft.resolvedAgent.Phone;
      } else {
        draft.fields.guestPhoneNumber = answer;
      }
      break;

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
      if (agents.length === 0) {
        return { reply: `I couldn't find an agent matching "${answer}" — could you check the spelling, or give the exact name?`, draft };
      }
      if (agents.length > 1) {
        const opts = agents.map((a) => `- ${a.Name} (${a.Phone || 'no phone'})`).join('\n');
        return { reply: `A few agents match "${answer}":\n${opts}\nWhich one did you mean? Please reply with the exact name.`, draft };
      }
      draft.resolvedAgent = agents[0];
      draft.fields.agentName = agents[0].Name;
      break;
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

// ---------- phase: hotel (fully deterministic - one field at a time, same reasoning as Basic) ----------

async function stepHotelChoice(draft, userMessage) {
  const wantsAdd = /\b(add|hotel details|book)\b/i.test(userMessage) && !/self.?book/i.test(userMessage);
  const selfBooked = parseYesNo(userMessage) === false || /self.?book/i.test(userMessage);

  if (selfBooked && !wantsAdd) {
    draft.hotelSelfBooked = true;
    draft.phase = 'itineraryChoice';
    return { reply: askItineraryChoice(), draft };
  }
  if (wantsAdd || parseYesNo(userMessage) === true) {
    draft.hotelSelfBooked = false;
    draft.phase = 'hotelCollect';
    draft.currentHotelDraft = {};
    draft.hotelStep = 'destinationName';
    return { reply: hotelStepPrompt('destinationName', draft), draft };
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
    case 'ratePerNight':
      return `What is the rate per night? (just the number - currency defaults to ${draft.fields.currency || 'THB'})`;
    default:
      return '';
  }
}

async function stepHotelCollect(draft, userMessage) {
  const h = draft.currentHotelDraft;
  const answer = userMessage.trim();

  if (isCancelItemIntent(answer)) {
    draft.currentHotelDraft = null;
    if (draft.hotels.length > 0) {
      draft.phase = 'itineraryChoice';
      return { reply: `Okay, not adding this hotel. ${askItineraryChoice()}`, draft };
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
      case 'checkInDate':
        if (!parseDateDDMMYYYY(answer)) {
          return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
        }
        h.checkInDate = answer;
        break;
      case 'checkOutDate': {
        const checkOut = parseDateDDMMYYYY(answer);
        if (!checkOut) {
          return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
        }
        if (checkOut <= parseDateDDMMYYYY(h.checkInDate)) {
          return { reply: 'Check-out date must be after check-in date — could you re-enter it?', draft };
        }
        h.checkOutDate = answer;
        break;
      }
      case 'roomCategory':
        h.roomCategory = answer;
        break;
      case 'totalRooms': {
        const n = parseInt(answer, 10);
        if (!Number.isFinite(n) || n <= 0) return { reply: 'That needs to be a whole number greater than 0 — how many rooms?', draft };
        h.totalRooms = n;
        break;
      }
      case 'ratePerNight': {
        const n = parseFloat(answer);
        if (!Number.isFinite(n) || n < 0) return { reply: 'That needs to be a number — what is the rate per night?', draft };
        h.ratePerNight = n;
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
    draft.currentHotelDraft = {};
    draft.hotelStep = 'destinationName';
    return { reply: hotelStepPrompt('destinationName', draft), draft };
  }
  draft.phase = 'itineraryChoice';
  return { reply: askItineraryChoice(), draft };
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
    if (draft.editMode) return finishItineraryEdit(draft);
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
    if (draft.editMode) return finishItineraryEdit(draft);
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

// Called once the user is done adding items (or picks self-booked). Merges the newly-collected
// items into the EXISTING itinearyDetails by day, leaving every previously-saved day/item exactly
// as GetBookingById returned it - the new items are the only thing built by this codebase, so
// they're the only thing whose shape we need to trust.
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
      return { reply: `Sorry, saving the itinerary failed: ${err.message}`, draft: null };
    }
    try {
      await trySave(false);
    } catch (err2) {
      return { reply: `Sorry, saving the itinerary failed: ${err2.message}`, draft: null };
    }
  }
  return { reply: `Done — itinerary updated for **${code}** (${guestName}).`, draft: null };
}

// Handles one "ask for a name, resolve it via DB lookup, disambiguate if needed" field. Returns
// { resolved: true } once item[fieldKey]/item[rowKey] are set (caller continues to the next
// field), or { reply } if the caller should show that and wait for the next message instead.
async function resolveSequentialLookup(item, fieldKey, rowKey, lookupFn, label, userAnswer) {
  if (item._pendingField === fieldKey) {
    const picked = item._pendingRows.find((o) => o.Name.toLowerCase() === userAnswer.toLowerCase());
    if (!picked) {
      const opts = item._pendingRows.map((o) => `- ${o.Name}`).join('\n');
      return { reply: `Please reply with the exact ${label} from the list:\n${opts}` };
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
    const opts = rows.map((r) => `- ${r.Name}`).join('\n');
    return { reply: `A few ${label} options match "${userAnswer}":\n${opts}\nWhich one did you mean?` };
  }
  item[fieldKey] = rows[0].Name;
  item[rowKey] = rows[0];
  return { resolved: true };
}

const TRANSFER_FIELD_ORDER = ['date', 'pickupPointName', 'dropOffPointName', 'transferName', 'vehicleTypeName'];
const TRANSFER_LOOKUPS = {
  pickupPointName: [findPickup, 'pickup point'],
  dropOffPointName: [findPickup, 'drop-off point'],
  transferName: [findPickupOrParticular, 'transfer name'],
  vehicleTypeName: [findVehicle, 'vehicle type'],
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
    draft.phase = 'itineraryChoice';
    return { reply: `Okay, not adding this transfer. ${askItineraryChoice()}`, draft };
  }

  if (t._pendingField) {
    const [lookupFn, label] = TRANSFER_LOOKUPS[t._pendingField];
    const res = await resolveSequentialLookup(t, t._pendingField, `_${t._pendingField}Row`, lookupFn, label, answer);
    if (!res.resolved) return { reply: res.reply, draft };
  } else {
    switch (draft.itemStep) {
      case 'date':
        if (!parseDateDDMMYYYY(answer)) {
          return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
        }
        t.date = answer;
        break;
      case 'pickupPointName':
      case 'dropOffPointName':
      case 'transferName':
      case 'vehicleTypeName': {
        const [lookupFn, label] = TRANSFER_LOOKUPS[draft.itemStep];
        const res = await resolveSequentialLookup(t, draft.itemStep, `_${draft.itemStep}Row`, lookupFn, label, answer);
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

  draft.phase = 'transferOptionalCollect';
  return { reply: 'Optional: time, number of vehicles, vehicle price, flight no, remarks — e.g. "14:30, 2 vehicles" or "flight AI131". Reply with any of these, or "skip".', draft };
}

function transferOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a transfer itinerary item.
Possible fields: time, numberOfVehicles (number), vehiclePrice (number), flightNo, remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
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
  draft.phase = 'itineraryChoice';
  return { reply: `Added the transfer (${pickup.Name} → ${dropoff.Name}). ${askAddMoreItinerary()}`, draft };
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
      case 'date':
        if (!parseDateDDMMYYYY(answer)) {
          return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
        }
        s.date = answer;
        break;
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

  draft.phase = 'sightseeingOptionalCollect';
  return { reply: 'Optional: number of adults/children going (adult/child price default from the master rate but can be overridden), remarks. Reply with any, or "skip".', draft };
}

function sightseeingOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a sightseeing itinerary item.
Possible fields: totalAdult (number), adultPrice (number, overrides the master rate), totalChild (number), childPrice (number, overrides the master rate), remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
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
  draft.phase = 'itineraryChoice';
  return { reply: `Added the sightseeing (${particular.Name}). ${askAddMoreItinerary()}`, draft };
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
  if (!parseDateDDMMYYYY(answer)) {
    return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
  }

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
  draft.phase = 'itineraryChoice';
  return { reply: `Added a Leisure Day for ${answer}. ${askAddMoreItinerary()}`, draft };
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
      case 'date':
        if (!parseDateDDMMYYYY(answer)) {
          return { reply: 'That needs to be a real date in DD-MM-YYYY format — could you re-enter it?', draft };
        }
        r.date = answer;
        break;
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

  draft.phase = 'restaurantOptionalCollect';
  return { reply: 'Optional: adults/children for lunch and/or dinner (with prices), remarks. Reply with any, or "skip".', draft };
}

function restaurantOptionalSystemPrompt(fields) {
  return `You are collecting OPTIONAL extra details for a restaurant itinerary item.
Possible fields: lunchAdultCount, lunchAdultPrice, lunchChildCount, lunchChildPrice, dinnerAdultCount, dinnerAdultPrice, dinnerChildCount, dinnerChildPrice, remarks.
Fields already known (JSON): ${JSON.stringify(fields)}
Merge only what the user's message actually mentions - this is a single-turn step, don't ask follow-up questions.
Respond with ONLY JSON: {"fields": {...merged...}, "done": true}`;
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
  draft.phase = 'itineraryChoice';
  return { reply: `Added the restaurant (${restaurant.Name}). ${askAddMoreItinerary()}`, draft };
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
      const n = parseInt(answer, 10);
      if (!Number.isFinite(n) || n <= 0) return { reply: 'That needs to be a whole number greater than 0 — how many pax?', draft };
      m.pax = n;
      break;
    }
    case 'price': {
      const n = parseFloat(answer);
      if (!Number.isFinite(n) || n < 0) return { reply: 'That needs to be a number — what is the price per pax?', draft };
      m.price = n;
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
  if (parseYesNo(userMessage) === true) {
    draft.phase = 'priceCollect';
    draft.currentItemDraft = {};
    draft.itemStep = 'type';
    return { reply: memberStepPrompt('type'), draft };
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
  draft.phase = 'extraCollect';
  return { reply: askExtras(), draft };
}

// ---------- phase: extra note / emergency contact / booking by / PDF permissions ----------

function askExtras() {
  return `Last bit (all optional): any extra note, emergency contact, who this is booked by, and should the agent be allowed to download the hotel voucher/invoice/itinerary PDFs? Reply with any of these, or "skip".`;
}

function extraSystemPrompt(fields) {
  return `You are collecting optional final details for a booking: extraNote, emergencyContact, bookingBy, allowPdfDownloads (boolean - whether the agent may download hotel voucher/invoice/itinerary PDFs, default false if not mentioned).
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
    roerate: draft.priceFields.roeRate || '',
    roecharge: draft.priceFields.roeCharge || '',
    taxAmount: draft.priceFields.taxAmount || '',
    taxPercentage: draft.priceFields.taxPercentage || '',
    LandSelling: draft.priceFields.landSelling != null ? String(draft.priceFields.landSelling) : '0',
    LandSellingCurrency: f.currency || 'THB',
    invoiceDueDate: draft.priceFields.invoiceDueDate || '',
    invoiceDiscount: draft.priceFields.invoiceDiscount || '',
    selfBookedHotel: !!draft.hotelSelfBooked,
    selfBookedItineary: !!draft.itinerarySelfBooked,
    guestName: f.guestName,
    guestPhoneNumber: f.guestPhoneNumber,
    TotalAdults: String(f.guestAdults || 0),
    emergencyContact: draft.extraFields.emergencyContact || null,
    bookingBy: draft.extraFields.bookingBy || '',
    HotelIds: '',
    ItinearyIds: '',
    IsAllowForInvoice: !!draft.extraFields.allowPdfDownloads,
    IsAllowForItinerary: !!draft.extraFields.allowPdfDownloads,
    IsAllowForVoucher: !!draft.extraFields.allowPdfDownloads,
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

  const created = await findBookingById(newId);
  const code = created ? (isBooking ? created.BookingId : created.QuotationId) : null;

  const successMsg = code
    ? `Done! I've created the ${draft.kind} for **${draft.fields.guestName}** — reference **${code}**. You can open it in the Booking panel for any further edits.`
    : `The ${draft.kind} was saved (id ${newId}), but I couldn't look up its reference code — please check the list for "${draft.fields.guestName}".`;

  return { reply: successMsg, draft: null };
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
    case 'basic':
      return stepBasic(draft, userMessage);
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
    case 'transferCollect':
      return stepTransferCollect(draft, userMessage);
    case 'transferOptionalCollect':
      return stepTransferOptionalCollect(draft, userMessage);
    case 'sightseeingCollect':
      return stepSightseeingCollect(draft, userMessage);
    case 'sightseeingOptionalCollect':
      return stepSightseeingOptionalCollect(draft, userMessage);
    case 'leisureDayCollect':
      return stepLeisureDayCollect(draft, userMessage);
    case 'restaurantCollect':
      return stepRestaurantCollect(draft, userMessage);
    case 'restaurantOptionalCollect':
      return stepRestaurantOptionalCollect(draft, userMessage);
    case 'priceCollect':
      return stepPriceCollect(draft, userMessage);
    case 'priceCollectAnother':
      return stepPriceCollectAnother(draft, userMessage);
    case 'priceExtras':
      return stepPriceExtras(draft, userMessage);
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

module.exports = { step, startDraft, detectCreateIntent, parseYesNo, startItineraryEditDraft, askItineraryChoice };
