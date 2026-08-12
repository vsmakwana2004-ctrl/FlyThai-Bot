const { safeFetch } = require('./bookingApi');

// FlyThai's admin panel (flythai.arkinfosoft.in) has its own real RBAC system under Manage Users ->
// Roles: each role gets independent view/addedit/delete checkboxes per "page" (Booking, Agents
// Configuration, Account Master, a dedicated "Chat Bot System" page, ...). This module mirrors that
// same permission model here by fetching it live from the admin panel, rather than hand-copying it,
// so it can never drift out of sync with what an Admin/Director actually configures in /Role/Index.
//
// There's no clean JSON API for this (the DataTables-backed /Role/GetAllRole and /User/GetAllUser
// endpoints 500 on every request-shape tried) - only the server-rendered /RoleDetail/{id} page, so
// this scrapes that HTML with a regex rather than pulling in an HTML-parsing dependency.

function buildHeaders() {
  const cookie = process.env.FLYTHAI_SESSION_COOKIE;
  if (!cookie) {
    const err = new Error('FLYTHAI_SESSION_COOKIE is not set in .env.');
    err.code = 'NO_SESSION_COOKIE';
    throw err;
  }
  const base = process.env.FLYTHAI_BASE_URL || 'https://flythai.arkinfosoft.in';
  return { base, headers: { accept: 'text/html, application/json', cookie, 'x-requested-with': 'XMLHttpRequest' } };
}

const REFRESH_INTERVAL_MS = 20 * 60 * 1000;
// The one page whose permission gates whether a role can use the chatbot AT ALL - distinct from the
// per-capability pages (Booking, Agents Configuration, ...) checked once past this gate.
const CHAT_BOT_PAGE = 'Chat Bot System';

let cache = null; // { [roleName]: { [pageLabel]: { view, addedit, delete } } } - null until first successful refresh
let roleList = []; // [{ id, roleName }]
let lastRefreshedAt = 0;
let lastRefreshError = null;
let refreshing = null; // in-flight refresh promise, so concurrent staleness checks don't pile up requests

async function fetchRoles() {
  const { base, headers } = buildHeaders();
  const res = await safeFetch(`${base}/Role/GetRole`, { headers });
  if (!res.ok) throw new Error(`FlyThai /Role/GetRole returned ${res.status}`);
  const data = await res.json();
  return data.filter((r) => !r.isDeleted).map((r) => ({ id: r.id, roleName: r.roleName }));
}

async function fetchRoleDetailHtml(roleId) {
  const { base, headers } = buildHeaders();
  const res = await safeFetch(`${base}/RoleDetail/${roleId}`, { headers });
  if (!res.ok) throw new Error(`FlyThai /RoleDetail/${roleId} returned ${res.status}`);
  return res.text();
}

// Each permission "page" renders as a repeated block:
//   <div class="row page-permissions">
//     <div class="col-3"><label>Manage Destinations</label></div>
//     <div class="col-3"><input id="view_80" checked></div>
//     <div class="col-3"><input id="addedit_80" ></div>
//     <div class="col-3"><input id="delete_80" ></div>
//   </div>
// Splitting into fragments first (rather than one global multiline regex) tolerates
// attribute-order/whitespace drift in the surrounding markup better than a single big match.
function parseRoleDetailHtml(html) {
  const permissions = {};
  const blocks = html.split('<div class="row page-permissions">').slice(1);
  for (const block of blocks) {
    const labelMatch = block.match(/<label>([^<]+)<\/label>/);
    if (!labelMatch) continue;
    const label = labelMatch[1].trim();
    const checked = (prefix) => new RegExp(`id="${prefix}_\\d+"[^>]*checked`).test(block);
    permissions[label] = { view: checked('view'), addedit: checked('addedit'), delete: checked('delete') };
  }
  return permissions;
}

async function refreshPermissions() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const roles = await fetchRoles();
      const nextCache = {};
      for (const role of roles) {
        const html = await fetchRoleDetailHtml(role.id);
        nextCache[role.roleName] = parseRoleDetailHtml(html);
      }
      cache = nextCache;
      roleList = roles;
      lastRefreshedAt = Date.now();
      lastRefreshError = null;
    } catch (err) {
      lastRefreshError = err;
      console.error('Role-permission refresh from FlyThai failed:', err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// Called once at server startup - blocking, so the very first request never races an empty cache.
async function initRolePermissions() {
  await refreshPermissions();
  setInterval(refreshPermissions, REFRESH_INTERVAL_MS);
}

function isStale() {
  return Date.now() - lastRefreshedAt > REFRESH_INTERVAL_MS;
}

function getRoleList() {
  if (isStale()) refreshPermissions();
  return roleList;
}

const DEGRADED_NOTE =
  '_(Permission check unavailable right now — proceeding without role restrictions; the FlyThai connection may need refreshing.)_\n\n';

// Master gate: can this role open the chatbot at all? Checked once, before any capability runs.
function canUseBot(roleName) {
  if (isStale()) refreshPermissions();
  if (!cache) return { allowed: true, degraded: true }; // never successfully populated - fail open
  if (!roleName) {
    return { allowed: false, degraded: false, message: 'Please pick your role from the dropdown above before we start.' };
  }
  const perms = cache[roleName];
  if (!perms) {
    return { allowed: false, degraded: false, message: `I don't recognize the role "${roleName}" — please pick one from the dropdown.` };
  }
  const page = perms[CHAT_BOT_PAGE];
  if (page && page.view) return { allowed: true, degraded: false };
  return {
    allowed: false,
    degraded: false,
    message: `The **${roleName}** role doesn't have access to the Chat Bot yet — ask an Admin/Director to enable it under Manage Users → Roles → Chat Bot System.`,
  };
}

const ACTION_LABEL = { view: 'view', addedit: 'edit', delete: 'delete' };

// Per-capability gate: does this role have `action` on `pageLabel`? Called only after canUseBot
// already passed, so an unpopulated cache / unknown role is treated the same way (fail open) here.
function requirePermission(roleName, pageLabel, action) {
  if (!cache || !roleName || !cache[roleName]) return { allowed: true, degraded: true };
  const page = cache[roleName][pageLabel];
  if (page && page[action]) return { allowed: true };
  return {
    allowed: false,
    message: `The **${roleName}** role doesn't have ${ACTION_LABEL[action] || action} access to ${pageLabel}, so I can't do that.`,
  };
}

module.exports = {
  initRolePermissions,
  refreshPermissions,
  getRoleList,
  canUseBot,
  requirePermission,
  DEGRADED_NOTE,
};
