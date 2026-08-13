const { safeFetch } = require('./bookingApi');

function base() {
  return process.env.FLYTHAI_BASE_URL || 'https://flythai.arkinfosoft.in';
}

// Runs the exact same login FlyThai's own "/" page form does (GET for the page + antiforgery
// token, POST username/password), so a staff member can prove who they are with their real FlyThai
// credentials. Returns their UserId plus the resulting session cookie (UserName/UserId/
// UserDisplayName/UserOnline) - confirmed live that these 4 cookies alone (no antiforgery cookie
// needed) are enough to authenticate later requests as this specific person, so this becomes their
// own per-session identity for live FlyThai calls (see requestContext.js) instead of the one shared
// FLYTHAI_SESSION_COOKIE every write used to go through regardless of who was actually chatting.
async function verifyLogin(username, password) {
  const loginPageRes = await safeFetch(`${base()}/`, { redirect: 'manual' });
  const html = await loginPageRes.text();
  const tokenMatch = html.match(/__RequestVerificationToken" type="hidden" value="([^"]+)"/);
  if (!tokenMatch) throw new Error('Could not load the FlyThai login page.');
  const token = tokenMatch[1];

  // The antiforgery token is tied to the antiforgery cookie issued alongside it on the same GET -
  // FlyThai rejects the POST without it, even with a correct/current token value.
  const pageCookies = loginPageRes.headers.getSetCookie ? loginPageRes.headers.getSetCookie() : [loginPageRes.headers.get('set-cookie') || ''];
  const antiforgeryCookie = pageCookies.map((c) => c.split(';')[0]).find((c) => c.includes('Antiforgery'));

  const body = new URLSearchParams({ UserName: username, Password: password, __RequestVerificationToken: token });
  const loginRes = await safeFetch(`${base()}/`, {
    method: 'POST',
    redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      cookie: antiforgeryCookie || '',
    },
    body: body.toString(),
  });

  // A successful login redirects (302) to /User/Index and sets a UserId cookie; a wrong
  // username/password just re-renders the same login page (200, no UserId cookie) - confirmed live
  // against both cases, not assumed.
  const resultCookies = loginRes.headers.getSetCookie ? loginRes.headers.getSetCookie() : [loginRes.headers.get('set-cookie') || ''];
  const userIdCookie = resultCookies.find((c) => c.startsWith('UserId='));
  if (loginRes.status !== 302 || !userIdCookie) {
    return { ok: false };
  }
  const userId = Number(decodeURIComponent(userIdCookie.split(';')[0].split('=')[1]));
  const sessionCookie = resultCookies.map((c) => c.split(';')[0]).join('; ');
  return { ok: true, userId, sessionCookie };
}

// Read-only role lookup by UserId, via the existing shared service session (same one every other
// live FlyThai call in this app already uses) - safe to reuse since this never writes anything.
async function getUserRoleId(userId) {
  const cookie = process.env.FLYTHAI_SESSION_COOKIE;
  if (!cookie) {
    const err = new Error('FLYTHAI_SESSION_COOKIE is not set in .env.');
    err.code = 'NO_SESSION_COOKIE';
    throw err;
  }
  const res = await safeFetch(`${base()}/user/GetUserById?id=${userId}`, {
    headers: { accept: 'application/json', cookie, 'x-requested-with': 'XMLHttpRequest' },
  });
  if (!res.ok) throw new Error(`FlyThai /user/GetUserById returned ${res.status}`);
  const data = await res.json();
  return { roleId: data.roleId, name: data.name };
}

module.exports = { verifyLogin, getUserRoleId };
