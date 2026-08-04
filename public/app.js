const messagesEl = document.getElementById('messages'); // scroll container (full width)
const messagesInner = document.getElementById('messagesInner'); // centered content column, inside messagesEl
const form = document.getElementById('chatForm');
const input = document.getElementById('chatInput');
const sendBtn = document.getElementById('sendBtn');
const suggestions = document.getElementById('suggestions');
const clearBtn = document.getElementById('clearBtn');
const lookupDropdown = document.getElementById('lookupDropdown');
const flowBar = document.getElementById('flowBar');
const cancelFlowBtn = document.getElementById('cancelFlowBtn');
const charCount = document.getElementById('charCount');
const layoutEl = document.getElementById('layout');
const dataDrawer = document.getElementById('dataDrawer');
const dataDrawerTitle = document.getElementById('dataDrawerTitle');
const dataDrawerBody = document.getElementById('dataDrawerBody');
const dataDrawerClose = document.getElementById('dataDrawerClose');

const MAX_MESSAGE_CHARS = 2000; // must match MAX_MESSAGE_CHARS in server.js

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

// Shows a visible way out of any guided step (booking creation, status change, PDF choice) — the
// only previous escape was New Chat, which discarded the whole conversation.
function setFlowActive(active) {
  flowBar.style.display = active ? 'flex' : 'none';
}

// Live lookup dropdowns - shows real registered records above the input while the bot is asking
// for that field, same idea as the real site's own autocomplete fields (agent/company, hotel name).
const LOOKUP_ENDPOINTS = {
  agent: '/api/agents',
  hotel: '/api/hotels',
  pickup: '/api/pickups',
  transfer: '/api/transfers',
  sightseeing: '/api/sightseeing',
  vehicle: '/api/vehicles',
};
const LOOKUP_EMPTY_TEXT = {
  agent: 'No matching agents found',
  hotel: 'No matching hotels found',
  pickup: 'No matching pickup/drop-off points found',
  transfer: 'No matching transfers found',
  sightseeing: 'No matching sightseeing options found',
  vehicle: 'No matching vehicle types found',
};
let currentExpecting = null; // { field, params } | null
let lookupDebounceTimer = null;
let lookupItems = [];
let lookupActiveIndex = -1;

// Transfers show their code as part of the main label (mirrors the real form's separate
// Transfer Code column) rather than buried in the sub-line, since staff often search by code.
function lookupItemLabel(item) {
  return item.Code ? `${item.Code} — ${item.Name}` : item.Name;
}

function lookupItemSub(item) {
  // Agents show a phone number; hotels show their destination; vehicles show their seating
  // capacity. Pickup/drop-off points and transfers (code already in the main label) show nothing.
  if (item.Phone) return item.Phone;
  if (item.Destination) return item.Destination;
  if (item.Capacity != null) return `Capacity: ${item.Capacity}`;
  return '';
}

function renderLookupDropdown(items, emptyText) {
  lookupItems = items;
  lookupActiveIndex = -1;
  if (items.length === 0) {
    lookupDropdown.innerHTML = `<div class="lookup-empty">${escapeHtml(emptyText || 'No matches')}</div>`;
    lookupDropdown.style.display = 'block';
    return;
  }
  lookupDropdown.innerHTML = items
    .map((item, i) => {
      const sub = lookupItemSub(item);
      return `<div class="lookup-item" data-index="${i}">${escapeHtml(lookupItemLabel(item))}${sub ? `<div class="lookup-item-sub">${escapeHtml(sub)}</div>` : ''}</div>`;
    })
    .join('');
  lookupDropdown.style.display = 'block';
}

function hideLookupDropdown() {
  lookupDropdown.style.display = 'none';
  lookupDropdown.innerHTML = '';
  lookupItems = [];
  lookupActiveIndex = -1;
}

async function fetchLookupOptions(expecting, query) {
  if (!expecting) return;
  const { field, params } = expecting;
  const endpoint = LOOKUP_ENDPOINTS[field];
  if (!endpoint) return;
  try {
    const qs = new URLSearchParams({ q: query, ...(params || {}) });
    const res = await fetch(`${endpoint}?${qs.toString()}`);
    const data = await res.json();
    const key = Object.keys(data).find((k) => Array.isArray(data[k]));
    renderLookupDropdown(key ? data[key] : [], LOOKUP_EMPTY_TEXT[field]);
  } catch (err) {
    hideLookupDropdown();
  }
}

function setExpecting(expecting) {
  currentExpecting = expecting;
  if (!expecting) {
    hideLookupDropdown();
    return;
  }
  fetchLookupOptions(expecting, input.value.trim());
}

lookupDropdown.addEventListener('mousedown', (e) => {
  // mousedown (not click) so this fires before the input's blur event hides the dropdown
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
  if (lookupDropdown.style.display !== 'block' || lookupItems.length === 0) return;
  if (e.key === 'ArrowDown') {
    e.preventDefault();
    lookupActiveIndex = Math.min(lookupActiveIndex + 1, lookupItems.length - 1);
    updateLookupActiveHighlight();
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    lookupActiveIndex = Math.max(lookupActiveIndex - 1, 0);
    updateLookupActiveHighlight();
  } else if (e.key === 'Enter' && lookupActiveIndex >= 0) {
    e.preventDefault();
    const item = lookupItems[lookupActiveIndex];
    hideLookupDropdown();
    sendMessage(item.Name);
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
      html += tbl;
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

  layoutEl.classList.add('split');
  dataDrawer.setAttribute('aria-hidden', 'false');
}

// Reverts the chat to its original full-width/centred layout.
function closeDataDrawer() {
  layoutEl.classList.remove('split');
  dataDrawer.setAttribute('aria-hidden', 'true');
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
  addMessage('user', escapeHtml(text).replace(/\n/g, '<br/>'));
  input.value = '';
  updateCharCount();
  sendBtn.disabled = true;
  suggestions.style.display = 'none';
  setExpecting(null);
  const loadingEl = addLoading();

  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId }),
    });
    const data = await readJsonResponse(res);
    loadingEl.remove();
    if (!res.ok) {
      addMessage('bot', `<span class="error-note">${escapeHtml(data.error || friendlyHttpError(res.status))}</span>`);
      return;
    }
    const { wrap } = addMessage('bot', renderMarkdown(data.answer || ''));
    addDataToggle(wrap, data.rows, data.rowCount, data.rowsTruncated);
    setExpecting(data.expecting || null);
    setFlowActive(!!data.flowActive);
    if (data.expecting) input.focus();
  } catch (err) {
    loadingEl.remove();
    addMessage('bot', `<span class="error-note">Could not reach the server. Please check that it is running and try again.</span>`);
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
}

input.addEventListener('input', updateCharCount);

cancelFlowBtn.addEventListener('click', async () => {
  try {
    const res = await fetch('/api/cancel', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    });
    const data = await readJsonResponse(res);
    addMessage('bot', renderMarkdown(data.answer || 'Cancelled.'));
  } catch (err) {
    addMessage('bot', `<span class="error-note">Could not reach the server to cancel. Please try again.</span>`);
  } finally {
    setFlowActive(false);
    setExpecting(null);
    suggestions.style.display = 'flex';
    input.focus();
  }
});

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

clearBtn.addEventListener('click', () => {
  sessionId = 'sess-' + Math.random().toString(36).slice(2) + Date.now();
  localStorage.setItem('flythai_session_id', sessionId);
  messagesInner.innerHTML = '';
  addMessage('bot', 'Started a new chat. What would you like to know?');
  suggestions.style.display = 'flex';
  setExpecting(null);
  setFlowActive(false);
  input.value = '';
  updateCharCount();
});
