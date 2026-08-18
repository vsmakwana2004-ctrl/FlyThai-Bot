const { getPool } = require('./db');

// FlyThai's admin panel (flythai.arkinfosoft.in) has its own real RBAC system under Manage Users ->
// Roles: each role gets independent view/addedit/delete checkboxes per "page" (Booking, Agents
// Configuration, Account Master, a dedicated "Chat Bot System" page, ...). This module mirrors that
// same permission model here so it can never drift out of sync with what an Admin/Director actually
// configures in /Role/Index.
//
// Originally this scraped the server-rendered /RoleDetail/{id} HTML page (no clean live JSON API
// was found - /Role/GetAllRole and /User/GetAllUser 500 on every request-shape tried). The exact
// same data turned out to live in three plain tables in the database this chatbot already has
// direct read access to (Roles, AdminPage, AdminPageRoleMapping) - reading those directly is
// faster, can't break from a future HTML/markup change on FlyThai's side, and needs no live HTTP
// call or session cookie at all.

const REFRESH_INTERVAL_MS = 20 * 60 * 1000;
// A role/permission edit on FlyThai's own /Role/Index bumps Roles.UpdatedOn or
// AdminPageRoleMapping.UpdatedOn - polling just MAX(that) every few seconds is a single cheap
// aggregate (no join, no per-row data), so it can run far more often than a full cache rebuild
// without meaningfully loading the database. The full refresh (fetchRolesAndPermissions) only runs
// when this cheap check actually finds a newer timestamp than last seen - see
// checkForChangesAndRefreshIfNeeded. REFRESH_INTERVAL_MS/isStale() below stay as a hard-ceiling
// fallback in case this check ever misses something (e.g. a row edited without bumping UpdatedOn).
const STALE_CHECK_INTERVAL_MS = 15 * 1000;
// The one page whose permission gates whether a role can use the chatbot AT ALL - distinct from the
// per-capability pages (Booking, Agents Configuration, ...) checked once past this gate.
const CHAT_BOT_PAGE = 'Chat Bot System';

let cache = null; // { [roleName]: { [pageLabel]: { view, addedit, delete } } } - null until first successful refresh
let roleList = []; // [{ id, roleName }]
let lastRefreshedAt = 0;
let lastRefreshError = null;
let refreshing = null; // in-flight refresh promise, so concurrent staleness checks don't pile up requests
let lastKnownChangeAt = null; // Date - the newest Roles/AdminPageRoleMapping UpdatedOn seen so far

async function fetchRolesAndPermissions() {
  const pool = await getPool();
  const rolesResult = await pool
    .request()
    .query('SELECT Id, RoleName FROM Roles WHERE IsDeleted = 0 AND IsActive = 1');
  const roles = rolesResult.recordset.map((r) => ({ id: r.Id, roleName: r.RoleName }));

  const mappingResult = await pool.request().query(`
    SELECT m.RoleId, ap.DisplayMenuName, m.AllowToView, m.AllowToAddEdit, m.AllowToDelete
    FROM AdminPageRoleMapping m
    JOIN AdminPage ap ON ap.Id = m.PageId
  `);

  const permsByRoleId = {};
  for (const row of mappingResult.recordset) {
    if (!permsByRoleId[row.RoleId]) permsByRoleId[row.RoleId] = {};
    permsByRoleId[row.RoleId][row.DisplayMenuName] = {
      view: !!row.AllowToView,
      addedit: !!row.AllowToAddEdit,
      delete: !!row.AllowToDelete,
    };
  }

  const nextCache = {};
  for (const role of roles) {
    nextCache[role.roleName] = permsByRoleId[role.id] || {};
  }
  return { roles, cache: nextCache };
}

async function refreshPermissions() {
  if (refreshing) return refreshing;
  refreshing = (async () => {
    try {
      const { roles, cache: nextCache } = await fetchRolesAndPermissions();
      cache = nextCache;
      roleList = roles;
      lastRefreshedAt = Date.now();
      lastRefreshError = null;
    } catch (err) {
      lastRefreshError = err;
      console.error('Role-permission refresh from the database failed:', err.message);
    } finally {
      refreshing = null;
    }
  })();
  return refreshing;
}

// The cheap half of the staleness check - just the newest UpdatedOn across the two tables an
// Admin's role/permission edit actually touches, no role/page data itself. CreatedOn covers a
// brand-new role/mapping row whose UpdatedOn is still NULL (never edited since insert).
async function fetchLatestChangeTimestamp() {
  const pool = await getPool();
  const result = await pool.request().query(`
    SELECT MAX(ts) AS latest FROM (
      SELECT COALESCE(UpdatedOn, CreatedOn) AS ts FROM Roles WHERE IsDeleted = 0
      UNION ALL
      SELECT COALESCE(UpdatedOn, CreatedOn) AS ts FROM AdminPageRoleMapping
    ) x
  `);
  return result.recordset[0] && result.recordset[0].latest ? new Date(result.recordset[0].latest) : null;
}

// Runs every STALE_CHECK_INTERVAL_MS - only triggers the real (heavier) refreshPermissions() when
// the cheap check above actually finds something newer than last seen, so a role edit on FlyThai's
// side is picked up within seconds instead of waiting out the full REFRESH_INTERVAL_MS.
async function checkForChangesAndRefreshIfNeeded() {
  try {
    const latest = await fetchLatestChangeTimestamp();
    if (latest && (!lastKnownChangeAt || latest > lastKnownChangeAt)) {
      lastKnownChangeAt = latest;
      await refreshPermissions();
    }
  } catch (err) {
    console.error('Role-permission staleness check failed:', err.message);
  }
}

// Called once at server startup - blocking, so the very first request never races an empty cache.
async function initRolePermissions() {
  await refreshPermissions();
  lastKnownChangeAt = await fetchLatestChangeTimestamp().catch(() => null);
  setInterval(checkForChangesAndRefreshIfNeeded, STALE_CHECK_INTERVAL_MS);
  // Kept as a hard-ceiling safety net alongside the fast check above - see isStale()'s own use in
  // getRoleList()/canUseBot(), which this interval backs up in case a request arrives in between.
  setInterval(refreshPermissions, REFRESH_INTERVAL_MS);
}

function isStale() {
  return Date.now() - lastRefreshedAt > REFRESH_INTERVAL_MS;
}

function getRoleList() {
  if (isStale()) refreshPermissions();
  return roleList;
}

// Resolves a FlyThai user id (the "chatbot_key" the admin panel's ChatBot/Index iframe passes) to
// that person's own name/email/role, straight from the [User] table - lets the chatbot recognize
// who's already logged into the real admin panel without asking them to log in a second time here.
async function getUserById(userId) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('id', userId)
    .query('SELECT TOP 1 Id, Name, Email, RoleId FROM [User] WHERE Id = @id AND IsDelete = 0');
  const row = result.recordset[0];
  if (!row) return null;
  const role = getRoleList().find((r) => r.id === row.RoleId);
  return { id: row.Id, name: row.Name, email: row.Email, roleId: row.RoleId, roleName: role ? role.roleName : null };
}

const DEGRADED_NOTE =
  '_(Permission check unavailable right now — proceeding without role restrictions; the database connection may need checking.)_\n\n';

// Master gate: can this role open the chatbot at all? Checked once, before any capability runs.
function canUseBot(roleName) {
  if (isStale()) refreshPermissions();
  if (!cache) return { allowed: true, degraded: true }; // never successfully populated - fail open
  if (!roleName) {
    return { allowed: false, degraded: false, message: 'Please log in with your FlyThai account first.' };
  }
  const perms = cache[roleName];
  if (!perms) {
    return { allowed: false, degraded: false, message: `I don't recognize the role "${roleName}" — please log in again.` };
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
  getUserById,
  canUseBot,
  requirePermission,
  DEGRADED_NOTE,
};
