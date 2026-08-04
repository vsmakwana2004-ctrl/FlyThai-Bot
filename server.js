require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const { handleChat, cancelFlows } = require('./src/chat');
const { listAgents, listHotels, listPickups, listParticulars, listSightseeings, listRestaurants, listVehicles } = require('./src/lookups');

const app = express();
app.use(cors());
// Bounded so an accidental huge paste is rejected as JSON by our own handler below, rather than by
// body-parser's default HTML error page (which the browser then failed to parse, surfacing as a
// misleading "Could not connect to the server").
app.use(express.json({ limit: '256kb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Long enough for any real question, short enough to keep one message from eating the Groq
// free-tier token budget in a single shot.
const MAX_MESSAGE_CHARS = 2000;

app.post('/api/chat', async (req, res) => {
  try {
    const { message, sessionId } = req.body || {};
    if (!message || typeof message !== 'string' || !message.trim()) {
      return res.status(400).json({ error: 'Please type a question first.' });
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      return res.status(400).json({ error: `That message is a bit long (${message.length} characters). Please shorten it to under ${MAX_MESSAGE_CHARS} characters and try again.` });
    }
    const sid = sessionId && typeof sessionId === 'string' ? sessionId : 'default';
    const result = await handleChat(sid, message.trim());
    res.json(result);
  } catch (err) {
    console.error(err);
    if (err.code === 'NO_API_KEY') {
      return res.status(500).json({ error: 'The AI service is not configured (GROQ_API_KEY is missing from the .env file). Please add it and restart the server.' });
    }
    // Groq's free tier caps tokens-per-minute, and one question costs roughly 6-9k of an 8k
    // budget. Asking two questions in quick succession therefore hits the cap routinely. This
    // used to surface as a generic "something went wrong", which reads like a bug rather than
    // "wait a moment" - so say what actually happened and for how long.
    if (err.status === 429) {
      const wait = (err.body || '').match(/try again in ([\d.]+)s/i);
      return res.status(429).json({
        error: wait
          ? `The AI service hit its free-tier rate limit. Please wait about ${Math.ceil(parseFloat(wait[1]))} seconds and ask again.`
          : 'The AI service hit its free-tier rate limit. Please wait a moment and ask again.',
      });
    }
    if (err.code === 'NO_SESSION_COOKIE' || err.code === 'SESSION_EXPIRED') {
      return res.status(503).json({ error: 'The connection to the FlyThai booking site needs to be refreshed, so saving changes is unavailable right now. Looking up information still works.' });
    }
    // The raw message is logged above; users get something they can act on instead of a stack of
    // database/driver jargon.
    res.status(500).json({ error: 'Sorry, something went wrong while handling that. Please try again, or rephrase your question.' });
  }
});

// Unconditional escape hatch behind the UI's Cancel button - clears whatever guided flow the
// session is in, without needing the user to find the right wording.
app.post('/api/cancel', (req, res) => {
  const { sessionId } = req.body || {};
  const sid = sessionId && typeof sessionId === 'string' ? sessionId : 'default';
  const wasActive = cancelFlows(sid);
  res.json({
    ok: true,
    wasActive,
    answer: wasActive
      ? 'Okay, cancelled — nothing was saved. What would you like to know?'
      : 'There was nothing in progress to cancel. What would you like to know?',
  });
});

// Powers the live agent-name dropdown shown above the chat input while the bot is asking for
// the travel agent/company - read-only, real registered agents only, never invented.
app.get('/api/agents', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const agents = await listAgents(q);
    res.json({ agents });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

app.get('/api/hotels', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const destinationId = req.query.destinationId ? Number(req.query.destinationId) : null;
    const hotels = await listHotels(q, destinationId);
    res.json({ hotels });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

// Powers the live pickup/drop-off dropdown shown above the chat input during transfer collection
// - same Pickup table the real Add Transfer form's Pickup Point and DropOff Point fields use.
app.get('/api/pickups', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const pickups = await listPickups(q);
    res.json({ pickups });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

// Powers the live Transfer Code/Name dropdown - real registered Particular records only.
app.get('/api/transfers', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const transfers = await listParticulars(q);
    res.json({ transfers });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

// Powers the live Sightseeing Code/Name dropdown - scoped to the Particular table's 'SightSeeing'
// category, optionally further filtered to a weekday (matches the real Add Sightseeing form's own
// behaviour of only showing tours that actually run on the day picked).
app.get('/api/sightseeing', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const weekday = typeof req.query.weekday === 'string' ? req.query.weekday : undefined;
    const sightseeing = await listSightseeings(q, weekday);
    res.json({ sightseeing });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

// Powers the live Vehicle Type dropdown. The list is small and fixed, so it's filtered here
// rather than adding a dedicated SQL search like the other lookups.
app.get('/api/vehicles', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const all = await listVehicles();
    const vehicles = q ? all.filter((v) => v.Name.toLowerCase().includes(q)) : all;
    res.json({ vehicles });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

// Powers the live Restaurant Name dropdown during Add Restaurant itinerary collection.
app.get('/api/restaurants', async (req, res) => {
  try {
    const q = typeof req.query.q === 'string' ? req.query.q : '';
    const restaurants = await listRestaurants(q);
    res.json({ restaurants });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Something went wrong: ' + err.message });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// Everything below keeps the /api/* contract to "always JSON, never HTML". The frontend parses
// every response as JSON, so a single HTML error page from Express turned a clear server message
// into "Unexpected token '<'".
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'That request went to an unknown address. Try reloading the page.' });
});

// eslint-disable-next-line no-unused-vars -- Express identifies error handlers by arity (4 args).
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return;
  if (err.type === 'entity.too.large') {
    return res.status(413).json({ error: `That message is too large to send. Please shorten it to under ${MAX_MESSAGE_CHARS} characters and try again.` });
  }
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: "The request couldn't be read. Please reload the page and try again." });
  }
  res.status(500).json({ error: 'Sorry, something went wrong on the server. Please try again in a moment.' });
});

const PORT = process.env.PORT || 3500;
app.listen(PORT, () => {
  console.log(`FlyThai DB Assistant running at http://localhost:${PORT}`);
  // Open the SQL connection now rather than on the first question, so nobody waits ~2.7s for the
  // pool to come up while a real query is in flight. Failure here is not fatal - runReadOnlyQuery
  // retries and reports properly - so this only ever logs.
  require('./src/db')
    .getPool()
    .then(() => console.log('SQL connection pool ready'))
    .catch((err) => console.warn('SQL pool warm-up failed (will retry on first query):', err.message));
});
