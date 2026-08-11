const { getPool } = require('./db');

// Deterministic name -> id lookups, run in code (not the LLM) so booking data never uses a hallucinated id.

// An exact (case-insensitive) name match wins outright before falling back to the fuzzy LIKE
// search - without this, an agent whose name is a prefix of another's ("Ajay Modi" vs "Ajay Modi
// Travels") could never be picked: typing the exact name, or clicking that exact agent from the
// dropdown (which resends its stored Name as plain text), both re-ran the same LIKE '%Ajay Modi%'
// search and matched both records again, re-asking "which one did you mean?" forever. Mirrors the
// same exact-first-then-fuzzy pattern findDestinations already uses for short codes.
async function findAgent(nameQuery) {
  const pool = await getPool();
  const trimmed = nameQuery.trim();

  const exact = await pool
    .request()
    .input('name', trimmed)
    .query(`SELECT TOP 1 Id, Name, Phone, Email, Address FROM Agents WHERE IsDeleted = 0 AND UPPER(Name) = UPPER(@name)`);
  if (exact.recordset.length === 1) return exact.recordset;

  const result = await pool
    .request()
    .input('q', `%${trimmed}%`)
    .query(`SELECT TOP 5 Id, Name, Phone, Email, Address FROM Agents WHERE IsDeleted = 0 AND Name LIKE @q ORDER BY Name`);
  return result.recordset;
}

// Wider, typeahead-style listing for the chat UI's live agent dropdown (not the strict 0/1/many
// resolution findAgent does for the booking flow) - up to 20 real registered agents, filtered by
// whatever's been typed so far (empty query -> first 20 alphabetically).
async function listAgents(nameQuery = '') {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT TOP 20 Id, Name, Phone FROM Agents WHERE IsDeleted = 0 AND Name LIKE @q ORDER BY Name`);
  return result.recordset;
}

// "Koh" and "Ko" are both common transliterations of the Thai island prefix (เกาะ) - agents type
// either one interchangeably ("Koh Samui" / "Ko Samui"), and the Destination table itself isn't
// consistent about which spelling it stores (Ko Samui, Ko Phangan, Ko Tao vs koh yao noi). Swapping
// the prefix and retrying is a safe alternate spelling, not a guess, so it's tried before giving up.
function swapKohKoPrefix(name) {
  if (/^koh\s/i.test(name)) return name.replace(/^koh\s/i, 'Ko ');
  if (/^ko\s/i.test(name)) return name.replace(/^ko\s/i, 'Koh ');
  return null;
}

async function queryDestinationsByName(pool, trimmed) {
  return pool
    .request()
    .input('q', `%${trimmed}%`)
    .query(`SELECT TOP 3 Id, Name, ShortCode FROM Destination WHERE IsDelete = 0 AND (Name LIKE @q OR ShortCode LIKE @q) ORDER BY Name`);
}

// Accepts either the full destination name ("Bangkok") or the real short code shown on the real
// form's checkboxes ("BKK") - an exact short-code match wins outright (codes are meant to be
// typed exactly), otherwise falls back to a fuzzy match against both Name and ShortCode.
async function findDestinations(names) {
  const pool = await getPool();
  const matches = [];
  const notFound = [];
  for (const name of names) {
    const trimmed = name.trim();

    const exactCode = await pool
      .request()
      .input('code', trimmed)
      .query(`SELECT TOP 1 Id, Name, ShortCode FROM Destination WHERE IsDelete = 0 AND UPPER(ShortCode) = UPPER(@code)`);
    if (exactCode.recordset.length === 1) {
      matches.push(exactCode.recordset[0]);
      continue;
    }

    let result = await queryDestinationsByName(pool, trimmed);
    if (result.recordset.length === 0) {
      const altTrimmed = swapKohKoPrefix(trimmed);
      if (altTrimmed) result = await queryDestinationsByName(pool, altTrimmed);
    }
    if (result.recordset.length === 1) matches.push(result.recordset[0]);
    else if (result.recordset.length > 1) matches.push({ ambiguous: true, name, options: result.recordset });
    else notFound.push(name);
  }
  return { matches, notFound };
}

// Wider, typeahead-style listing for the chat UI's live hotel dropdown (mirrors listAgents) - up
// to 20 real registered hotels, optionally scoped to one destination (the trip's already-chosen
// destination, so the dropdown only shows hotels that actually make sense there).
async function listHotels(nameQuery = '', destinationId = null) {
  const pool = await getPool();
  const request = pool.request().input('q', `%${nameQuery}%`);
  let query = `SELECT TOP 20 h.Id, h.Name, h.RatePerNight, h.RatePerNightCurrency, d.Name AS Destination
    FROM Hotel h
    LEFT JOIN Destination d ON d.Id = h.Destination AND d.IsDelete = 0
    WHERE h.IsDelete = 0 AND h.Name LIKE @q`;
  if (destinationId) {
    request.input('destId', destinationId);
    query += ' AND h.Destination = @destId';
  }
  query += ' ORDER BY h.Name';
  const result = await request.query(query);
  return result.recordset;
}

async function findHotel(nameQuery) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT TOP 5 Id, Name, Address, Email, PhoneNumber, Destination, RatePerNight, RatePerNightCurrency FROM Hotel WHERE IsDelete = 0 AND Name LIKE @q ORDER BY Name`);
  return result.recordset;
}

async function findPickupOrParticular(nameQuery) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    // Category = 'Transfer' scopes this to transfer entries only - Particular also holds
    // 'SightSeeing' rows (see findSightseeing) which used to leak into transfer name/code matches.
    .query(`SELECT TOP 5 Id, Name, Code, Category, AdultsPrice, ChildrenPrice, CarPrice, SuvPrice, VanPrice, Currency FROM Particular WHERE IsDeleted = 0 AND Category = 'Transfer' AND (Name LIKE @q OR Code LIKE @q) ORDER BY Name`);
  return result.recordset;
}

async function findPickup(nameQuery) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT TOP 5 Id, Name, Destination FROM Pickup WHERE IsDelete = 0 AND Name LIKE @q ORDER BY Name`);
  return result.recordset;
}

// Wider, typeahead-style listing for the chat UI's live pickup/drop-off dropdown (mirrors
// listAgents/listHotels) - the real Add Transfer form uses the same Pickup table for both fields.
async function listPickups(nameQuery = '') {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT TOP 20 Id, Name FROM Pickup WHERE IsDelete = 0 AND Name LIKE @q ORDER BY Name`);
  return result.recordset;
}

// Wider, typeahead-style listing for the chat UI's live transfer name/code dropdown - matches
// against both Name and Code since the real form shows Transfer Code and Transfer Name together.
async function listParticulars(nameQuery = '') {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT TOP 20 Id, Name, Code FROM Particular WHERE IsDeleted = 0 AND Category = 'Transfer' AND (Name LIKE @q OR Code LIKE @q) ORDER BY Name`);
  return result.recordset;
}

// Particular also holds the real site's Sightseeing catalogue (Category = 'SightSeeing'), each row
// optionally flagged per weekday (Sunday..Saturday bit columns) for which days it actually runs -
// the real Add Sightseeing form filters its dropdown the same way once a date is picked. A NULL
// flag means "no restriction for that day" (matches the real form's own `!== false` check), so it
// counts as available too - only an explicit 0/false excludes that weekday.
const WEEKDAY_COLUMNS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

function weekdayFilterSql(weekday) {
  return weekday && WEEKDAY_COLUMNS.includes(weekday) ? ` AND (${weekday} = 1 OR ${weekday} IS NULL)` : '';
}

async function findSightseeing(nameQuery, weekday) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(
      `SELECT TOP 5 Id, Name, Code, AdultsPrice, ChildrenPrice, Currency FROM Particular WHERE IsDeleted = 0 AND Category = 'SightSeeing' AND (Name LIKE @q OR Code LIKE @q)${weekdayFilterSql(weekday)} ORDER BY Name`
    );
  return result.recordset;
}

// Wider, typeahead-style listing for the chat UI's live sightseeing code/name dropdown (mirrors
// listParticulars).
async function listSightseeings(nameQuery = '', weekday) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(
      `SELECT TOP 20 Id, Name, Code FROM Particular WHERE IsDeleted = 0 AND Category = 'SightSeeing' AND (Name LIKE @q OR Code LIKE @q)${weekdayFilterSql(weekday)} ORDER BY Name`
    );
  return result.recordset;
}

async function findVehicle(nameQuery) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT TOP 5 Id, Name, Capacity FROM VehicalMaster WHERE IsDeleted = 0 AND IsActive = 1 AND Name LIKE @q ORDER BY Name`);
  return result.recordset;
}

async function findRestaurant(nameQuery) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT TOP 5 Id, Name, Address, LunchPriceForAdults, DinnerPriceForAdults FROM RestaurantMaster WHERE IsDelete = 0 AND Name LIKE @q ORDER BY Name`);
  return result.recordset;
}

// Wider, typeahead-style listing for the chat UI's live restaurant-name dropdown (mirrors
// listPickups/listSightseeings) - without this, restaurant name was the one itinerary-item field
// with no dropdown, so a user with no way to know real restaurant names just kept guessing wrong
// ones and getting "I couldn't find a restaurant matching ..." on repeat.
async function listRestaurants(nameQuery = '') {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT TOP 20 Id, Name, Address FROM RestaurantMaster WHERE IsDelete = 0 AND Name LIKE @q ORDER BY Name`);
  return result.recordset;
}

// Full option lists for fields the real site shows as a fixed dropdown/checkbox set (not a
// type-ahead search over a huge table) - small enough to just show all of, up front.
async function listDestinations(nameQuery = '') {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('q', `%${nameQuery}%`)
    .query(`SELECT Id, Name, ShortCode FROM Destination WHERE IsDelete = 0 AND (Name LIKE @q OR ShortCode LIKE @q) ORDER BY Name`);
  return result.recordset;
}

// Wider, typeahead-style listing for the chat UI's live room-category dropdown, scoped to one
// hotel (a room type only makes sense in the context of the specific hotel it belongs to) - real
// registered HotelRoomType rows, so "Superior Room Sin/Dou" no longer has to be typed from memory.
// Aliased to Name (not RoomName) so it fits the same {Id, Name, ...} shape every other lookup uses.
async function listHotelRoomTypes(hotelId, nameQuery = '') {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('hotelId', hotelId)
    .input('q', `%${nameQuery}%`)
    .query(
      `SELECT TOP 20 Id, RoomName AS Name, RatePerNight, Currency FROM HotelRoomType WHERE IsDelete = 0 AND IsActive = 1 AND HotelId = @hotelId AND RoomName LIKE @q ORDER BY RoomName`
    );
  return result.recordset;
}

// Strict single lookup used to auto-fill the rate-per-night step once a room type has been picked
// (either from the dropdown or typed to match one exactly) - not the wider typeahead above.
async function findHotelRoomType(hotelId, roomName) {
  const pool = await getPool();
  const result = await pool
    .request()
    .input('hotelId', hotelId)
    .input('name', roomName)
    .query(`SELECT TOP 1 Id, RoomName, RatePerNight, Currency FROM HotelRoomType WHERE IsDelete = 0 AND IsActive = 1 AND HotelId = @hotelId AND RoomName = @name`);
  return result.recordset[0] || null;
}

async function listVehicles() {
  const pool = await getPool();
  const result = await pool.request().query(`SELECT Id, Name, Capacity FROM VehicalMaster WHERE IsDeleted = 0 AND IsActive = 1 ORDER BY Name`);
  return result.recordset;
}

module.exports = {
  findAgent,
  listAgents,
  findDestinations,
  findHotel,
  listHotels,
  findPickupOrParticular,
  findPickup,
  listPickups,
  listParticulars,
  findSightseeing,
  listSightseeings,
  findVehicle,
  findRestaurant,
  listRestaurants,
  listDestinations,
  listVehicles,
  listHotelRoomTypes,
  findHotelRoomType,
};
