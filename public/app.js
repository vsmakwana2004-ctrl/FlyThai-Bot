const messagesEl = document.getElementById('messages'); // scroll container (full width)
const messagesInner = document.getElementById('messagesInner'); // centered content column, inside messagesEl
const form = document.getElementById('chatForm');
const input = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const suggestions = document.getElementById('suggestions');
const quickReplies = document.getElementById('quickReplies');
const clearBtn = document.getElementById('clearBtn');
const lookupDropdown = document.getElementById('lookupDropdown');
const datePickerBox = document.getElementById('datePickerBox');
const calPrev = document.getElementById('calPrev');
const calNext = document.getElementById('calNext');
const calTitle = document.getElementById('calTitle');
const calGrid = document.getElementById('calGrid');
const timePickerBox = document.getElementById('timePickerBox');
const timeGrid = document.getElementById('timeGrid');
const paxPickerBox = document.getElementById('paxPickerBox');
const paxAdultsInput = document.getElementById('paxAdults');
const paxChildrenInput = document.getElementById('paxChildren');
const paxInfantsInput = document.getElementById('paxInfants');
const calBackToForm = document.getElementById('calBackToForm');
const priceExtrasBox = document.getElementById('priceExtrasBox');
const peRoeRate = document.getElementById('peRoeRate');
const peRoeCharge = document.getElementById('peRoeCharge');
const peTaxAmount = document.getElementById('peTaxAmount');
const peTaxPercentage = document.getElementById('peTaxPercentage');
const peDiscount = document.getElementById('peDiscount');
const peFinalRate = document.getElementById('peFinalRate');
const peDueDateBtn = document.getElementById('peDueDateBtn');
const peDueDateLabel = document.getElementById('peDueDateLabel');
const peSkipBtn = document.getElementById('peSkipBtn');
const extraDetailsBox = document.getElementById('extraDetailsBox');
const itineraryOptionalBox = document.getElementById('itineraryOptionalBox');
const itineraryOptionalFields = document.getElementById('itineraryOptionalFields');
const edNote = document.getElementById('edNote');
const edContactChips = document.getElementById('edContactChips');
const edBookingBy = document.getElementById('edBookingBy');
const edAllowVoucher = document.getElementById('edAllowVoucher');
const edAllowInvoice = document.getElementById('edAllowInvoice');
const edAllowItinerary = document.getElementById('edAllowItinerary');
const charCount = document.getElementById('charCount');
const layoutEl = document.getElementById('layout');
const historySidebar = document.getElementById('historySidebar');
const historyList = document.getElementById('historyList');
const sidebarToggleBtn = document.getElementById('sidebarToggleBtn');
const dataDrawer = document.getElementById('dataDrawer');
const dataDrawerTitle = document.getElementById('dataDrawerTitle');
const dataDrawerBody = document.getElementById('dataDrawerBody');
const dataDrawerClose = document.getElementById('dataDrawerClose');

const MAX_MESSAGE_CHARS = 2000; // must match MAX_MESSAGE_CHARS in server.js
const INPUT_MAX_HEIGHT = 160; // px - #chatInput grows to fit pasted multi-line text up to this, then scrolls

// The server always answers /api/* with JSON, but a proxy, a dropped connection or a crash can
// still put HTML or nothing at all on the wire. Parsing blindly turned those into
// "Could not connect to the server: Unexpected token '<'", which told the user nothing useful.
function friendlyHttpError(status) {
  if (status === 413) return `That message is too large to send. Please shorten it to under ${MAX_MESSAGE_CHARS} characters.`;
  if (status === 429) return 'The AI service hit its rate limit. Please wait a few seconds and ask again.';
  if (status === 404) return 'The server could not find that address — try reloading the page.';
  if (status === 502 || status === 503 || status === 504) return 'The server is unavailable right now. Please try again in a moment.';
  if (status >= 500) return 'The server ran into a problem. Please try again in a moment.';
  return 'The server sent an unexpected response. Please try again.';
}

async function readJsonResponse(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    return { error: friendlyHttpError(res.status) };
  }
}

// Live lookup dropdowns - shows real registered records above the input while the bot is asking
// for that field, same idea as the real site's own autocomplete fields (agent/company, hotel name).
const LOOKUP_ENDPOINTS = {
  agent: '/api/agents',
  hotel: '/api/hotels',
  pickup: '/api/pickups',
  transfer: '/api/transfers',
  sightseeing: '/api/sightseeing',
  restaurant: '/api/restaurants',
  vehicle: '/api/vehicles',
  destination: '/api/destinations',
  roomType: '/api/hotel-room-types',
};
const LOOKUP_EMPTY_TEXT = {
  agent: 'No matching agents found',
  hotel: 'No matching hotels found',
  pickup: 'No matching pickup/drop-off points found',
  transfer: 'No matching transfers found',
  sightseeing: 'No matching sightseeing options found',
  restaurant: 'No matching restaurants found',
  vehicle: 'No matching vehicle types found',
  destination: 'No matching destinations found',
  roomType: 'No registered room types for this hotel — just type the category',
};
let currentExpecting = null; // { field, params, multi } | null
let lookupDebounceTimer = null;
let lookupItems = [];
let lookupActiveIndex = -1;
// Multi-select destination checklist state (Id -> Name) - lets the user tick several destinations
// instead of typing a comma-separated list by hand. Cleared whenever the field stops being asked.
let selectedDestinations = new Map();

// Transfers show their code as part of the main label (mirrors the real form's separate
// Transfer Code column) rather than buried in the sub-line, since staff often search by code.
// Destinations show their short code the same way the real form's checkbox labels do ("Bangkok (BKK)").
function lookupItemLabel(item) {
  if (item.Code) return `${item.Code} — ${item.Name}`;
  if (item.ShortCode) return `${item.Name} (${item.ShortCode})`;
  return item.Name;
}

// Keeps the chat input in sync with the ticked checkboxes - checking a box adds its name, unticking
// removes it, and the ordinary Send/Enter path submits whatever ends up in the box.
function syncDestinationInputValue() {
  input.value = Array.from(selectedDestinations.values()).join(', ');
  updateCharCount();
}

// Every popover above the input (lookup dropdown, calendar, pax spinners, pricing-extras form) is
// position:absolute and floats upward out of .chat-bottom's own box - with nothing reserving that
// space, it renders on top of (hiding) whichever chat messages happen to be scrolled to the bottom,
// including the very question it's answering. Reserving that height as extra scroll padding, then
// re-scrolling to the true bottom, keeps the latest message visible above the popover instead.
const MESSAGES_BASE_PADDING_BOTTOM = 32; // must match .messages-inner's own CSS padding-bottom
function reserveSpaceForVisiblePopover() {
  const popovers = [lookupDropdown, datePickerBox, timePickerBox, paxPickerBox, priceExtrasBox, extraDetailsBox, itineraryOptionalBox];
  const visible = popovers.find((el) => el.style.display && el.style.display !== 'none');
  const extra = visible ? visible.offsetHeight + 12 : 0; // +12 matches the popover's own margin-bottom
  messagesInner.style.paddingBottom = extra ? `${MESSAGES_BASE_PADDING_BOTTOM + extra}px` : '';
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function lookupItemSub(item) {
  // Agents show a phone number; hotels show their destination; vehicles show their seating
  // capacity; restaurants show their address; room types show their own rate per night. Pickup/
  // drop-off points and transfers (code already in the main label) show nothing.
  if (item.Phone) return item.Phone;
  if (item.Destination) return item.Destination;
  if (item.Capacity != null) return `Capacity: ${item.Capacity}`;
  if (item.Address) return item.Address;
  if (item.RatePerNight != null) return `${item.RatePerNight} ${item.Currency || ''}`.trim();
  return '';
}

function renderLookupDropdown(items, emptyText, multi) {
  lookupItems = items;
  lookupActiveIndex = -1;

  if (items.length === 0) {
    lookupDropdown.innerHTML = `<div class="lookup-empty">${escapeHtml(emptyText || 'No matches')}</div>`;
  } else if (multi) {
    const rows = items
      .map((item) => {
        const id = String(item.Id);
        const checked = selectedDestinations.has(id);
        return `<div class="lookup-item lookup-item-multi${checked ? ' checked' : ''}" data-id="${id}" data-name="${escapeHtml(item.Name)}">
          <span class="lookup-checkbox" aria-hidden="true"></span>
          <span>${escapeHtml(lookupItemLabel(item))}</span>
        </div>`;
      })
      .join('');
    const count = selectedDestinations.size;
    lookupDropdown.innerHTML = `<div class="lookup-multi-list">${rows}</div><div class="lookup-multi-footer">${
      count ? `${count} selected — press Enter to submit` : 'Tick one or more destinations'
    }</div>`;
  } else {
    lookupDropdown.innerHTML = items
      .map((item, i) => {
        const sub = lookupItemSub(item);
        return `<div class="lookup-item" data-index="${i}">${escapeHtml(lookupItemLabel(item))}${sub ? `<div class="lookup-item-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
      })
      .join('');
  }
  lookupDropdown.style.display = 'block';
  reserveSpaceForVisiblePopover();
}

function hideLookupDropdown() {
  lookupDropdown.style.display = 'none';
  lookupDropdown.innerHTML = '';
  lookupItems = [];
  lookupActiveIndex = -1;
  reserveSpaceForVisiblePopover();
}

async function fetchLookupOptions(expecting, query) {
  if (!expecting) return;
  const { field, params, multi, options } = expecting;

  // Some fields (e.g. a hotel row's destination, scoped to just this trip's own destinations)
  // come as a small list already resolved server-side - filter it client-side instead of hitting
  // an API endpoint at all.
  if (options) {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? options.filter((o) => o.Name.toLowerCase().includes(q) || (o.ShortCode && o.ShortCode.toLowerCase().includes(q)))
      : options;
    renderLookupDropdown(filtered, LOOKUP_EMPTY_TEXT[field], multi);
    return;
  }

  const endpoint = LOOKUP_ENDPOINTS[field];
  if (!endpoint) return;
  try {
    const qs = new URLSearchParams({ q: query, ...(params || {}) });
    const res = await fetch(`${endpoint}?${qs.toString()}`);
    const data = await res.json();
    const key = Object.keys(data).find((k) => Array.isArray(data[k]));
    renderLookupDropdown(key ? data[key] : [], LOOKUP_EMPTY_TEXT[field], multi);
  } catch (err) {
    hideLookupDropdown();
  }
}

// Real calendar picker for travel/return/check-in/check-out date steps, in place of typing
// "DD-MM-YYYY" by hand - styled to match the real FlyThai site's own travel-date calendar rather
// than each browser's inconsistent native <input type="date"> control. params.min/max (YYYY-MM-DD
// strings from the server) disable day cells outside that range - e.g. a hotel's check-in/check-out
// can't fall before the trip's travel date or after its return date.
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
let calendarViewYear = null;
let calendarViewMonth = null; // 0-based
let calendarMinDate = null; // Date (day precision) - cells before this are disabled
let calendarMaxDate = null; // Date (day precision) - cells after this are disabled

function pad2(n) {
  return String(n).padStart(2, '0');
}

function dateKey(d) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function isoToDateOnly(iso) {
  if (!iso) return null;
  const [y, m, d] = iso.split('-').map(Number);
  return new Date(y, m - 1, d);
}

function renderCalendarGrid() {
  calTitle.textContent = `${MONTH_NAMES[calendarViewMonth]} ${calendarViewYear}`;
  const startWeekday = new Date(calendarViewYear, calendarViewMonth, 1).getDay();
  const daysInMonth = new Date(calendarViewYear, calendarViewMonth + 1, 0).getDate();
  const daysInPrevMonth = new Date(calendarViewYear, calendarViewMonth, 0).getDate();
  const totalCells = Math.ceil((startWeekday + daysInMonth) / 7) * 7;
  const todayKey = dateKey(new Date());

  const cells = [];
  for (let i = 0; i < totalCells; i++) {
    const dayNum = i - startWeekday + 1;
    let date;
    let muted;
    if (dayNum < 1) {
      date = new Date(calendarViewYear, calendarViewMonth - 1, daysInPrevMonth + dayNum);
      muted = true;
    } else if (dayNum > daysInMonth) {
      date = new Date(calendarViewYear, calendarViewMonth + 1, dayNum - daysInMonth);
      muted = true;
    } else {
      date = new Date(calendarViewYear, calendarViewMonth, dayNum);
      muted = false;
    }
    cells.push({ date, muted });
  }

  calGrid.innerHTML = cells
    .map(({ date, muted }) => {
      const key = dateKey(date);
      const disabled = muted || (calendarMinDate && date < calendarMinDate) || (calendarMaxDate && date > calendarMaxDate);
      const cls = ['cal-day'];
      if (muted) cls.push('cal-day-muted');
      if (!muted && key === todayKey) cls.push('cal-day-today');
      return `<button type="button" class="${cls.join(' ')}" data-date="${key}"${disabled ? ' disabled' : ''}>${date.getDate()}</button>`;
    })
    .join('');
}

function showDatePicker(params) {
  calendarMinDate = isoToDateOnly(params && params.min);
  calendarMaxDate = isoToDateOnly(params && params.max);
  const start = calendarMinDate || new Date();
  calendarViewYear = start.getFullYear();
  calendarViewMonth = start.getMonth();
  renderCalendarGrid();
  datePickerBox.style.display = 'block';
  reserveSpaceForVisiblePopover();
}

function hideDatePicker() {
  datePickerBox.style.display = 'none';
  reserveSpaceForVisiblePopover();
}

calPrev.addEventListener('click', () => {
  calendarViewMonth--;
  if (calendarViewMonth < 0) {
    calendarViewMonth = 11;
    calendarViewYear--;
  }
  renderCalendarGrid();
  reserveSpaceForVisiblePopover(); // a 5-row vs 6-row month changes the popover's height slightly
});

calNext.addEventListener('click', () => {
  calendarViewMonth++;
  if (calendarViewMonth > 11) {
    calendarViewMonth = 0;
    calendarViewYear++;
  }
  renderCalendarGrid();
  reserveSpaceForVisiblePopover();
});

// Common 30-min tour-start slots (05:00-23:30) - covers the vast majority of real answers to "what
// time?" in one click, same interaction as a calendar day (click -> send immediately). Anything
// off-grid (e.g. "09:15") is still just typed into the composer as before - this never replaces that.
function renderTimeGrid() {
  const slots = [];
  for (let h = 5; h <= 23; h++) {
    slots.push(`${pad2(h)}:00`, `${pad2(h)}:30`);
  }
  timeGrid.innerHTML = slots.map((t) => `<button type="button" class="time-slot" data-time="${t}">${t}</button>`).join('');
}

function showTimePicker() {
  renderTimeGrid();
  timePickerBox.style.display = 'block';
  reserveSpaceForVisiblePopover();
}

function hideTimePicker() {
  timePickerBox.style.display = 'none';
  reserveSpaceForVisiblePopover();
}

timeGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.time-slot');
  if (!btn) return;
  hideTimePicker();
  sendMessage(btn.dataset.time);
});

// Adults/children/infants step gets three number spinners instead of typing "4 adults, 1 child" -
// digits only (native number input plus a keydown filter blocking e/+/-/.), adults floored at 1
// since a booking needs at least one adult traveller. Every change re-syncs the chat input text so
// the existing Send/Enter path (and the backend's own regex parsing) is untouched.
function clampPax(el, min) {
  const v = parseInt(el.value, 10);
  el.value = String(Number.isNaN(v) || v < min ? min : v);
}

function blockNonDigitKeys(e) {
  if (['e', 'E', '+', '-', '.'].includes(e.key)) e.preventDefault();
}

function pluralize(n, singular, plural) {
  return `${n} ${n === 1 ? singular : plural}`;
}

function syncPaxInputValue() {
  const adults = Math.max(1, parseInt(paxAdultsInput.value, 10) || 0);
  const children = Math.max(0, parseInt(paxChildrenInput.value, 10) || 0);
  const infants = Math.max(0, parseInt(paxInfantsInput.value, 10) || 0);
  const parts = [pluralize(adults, 'adult', 'adults')];
  if (children > 0) parts.push(pluralize(children, 'child', 'children'));
  if (infants > 0) parts.push(pluralize(infants, 'infant', 'infants'));
  input.value = parts.join(', ');
  updateCharCount();
}

function showPaxPicker() {
  paxAdultsInput.value = '1';
  paxChildrenInput.value = '0';
  paxInfantsInput.value = '0';
  syncPaxInputValue();
  paxPickerBox.style.display = 'flex';
  reserveSpaceForVisiblePopover();
}

function hidePaxPicker() {
  paxPickerBox.style.display = 'none';
  reserveSpaceForVisiblePopover();
}

[paxAdultsInput, paxChildrenInput, paxInfantsInput].forEach((el) => {
  el.addEventListener('keydown', blockNonDigitKeys);
  el.addEventListener('input', syncPaxInputValue);
});
paxAdultsInput.addEventListener('blur', () => {
  clampPax(paxAdultsInput, 1);
  syncPaxInputValue();
});
paxChildrenInput.addEventListener('blur', () => {
  clampPax(paxChildrenInput, 0);
  syncPaxInputValue();
});
paxInfantsInput.addEventListener('blur', () => {
  clampPax(paxInfantsInput, 0);
  syncPaxInputValue();
});

// Optional pricing-extras form (ROE/tax/discount/final rate + invoice due date) - lands on the
// same free-text, LLM-parsed stepPriceExtras() the bot always used, just composed from labelled
// fields instead of typed from memory. All fields optional; blank ones are simply left out of the
// composed sentence (an all-blank form has nothing to send - the "Skip" quick-reply chip covers
// that, same convention as the hotel-optional-details step).
const PE_INPUTS = [
  [peRoeRate, 'ROE rate'],
  [peRoeCharge, 'ROE charge'],
  [peTaxAmount, 'tax amount'],
  [peTaxPercentage, 'tax percentage'],
  [peDiscount, 'discount'],
  [peFinalRate, 'final selling rate'],
];
let priceExtrasDueDate = ''; // DD-MM-YYYY, or '' if not set
let priceExtrasDatePickMode = false; // true while datePickerBox is being borrowed for the due-date sub-field

function updatePeDueDateLabel() {
  peDueDateLabel.textContent = priceExtrasDueDate ? `Invoice due date: ${priceExtrasDueDate}` : 'Set invoice due date';
}

function syncPriceExtrasInputValue() {
  const parts = PE_INPUTS.filter(([el]) => el.value.trim()).map(([el, label]) => `${label} ${el.value.trim()}`);
  if (priceExtrasDueDate) parts.push(`invoice due date ${priceExtrasDueDate}`);
  input.value = parts.join(', ');
  updateCharCount();
}

function showPriceExtrasPicker() {
  PE_INPUTS.forEach(([el]) => (el.value = ''));
  priceExtrasDueDate = '';
  updatePeDueDateLabel();
  syncPriceExtrasInputValue();
  priceExtrasBox.style.display = 'block';
  reserveSpaceForVisiblePopover();
}

function hidePriceExtrasPicker() {
  priceExtrasBox.style.display = 'none';
  reserveSpaceForVisiblePopover();
}

PE_INPUTS.forEach(([el]) => el.addEventListener('input', syncPriceExtrasInputValue));

// Borrows the same calendar used for travel/return/etc. dates, rather than building a second one -
// only this form's due-date field ever turns priceExtrasDatePickMode on, so calGrid's click handler
// below knows to write back into the form instead of submitting the date as a whole message.
peDueDateBtn.addEventListener('click', () => {
  priceExtrasDatePickMode = true;
  priceExtrasBox.style.display = 'none';
  calBackToForm.style.display = 'block';
  showDatePicker({});
});

calBackToForm.addEventListener('click', () => {
  priceExtrasDatePickMode = false;
  calBackToForm.style.display = 'none';
  hideDatePicker();
  priceExtrasBox.style.display = 'block';
  reserveSpaceForVisiblePopover();
});

// One tap, no separate Send press - same reasoning as the "Same as agent"/logo-choice chips
// (stepPriceExtras() already treats any "no" reply, "skip" included, as skipping the whole form).
peSkipBtn.addEventListener('click', () => {
  hidePriceExtrasPicker();
  sendMessage('Skip');
});

// Final optional-details form (note/emergency contact/booked by/PDF permission) - only ever shown
// after the extraGate question's "Yes, add details" reply, same free-text-composing pattern as the
// pricing-extras form above, landing on the same LLM-parsed stepExtraCollect() as before.
let extraDetailsContact = ''; // selected emergency-contact chip value, or ''

function syncExtraDetailsInputValue() {
  const parts = [];
  if (edNote.value.trim()) parts.push(`note: ${edNote.value.trim()}`);
  if (extraDetailsContact) parts.push(`emergency contact ${extraDetailsContact}`);
  if (edBookingBy.value.trim()) parts.push(`booking by ${edBookingBy.value.trim()}`);
  const pdfTypes = [];
  if (edAllowVoucher.checked) pdfTypes.push('voucher');
  if (edAllowInvoice.checked) pdfTypes.push('invoice');
  if (edAllowItinerary.checked) pdfTypes.push('itinerary');
  if (pdfTypes.length) parts.push(`allow agent to download ${pdfTypes.join('/')} pdf`);
  input.value = parts.join(', ');
  updateCharCount();
}

function showExtraDetailsPicker() {
  edNote.value = '';
  edBookingBy.value = '';
  edAllowVoucher.checked = false;
  edAllowInvoice.checked = false;
  edAllowItinerary.checked = false;
  extraDetailsContact = '';
  edContactChips.querySelectorAll('.ed-contact-chip').forEach((el) => el.classList.remove('selected'));
  syncExtraDetailsInputValue();
  extraDetailsBox.style.display = 'flex';
  reserveSpaceForVisiblePopover();
}

function hideExtraDetailsPicker() {
  extraDetailsBox.style.display = 'none';
  reserveSpaceForVisiblePopover();
}

[edNote, edBookingBy].forEach((el) => el.addEventListener('input', syncExtraDetailsInputValue));
[edAllowVoucher, edAllowInvoice, edAllowItinerary].forEach((el) => el.addEventListener('change', syncExtraDetailsInputValue));

// Single-select toggle: clicking the already-selected contact deselects it, clicking another swaps.
edContactChips.addEventListener('click', (e) => {
  const el = e.target.closest('.ed-contact-chip');
  if (!el) return;
  const value = el.dataset.value;
  const wasSelected = el.classList.contains('selected');
  edContactChips.querySelectorAll('.ed-contact-chip').forEach((chip) => chip.classList.remove('selected'));
  extraDetailsContact = wasSelected ? '' : value;
  if (!wasSelected) el.classList.add('selected');
  syncExtraDetailsInputValue();
});

// Generic small form for an itinerary item's OPTIONAL extra details (transfer/sightseeing/
// restaurant) - only ever shown after that item's own *OptionalGate question's "Yes, add details"
// reply (see quickRepliesFor's *OptionalGate chips server-side), same gate-then-form pattern as
// extraGate/extraDetailsBox above. One shared box; fields are injected fresh each time from
// expecting.params.fields (server decides which fields this item type has) instead of a separate
// hardcoded box per item type, since every field here is the same "label + input -> composed
// sentence" shape - same free-text-composing convention as priceExtrasBox/extraDetailsBox, landing
// on the same LLM-parsed step*OptionalCollect() as typing would have.
let itineraryOptionalInputs = []; // [[inputEl, label], ...] for the fields currently rendered

function syncItineraryOptionalInputValue() {
  const parts = itineraryOptionalInputs.filter(([el]) => el.value.trim()).map(([el, label]) => `${label} ${el.value.trim()}`);
  input.value = parts.join(', ');
  updateCharCount();
}

function renderItineraryOptionalForm(fields) {
  itineraryOptionalFields.innerHTML = '';
  itineraryOptionalInputs = fields.map((f) => {
    const wrap = document.createElement('div');
    wrap.className = 'pe-field';
    const label = document.createElement('label');
    label.setAttribute('for', `io-${f.key}`);
    label.textContent = f.label;
    const el = document.createElement('input');
    el.type = f.type === 'number' ? 'number' : 'text';
    el.id = `io-${f.key}`;
    if (f.type === 'number') {
      el.inputMode = 'decimal';
      el.step = 'any';
      el.placeholder = '0';
    } else if (f.placeholder) {
      el.placeholder = f.placeholder;
    }
    el.addEventListener('input', syncItineraryOptionalInputValue);
    wrap.appendChild(label);
    wrap.appendChild(el);
    itineraryOptionalFields.appendChild(wrap);
    return [el, f.label.toLowerCase()];
  });
}

function showItineraryOptionalPicker(fields) {
  renderItineraryOptionalForm(fields);
  syncItineraryOptionalInputValue();
  itineraryOptionalBox.style.display = 'block';
  reserveSpaceForVisiblePopover();
}

function hideItineraryOptionalPicker() {
  itineraryOptionalBox.style.display = 'none';
  reserveSpaceForVisiblePopover();
}

function setExpecting(expecting) {
  // Leaving the destination checklist (answer submitted, or a different field is now being asked)
  // clears the ticks so a later booking's checklist doesn't start pre-checked from a previous one.
  if (currentExpecting && currentExpecting.field === 'destination' && (!expecting || expecting.field !== 'destination')) {
    selectedDestinations.clear();
  }
  currentExpecting = expecting;

  // Editing an EXISTING booking's destinations (chat.js's pendingDestinationsEntry) sends the
  // record's current selection as expecting.preselected - pre-tick those so staff see (and adjust)
  // what's already there instead of re-picking from scratch. New-booking creation's own
  // destinationNames step never sets this, so that checklist still starts blank as before.
  if (expecting && expecting.field === 'destination' && Array.isArray(expecting.preselected)) {
    selectedDestinations.clear();
    for (const d of expecting.preselected) selectedDestinations.set(String(d.Id), d.Name);
    syncDestinationInputValue();
  }

  if (expecting && expecting.field === 'date') {
    hideLookupDropdown();
    hideTimePicker();
    hidePaxPicker();
    hidePriceExtrasPicker();
    hideExtraDetailsPicker();
    hideItineraryOptionalPicker();
    priceExtrasDatePickMode = false;
    calBackToForm.style.display = 'none';
    showDatePicker(expecting.params);
    return;
  }
  hideDatePicker();

  if (expecting && expecting.field === 'time') {
    hideLookupDropdown();
    hidePaxPicker();
    hidePriceExtrasPicker();
    hideExtraDetailsPicker();
    hideItineraryOptionalPicker();
    showTimePicker();
    return;
  }
  hideTimePicker();

  if (expecting && expecting.field === 'pax') {
    hideLookupDropdown();
    hidePriceExtrasPicker();
    hideExtraDetailsPicker();
    hideItineraryOptionalPicker();
    showPaxPicker();
    return;
  }
  hidePaxPicker();

  if (expecting && expecting.field === 'priceExtras') {
    hideLookupDropdown();
    hideExtraDetailsPicker();
    hideItineraryOptionalPicker();
    showPriceExtrasPicker();
    return;
  }
  hidePriceExtrasPicker();

  if (expecting && expecting.field === 'extraDetails') {
    hideLookupDropdown();
    hideItineraryOptionalPicker();
    showExtraDetailsPicker();
    return;
  }
  hideExtraDetailsPicker();

  if (expecting && expecting.field === 'itineraryOptionalForm') {
    hideLookupDropdown();
    showItineraryOptionalPicker(expecting.params.fields);
    return;
  }
  hideItineraryOptionalPicker();

  if (!expecting) {
    hideLookupDropdown();
    return;
  }
  // The destination checklist's initial render always shows the FULL list, regardless of
  // input.value - syncDestinationInputValue() above may have just pre-filled input.value with the
  // preselected names (e.g. "Bangkok, Chiang Mai") for a live-record edit, and using that as the
  // search query here would filter the dropdown down to (usually) nothing, hiding every checkbox
  // including the ones that should show pre-ticked. Typing to filter afterward still works via the
  // separate input 'input' event listener below.
  fetchLookupOptions(expecting, expecting.field === 'destination' ? '' : input.value.trim());
}

// Picking a day either submits it immediately (same as clicking an agent/hotel dropdown item - a
// single date is an unambiguous complete answer) or, when borrowed by the pricing-extras form's
// due-date field, writes back into that form instead and returns to it.
calGrid.addEventListener('click', (e) => {
  const btn = e.target.closest('.cal-day');
  if (!btn || btn.disabled) return;
  const [y, m, d] = btn.dataset.date.split('-');
  const ddmmyyyy = `${d}-${m}-${y}`;
  hideDatePicker();
  if (priceExtrasDatePickMode) {
    priceExtrasDatePickMode = false;
    calBackToForm.style.display = 'none';
    priceExtrasDueDate = ddmmyyyy;
    updatePeDueDateLabel();
    syncPriceExtrasInputValue();
    priceExtrasBox.style.display = 'block';
    reserveSpaceForVisiblePopover();
    return;
  }
  sendMessage(ddmmyyyy);
});

lookupDropdown.addEventListener('mousedown', (e) => {
  // mousedown (not click) so this fires before the input's blur event hides the dropdown
  const multiRow = e.target.closest('.lookup-item-multi');
  if (multiRow) {
    e.preventDefault();
    const id = multiRow.dataset.id;
    if (selectedDestinations.has(id)) selectedDestinations.delete(id);
    else selectedDestinations.set(id, multiRow.dataset.name);
    syncDestinationInputValue();
    renderLookupDropdown(lookupItems, LOOKUP_EMPTY_TEXT.destination, true);
    input.focus();
    return;
  }

  const el = e.target.closest('.lookup-item');
  if (!el) return;
  e.preventDefault();
  const item = lookupItems[Number(el.dataset.index)];
  if (!item) return;
  hideLookupDropdown();
  sendMessage(item.Name);
});

input.addEventListener('input', () => {
  if (!currentExpecting) return;
  clearTimeout(lookupDebounceTimer);
  lookupDebounceTimer = setTimeout(() => fetchLookupOptions(currentExpecting, input.value.trim()), 200);
});

input.addEventListener('focus', () => {
  if (currentExpecting) fetchLookupOptions(currentExpecting, input.value.trim());
});

input.addEventListener('blur', () => {
  // slight delay so a click on a dropdown item (mousedown) still registers first
  setTimeout(hideLookupDropdown, 150);
});

input.addEventListener('keydown', (e) => {
  // #chatInput is a <textarea> (so pasting a multi-line message keeps its line breaks - a plain
  // <input> silently drops them), which means Enter no longer submits the form on its own the way
  // it did on the old <input>. Shift+Enter (and IME composition, e.g. mid-pick in an Indic input
  // method) still inserts a real newline; a plain Enter sends, matching the old input's behavior -
  // except when the lookup dropdown has an active item, where it picks that item instead (unchanged).
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    const dropdownOpen = !(currentExpecting && currentExpecting.multi) && lookupDropdown.style.display === 'block' && lookupItems.length > 0;
    if (dropdownOpen && lookupActiveIndex >= 0) {
      e.preventDefault();
      const item = lookupItems[lookupActiveIndex];
      hideLookupDropdown();
      sendMessage(item.Name);
      return;
    }
    e.preventDefault();
    sendMessage(input.value);
    return;
  }

  // Multi-select fields (destination checklist) are driven by clicking checkboxes, not keyboard nav.
  if (currentExpecting && currentExpecting.multi) return;
  if (lookupDropdown.style.display !== 'block' || lookupItems.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    lookupActiveIndex = Math.min(lookupActiveIndex + 1, lookupItems.length - 1);
    updateLookupActiveHighlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    lookupActiveIndex = Math.max(lookupActiveIndex - 1, 0);
    updateLookupActiveHighlight();
  } else if (e.key === 'Escape') {
    hideLookupDropdown();
  }
});

function updateLookupActiveHighlight() {
  lookupDropdown.querySelectorAll('.lookup-item').forEach((el, i) => {
    el.classList.toggle('active', i === lookupActiveIndex);
  });
}

function getSessionId() {
  let id = localStorage.getItem('flythai_session_id');
  if (!id) {
    id = 'sess-' + Math.random().toString(36).slice(2) + Date.now();
    localStorage.setItem('flythai_session_id', id);
  }
  return id;
}
let sessionId = getSessionId();

function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Minimal markdown renderer: bold, bullet lists, and pipe tables.
function renderMarkdown(text) {
  const escaped = escapeHtml(text);
  const lines = escaped.split(/\r?\n/);
  let html = '';
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const headingMatch = line.match(/^\s*(#{1,6})\s+(.*)$/);
    if (headingMatch) {
      const level = Math.min(headingMatch[1].length, 6);
      html += `<div class="msg-heading msg-heading-${level}">${inline(headingMatch[2])}</div>`;
      i++;
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const headerCells = line.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      let tbl = '<table><thead><tr>' + headerCells.map(c => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>';
      i += 2;
      while (i < lines.length && /^\s*\|.*\|\s*$/.test(lines[i])) {
        const rowCells = lines[i].trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
        tbl += '<tr>' + rowCells.map(c => `<td>${inline(c)}</td>`).join('') + '</tr>';
        i++;
      }
      tbl += '</tbody></table>';
      // Wide tables (many columns, long words that no longer break mid-word) can need more room
      // than the chat column has - this wrapper lets the table itself scroll sideways instead of
      // pushing the whole page wider (see .bubble-table-scroll in style.css).
      html += `<div class="bubble-table-scroll">${tbl}</div>`;
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      let list = '<ul>';
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        list += `<li>${inline(lines[i].replace(/^\s*[-*]\s+/, ''))}</li>`;
        i++;
      }
      list += '</ul>';
      html += list;
      continue;
    }
    html += (line.trim() ? `<div>${inline(line)}</div>` : '<br/>');
    i++;
  }
  return html;
}
function inline(s) {
  return s
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>') // **bold** first, so it consumes double asterisks
    .replace(/\*([^*]+)\*/g, '<b>$1</b>') // remaining single *emphasis* -> bold too, per request
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function addMessage(role, contentHtml, { raw = false } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'msg ' + (role === 'user' ? 'user' : 'bot');
  const content = document.createElement('div');
  content.className = 'msg-content';
  const bubble = document.createElement('div');
  bubble.className = 'bubble';
  if (raw) bubble.textContent = contentHtml;
  else bubble.innerHTML = contentHtml;
  content.appendChild(bubble);
  wrap.appendChild(content);
  messagesInner.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return { wrap: content, bubble };
}

function formatCellValue(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/.test(v)) {
    return v.slice(0, 10); // ISO datetime -> just the date part
  }
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  return String(v);
}

function buildDataTable(rows) {
  const columns = Object.keys(rows[0] || {});
  const head = '<tr>' + columns.map((c) => `<th>${escapeHtml(c)}</th>`).join('') + '</tr>';
  const body = rows
    .map((row) => '<tr>' + columns.map((c) => `<td>${escapeHtml(formatCellValue(row[c]))}</td>`).join('') + '</tr>')
    .join('');
  const wrap = document.createElement('div');
  wrap.className = 'data-table-wrap';
  wrap.innerHTML = `<table>${head}${body}</table>`;
  return wrap;
}

// Opens the full record set in a 50/50 split next to the chat (see .layout/.data-drawer in
// index.html + style.css) instead of expanding a table inline in the chat feed. The inline version
// pushed every later message down the page; a first attempt at fixing that used an overlay drawer,
// but an overlay covers/dims the chat instead of leaving it usable - a real side-by-side split
// keeps both fully visible and never touches the conversation's scroll position.
function openDataDrawer(rows, rowCount, rowsTruncated) {
  const noun = rows.length === 1 ? 'record' : 'records';
  dataDrawerTitle.textContent = rowsTruncated
    ? `Showing ${rows.length} of ${rowCount} records`
    : `${rows.length} ${noun}`;

  dataDrawerBody.innerHTML = ''; // refill on every open, nothing to clean up on close
  dataDrawerBody.appendChild(buildDataTable(rows));
  if (rowsTruncated) {
    const note = document.createElement('div');
    note.className = 'data-table-note';
    note.textContent = `Showing ${rows.length} of ${rowCount} total records. Ask a narrower question (e.g. add a date range or a name) to see the rest.`;
    dataDrawerBody.appendChild(note);
  }

  // A 50/50 split with the history sidebar also open leaves three panels fighting for space and
  // the chat column too narrow to read. Collapse the sidebar for the duration without touching
  // the user's own remembered preference (setSidebarCollapsed's persist:false), and bring it back
  // when the drawer closes - see sidebarAutoCollapsedForDrawer below.
  if (!layoutEl.classList.contains('sidebar-collapsed')) {
    sidebarAutoCollapsedForDrawer = true;
    setSidebarCollapsed(true, false);
  }
  layoutEl.classList.add('split');
  dataDrawer.setAttribute('aria-hidden', 'false');
}

// Reverts the chat to its original full-width/centred layout.
function closeDataDrawer() {
  layoutEl.classList.remove('split');
  dataDrawer.setAttribute('aria-hidden', 'true');
  if (sidebarAutoCollapsedForDrawer) {
    sidebarAutoCollapsedForDrawer = false;
    setSidebarCollapsed(false, false);
  }
}

dataDrawerClose.addEventListener('click', closeDataDrawer);
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && layoutEl.classList.contains('split')) closeDataDrawer();
});

// Offered for EVERY non-empty result, not just large ones. The answer text is written by the model
// and has been seen to pad a table with repeated rows; small results used to hide this button, so
// the one case most prone to it was also the one the user could not check against the real data.
function addDataToggle(wrap, rows, rowCount, rowsTruncated) {
  if (!rows || rows.length === 0) return;

  const noun = rows.length === 1 ? 'record' : 'records';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'show-more-btn';
  btn.textContent = rowsTruncated
    ? `View all ${rows.length} of ${rowCount} ${noun}`
    : `View ${rows.length} ${noun} from the database`;
  btn.addEventListener('click', () => openDataDrawer(rows, rowCount, rowsTruncated));

  wrap.appendChild(btn);
}

// One "Copy" chip per job sheet's ready-to-send text (see src/jobSheetCopy.js's copyBlocks) - the
// real Job Sheet page's own two modals ("Copy Booking"/"Copy For Customer") each have exactly one
// "Copy" button that does this same one-tap clipboard copy; this reproduces that directly in the
// chat instead of making the agent select-and-Ctrl+C out of the fenced code block by hand. Not
// persisted across a reload (same convention as addDataToggle's row data above) - the full text is
// still right there in the message itself either way.
async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }
  // Fallback for a context without the async Clipboard API (e.g. non-HTTPS).
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

// Shared by every chip addCopyButtons creates (the per-block ones and "Copy All") - copies `text`,
// flips the button to a brief "Copied!"/"Copy failed" state, then restores its original label.
function makeCopyButton(label, text, extraClass) {
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = extraClass ? `copy-block-btn ${extraClass}` : 'copy-block-btn';
  btn.textContent = label;
  btn.addEventListener('click', async () => {
    try {
      await copyTextToClipboard(text);
      btn.textContent = 'Copied!';
      btn.classList.add('copied');
    } catch (err) {
      btn.textContent = 'Copy failed';
    } finally {
      setTimeout(() => {
        btn.textContent = label;
        btn.classList.remove('copied');
      }, 1500);
    }
  });
  return btn;
}

function addCopyButtons(wrap, copyBlocks) {
  if (!copyBlocks || copyBlocks.length === 0) return;

  const row = document.createElement('div');
  row.className = 'copy-blocks-row';

  // Only worth offering once there's more than one block to combine - joined with a blank line
  // between each (mirroring the blank line each individual template already ends on), so pasted
  // as one message it still reads as clearly separate entries, not run together.
  if (copyBlocks.length > 1) {
    const allText = copyBlocks.map((b) => b.text).join('\n\n');
    const allBtn = makeCopyButton(`Copy All (${copyBlocks.length})`, allText, 'copy-all');
    row.appendChild(allBtn);
  }

  copyBlocks.forEach((block, i) => {
    const label = copyBlocks.length > 1 ? `Copy #${i + 1}` : 'Copy';
    const btn = makeCopyButton(label, block.text);
    btn.title = block.label;
    row.appendChild(btn);
  });
  wrap.appendChild(row);
}

// Tap-to-answer shortcuts for a guided-flow step (see quickRepliesFor() in src/chat.js) - same
// chip look as the fixed suggestions row, but populated per-response from data.quickReplies.
const QUICK_REPLY_ICONS = {
  Skip: '⏭️',
  Yes: '✅',
  No: '❌',
  Done: '🏁',
  'Breakfast included': '🍳',
  'No breakfast': '🚫',
  'Single sharing': '🛏️',
  'Double sharing': '🛏️',
  'Triple sharing': '🛏️',
  'Add pricing line': '➕',
  'Adult / Single': '🧑',
  'Adult / Double': '👥',
  'Adult / Triple': '👨‍👩‍👦',
  'Child With Bed': '🛏️',
  'Child Without Bed': '🧒',
  Infant: '👶',
  'With FlyThai Logo': '🌴',
  'With Agent Logo': '🏢',
  'No Logo': '🚫',
  Transfer: '🚐',
  Sightseeing: '🗺️',
  Restaurant: '🍽️',
  'Leisure Day': '🏖️',
  'Self-booked': '🙋',
};

// Most chips send their own label as the reply text, but some (e.g. "Same as agent (0123456789)")
// need to show a descriptive label while actually sending a fixed keyword ("same") the backend
// checks for - those come through as {label, value, autoSend} instead of a plain string (see
// quickRepliesFor() in src/chat.js for which fields set autoSend and why).
function quickReplyIcon(label) {
  if (QUICK_REPLY_ICONS[label]) return QUICK_REPLY_ICONS[label];
  if (/^Same as /.test(label)) return '👤';
  return '✅';
}

function renderQuickReplies(list) {
  if (!list || list.length === 0) {
    quickReplies.style.display = 'none';
    quickReplies.innerHTML = '';
    return;
  }
  quickReplies.innerHTML = list
    .map((item) => {
      const label = typeof item === 'string' ? item : item.label;
      const value = typeof item === 'string' ? item : item.value;
      const autoSend = typeof item === 'object' && item.autoSend ? '1' : '';
      return `<button type="button" class="chip" data-icon="${quickReplyIcon(label)}" data-value="${escapeHtml(value)}" data-autosend="${autoSend}">${escapeHtml(label)}</button>`;
    })
    .join('');
  quickReplies.style.display = 'flex';
  // This row appears AFTER addMessage() already scrolled to the (then-shorter) bottom, so the
  // chat-bottom area growing by this row's own height re-covers the tail end of the last message
  // unless the scroll position is redone now that the row's real height exists in the layout.
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

// Fills the input rather than sending immediately - these chips cover just ONE of several
// optional fields the step accepts in a single message, so picking one shouldn't cut off a chance
// to also type/add the others (e.g. click "Double sharing", then still add "2 adults" before
// sending). Appends to whatever's already typed instead of overwriting it.
//
// Exception: the logo-choice step (which PDF logo version) is a single complete answer, not one
// of several fields to combine - clicking a chip there sends it immediately instead, so choosing
// a PDF version is one tap, not a tap-then-Send. Same for any chip chat.js marked autoSend (e.g.
// "Self-booked" or "Same as agent (0123456789)") - those are forks/single-field answers too, just
// from steps other than logoChoice, so the same "one tap, no separate Send" behavior applies.
quickReplies.addEventListener('click', (e) => {
  const el = e.target.closest('.chip');
  if (!el) return;
  const text = el.dataset.value || el.textContent;
  if ((currentExpecting && currentExpecting.field === 'logoChoice') || el.dataset.autosend === '1') {
    sendMessage(text);
    return;
  }
  input.value = input.value.trim() ? `${input.value.trim()}, ${text}` : text;
  updateCharCount();
  input.focus();
});

function addLoading() {
  const wrap = document.createElement('div');
  wrap.className = 'msg bot';
  wrap.innerHTML = `<div class="bubble loading"><span class="dot"></span><span class="dot"></span><span class="dot"></span></div>`;
  messagesInner.appendChild(wrap);
  messagesEl.scrollTop = messagesEl.scrollHeight;
  return wrap;
}

let busy = false;

async function sendMessage(text) {
  if (busy) return; // chips and dropdown items call this directly, bypassing the disabled Send button
  if (!text.trim()) return;
  if (text.length > MAX_MESSAGE_CHARS) {
    addMessage('bot', `<span class="error-note">That message is too long (${text.length} characters). Please shorten it to under ${MAX_MESSAGE_CHARS}.</span>`);
    return;
  }
  busy = true;
  // Captured once so a slow request still saves to the chat it was actually asked from, even
  // though sidebar switching is blocked while busy (see historyList's click handler) and can't
  // actually change sessionId out from under this call - kept explicit rather than relying on that.
  const chatId = sessionId;
  addMessage('user', escapeHtml(text).replace(/\n/g, '<br/>'));
  appendMessageToChat(chatId, 'user', text);
  input.value = '';
  updateCharCount();
  sendBtn.disabled = true;
  suggestions.style.display = 'none';
  renderQuickReplies(null);
  setExpecting(null);
  const loadingEl = addLoading();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId: chatId }),
    });
    const data = await readJsonResponse(res);
    loadingEl.remove();
    if (!res.ok) {
      const errText = data.error || friendlyHttpError(res.status);
      addMessage('bot', `<span class="error-note">${escapeHtml(errText)}</span>`);
      appendMessageToChat(chatId, 'bot', errText, { kind: 'error' });
      return;
    }
    const { wrap } = addMessage('bot', renderMarkdown(data.answer || ''));
    addDataToggle(wrap, data.rows, data.rowCount, data.rowsTruncated);
    addCopyButtons(wrap, data.copyBlocks);
    appendMessageToChat(chatId, 'bot', data.answer || '');
    updateChatFlowState(chatId, data.expecting || null, data.quickReplies || null);
    setExpecting(data.expecting || null);
    renderQuickReplies(data.quickReplies || null);
    if (data.expecting) input.focus();
  } catch (err) {
    loadingEl.remove();
    const errText = 'Could not reach the server. Please check that it is running and try again.';
    addMessage('bot', `<span class="error-note">${errText}</span>`);
    appendMessageToChat(chatId, 'bot', errText, { kind: 'error' });
  } finally {
    busy = false;
    sendBtn.disabled = false;
  }
}

function updateCharCount() {
  const len = input.value.length;
  if (len > MAX_MESSAGE_CHARS - 300) {
    charCount.textContent = `${len} / ${MAX_MESSAGE_CHARS}`;
    charCount.style.display = 'block';
    charCount.classList.toggle('over', len >= MAX_MESSAGE_CHARS);
  } else {
    charCount.style.display = 'none';
  }
  autoResizeInput();
}

// Grows #chatInput to fit its content (typed or pasted, including multi-line paste - see the
// textarea note in style.css) up to INPUT_MAX_HEIGHT, then leaves it to scroll internally rather
// than pushing the rest of the page around. Called from updateCharCount so every existing
// `input.value = ...` call site (chips, destination checklist, pax spinners, ...) picks this up
// automatically instead of needing its own resize call.
function autoResizeInput() {
  input.style.height = 'auto';
  input.style.height = `${Math.min(input.scrollHeight, INPUT_MAX_HEIGHT)}px`;
}

input.addEventListener('input', updateCharCount);

form.addEventListener('submit', (e) => {
  e.preventDefault();
  sendMessage(input.value);
});

suggestions.addEventListener('click', (e) => {
  if (e.target.classList.contains('chip')) {
    sendMessage(e.target.textContent);
  }
});

// The suggestion row is a single horizontally-scrolling line. A trackpad swipes
// it natively, but a plain mouse wheel only emits deltaY - without this, desktop
// users with a mouse could never reach the chips past the right edge.
suggestions.addEventListener(
  'wheel',
  (e) => {
    if (e.deltaX !== 0) return; // real horizontal intent - let the browser handle it
    const maxScroll = suggestions.scrollWidth - suggestions.clientWidth;
    if (maxScroll <= 0) return; // everything already fits; don't swallow page scroll
    e.preventDefault();
    suggestions.scrollLeft += e.deltaY;
  },
  { passive: false }
);

// Same horizontal-scroll-via-wheel support as the suggestions row above, for quickReplies.
quickReplies.addEventListener(
  'wheel',
  (e) => {
    if (e.deltaX !== 0) return;
    const maxScroll = quickReplies.scrollWidth - quickReplies.clientWidth;
    if (maxScroll <= 0) return;
    e.preventDefault();
    quickReplies.scrollLeft += e.deltaY;
  },
  { passive: false }
);

clearBtn.addEventListener('click', startNewChat);

// ==========================================================================
// Chat history sidebar
//
// Conversations aren't stored anywhere server-side beyond the in-memory flow
// state keyed by sessionId (see src/chat.js), so the transcript itself lives
// in localStorage, one record per chat, keyed by that same sessionId. This
// also means it's per-browser, not per-account - fine for a single-staff-
// member tool with no login, and it avoids adding a table to the real
// production database just to hold UI chat logs.
// ==========================================================================

const CHATS_KEY = 'flythai_chats';
const SIDEBAR_COLLAPSED_KEY = 'flythai_sidebar_collapsed';
const MAX_MESSAGES_PER_CHAT = 300; // soft cap so a long-lived chat can't grow localStorage without bound

const PENCIL_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/></svg>';
const TRASH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/><path d="M10 11v6"/><path d="M14 11v6"/></svg>';

function loadChats() {
  try {
    const parsed = JSON.parse(localStorage.getItem(CHATS_KEY) || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch (err) {
    return [];
  }
}

function saveChats() {
  try {
    localStorage.setItem(CHATS_KEY, JSON.stringify(chats));
  } catch (err) {
    // Most likely a quota error from very long-running chats - not worth surfacing to the user,
    // the in-memory list (and this browser tab) still works fine either way.
    console.warn('Could not save chat history:', err);
  }
}

let chats = loadChats();
let renamingChatId = null; // chat currently showing a rename <input> in the sidebar, or null

function findChat(id) {
  return chats.find((c) => c.id === id) || null;
}

function makeChatTitle(text) {
  const t = text.trim().replace(/\s+/g, ' ');
  if (!t) return 'New chat';
  return t.length > 42 ? `${t.slice(0, 42)}…` : t;
}

function createChatRecord(id) {
  return {
    id,
    title: 'New chat',
    titleManual: false, // becomes true once the user renames it, so a later first message can't overwrite that choice
    updatedAt: Date.now(),
    messages: [], // [{ role: 'user'|'bot', text, kind: 'normal'|'error' }]
    lastExpecting: null,
    lastQuickReplies: null,
  };
}

// Called once at startup - wraps whatever sessionId was already in localStorage (possibly from
// before this feature existed) in a proper chat record instead of losing it.
function ensureCurrentChat() {
  let chat = findChat(sessionId);
  if (!chat) {
    chat = createChatRecord(sessionId);
    chats.unshift(chat);
    saveChats();
  }
  return chat;
}

function appendMessageToChat(chatId, role, text, extra = {}) {
  const chat = findChat(chatId);
  if (!chat) return;
  chat.messages.push({ role, text, kind: extra.kind || 'normal' });
  if (chat.messages.length > MAX_MESSAGES_PER_CHAT) {
    chat.messages.splice(0, chat.messages.length - MAX_MESSAGES_PER_CHAT);
  }
  chat.updatedAt = Date.now();
  if (role === 'user' && !chat.titleManual && chat.messages.filter((m) => m.role === 'user').length === 1) {
    chat.title = makeChatTitle(text);
  }
  saveChats();
  renderHistorySidebar();
}

function updateChatFlowState(chatId, expecting, quickReplies) {
  const chat = findChat(chatId);
  if (!chat) return;
  chat.lastExpecting = expecting || null;
  chat.lastQuickReplies = quickReplies || null;
  saveChats();
}

// Rebuilds the whole message pane from a chat record - used both at startup (for a returning
// chat with history) and whenever the user switches to a different chat in the sidebar.
function renderChatIntoDOM(chat) {
  messagesInner.innerHTML = '';
  if (!chat.messages.length) {
    addMessage('bot', 'Started a new chat. What would you like to know?');
  } else {
    chat.messages.forEach((m) => {
      if (m.role === 'user') {
        addMessage('user', escapeHtml(m.text).replace(/\n/g, '<br/>'));
      } else if (m.kind === 'error') {
        addMessage('bot', `<span class="error-note">${escapeHtml(m.text)}</span>`);
      } else {
        addMessage('bot', renderMarkdown(m.text || ''));
        // Note: the "view N records from the database" toggle isn't restored on reload - the
        // underlying row data isn't persisted (it can be large; the DB is the source of truth
        // and can always be re-queried), only the rendered answer text is.
      }
    });
  }
  suggestions.style.display = chat.messages.length ? 'none' : 'flex';
  renderQuickReplies(chat.lastQuickReplies || null);
  setExpecting(chat.lastExpecting || null);
  messagesEl.scrollTop = messagesEl.scrollHeight;
}

function formatRelativeTime(ts) {
  const diff = Date.now() - ts;
  const minute = 60000;
  const hour = 3600000;
  const day = 86400000;
  if (diff < minute) return 'Just now';
  if (diff < hour) return `${Math.floor(diff / minute)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 2 * day) return 'Yesterday';
  if (diff < 7 * day) return `${Math.floor(diff / day)}d ago`;
  const d = new Date(ts);
  return `${d.getDate()} ${MONTH_NAMES[d.getMonth()].slice(0, 3)}`;
}

function renderHistorySidebar() {
  const sorted = [...chats].sort((a, b) => b.updatedAt - a.updatedAt);
  if (!sorted.length) {
    historyList.innerHTML = '<div class="history-empty">No chats yet</div>';
    return;
  }
  historyList.innerHTML = sorted
    .map((chat) => {
      const active = chat.id === sessionId ? ' active' : '';
      if (chat.id === renamingChatId) {
        return `<div class="history-item${active}" data-id="${escapeHtml(chat.id)}">
          <div class="history-item-main">
            <input type="text" class="history-rename-input" value="${escapeHtml(chat.title)}" maxlength="60" />
          </div>
        </div>`;
      }
      return `<div class="history-item${active}" data-id="${escapeHtml(chat.id)}">
        <div class="history-item-main" data-action="switch">
          <div class="history-item-title">${escapeHtml(chat.title || 'New chat')}</div>
          <div class="history-item-time">${escapeHtml(formatRelativeTime(chat.updatedAt))}</div>
        </div>
        <div class="history-item-actions">
          <button type="button" class="history-item-btn history-rename-btn" data-action="rename" title="Rename">${PENCIL_ICON}</button>
          <button type="button" class="history-item-btn history-delete-btn" data-action="delete" title="Delete">${TRASH_ICON}</button>
        </div>
      </div>`;
    })
    .join('');

  if (renamingChatId) {
    const renameInput = historyList.querySelector('.history-rename-input');
    if (renameInput) {
      renameInput.focus();
      renameInput.select();
    }
  }
}

function closeSidebarOnMobile() {
  if (window.innerWidth <= 640) setSidebarCollapsed(true);
}

function switchToChat(id) {
  if (busy || id === sessionId) return;
  const chat = findChat(id);
  if (!chat) return;
  sessionId = id;
  localStorage.setItem('flythai_session_id', id);
  renderChatIntoDOM(chat);
  renderHistorySidebar();
  closeSidebarOnMobile();
}

function startNewChat() {
  if (busy) return;
  sessionId = 'sess-' + Math.random().toString(36).slice(2) + Date.now();
  localStorage.setItem('flythai_session_id', sessionId);
  const chat = createChatRecord(sessionId);
  chats.unshift(chat);
  saveChats();
  renderChatIntoDOM(chat);
  renderHistorySidebar();
  input.value = '';
  updateCharCount();
  input.focus();
  closeSidebarOnMobile();
}

function deleteChat(id) {
  if (busy) return;
  const chat = findChat(id);
  if (!chat) return;
  if (!confirm(`Delete "${chat.title || 'this chat'}"? This cannot be undone.`)) return;
  chats = chats.filter((c) => c.id !== id);
  saveChats();
  if (id === sessionId) {
    if (chats.length) {
      const next = [...chats].sort((a, b) => b.updatedAt - a.updatedAt)[0];
      sessionId = next.id;
      localStorage.setItem('flythai_session_id', sessionId);
      renderChatIntoDOM(next);
    } else {
      startNewChat();
      return; // startNewChat already re-renders the sidebar
    }
  }
  renderHistorySidebar();
}

function finishRenameChat(id, rawValue) {
  const chat = findChat(id);
  if (chat) {
    const value = rawValue.trim();
    if (value) {
      chat.title = value.slice(0, 60);
      chat.titleManual = true;
      saveChats();
    }
  }
  renamingChatId = null;
  renderHistorySidebar();
}

historyList.addEventListener('click', (e) => {
  const actionEl = e.target.closest('[data-action]');
  const itemEl = e.target.closest('.history-item');
  if (!actionEl || !itemEl) return;
  const id = itemEl.dataset.id;
  if (actionEl.dataset.action === 'switch') switchToChat(id);
  else if (actionEl.dataset.action === 'rename') {
    renamingChatId = id;
    renderHistorySidebar();
  } else if (actionEl.dataset.action === 'delete') deleteChat(id);
});

historyList.addEventListener('keydown', (e) => {
  if (!e.target.classList.contains('history-rename-input')) return;
  if (e.key === 'Enter') {
    e.preventDefault();
    e.target.blur(); // triggers the focusout handler below, which saves it
  } else if (e.key === 'Escape') {
    renamingChatId = null;
    renderHistorySidebar();
  }
});

// focusout (not blur, which doesn't bubble) so a single listener on the list covers whichever
// item is currently mid-rename, without rebinding it every time renderHistorySidebar() runs.
historyList.addEventListener('focusout', (e) => {
  if (!e.target.classList.contains('history-rename-input') || !renamingChatId) return;
  finishRenameChat(renamingChatId, e.target.value);
});

// True only while the sidebar was auto-collapsed by openDataDrawer() (see above) rather than by
// the user's own click - closeDataDrawer() checks this to know whether to bring it back.
let sidebarAutoCollapsedForDrawer = false;

function setSidebarCollapsed(collapsed, persist = true) {
  layoutEl.classList.toggle('sidebar-collapsed', collapsed);
  if (!persist) return;
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? '1' : '0');
  } catch (err) {
    // ignore - collapsed state just won't persist across reloads
  }
}

sidebarToggleBtn.addEventListener('click', () => {
  sidebarAutoCollapsedForDrawer = false; // an explicit click overrides any pending auto-restore
  setSidebarCollapsed(!layoutEl.classList.contains('sidebar-collapsed'));
});

// Defaults to collapsed on a phone-width screen (no room to spare) and expanded everywhere else,
// unless the user already made an explicit choice that's remembered in localStorage.
(function initSidebarCollapsed() {
  let stored = null;
  try {
    stored = localStorage.getItem(SIDEBAR_COLLAPSED_KEY);
  } catch (err) {
    // ignore
  }
  setSidebarCollapsed(stored !== null ? stored === '1' : window.innerWidth <= 640);
})();

(function initHistory() {
  const chat = ensureCurrentChat();
  // A brand-new chat with zero messages already has its richer welcome bubble hardcoded in
  // index.html - re-rendering it here would just replace that with the plainer "Started a new
  // chat" text for no reason. Only rebuild from scratch when there's actual history to restore.
  if (chat.messages.length) renderChatIntoDOM(chat);
  renderHistorySidebar();
})();
