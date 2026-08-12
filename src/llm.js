const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Groq's free tier enforces both a tokens-per-minute AND a tokens-per-day cap, per model.
// Groq tells us exactly how long to wait when either is hit.
function parseRetryAfterSeconds(errorText) {
  const m = errorText.match(/try again in ([\d.]+)s/i);
  return m ? parseFloat(m[1]) : null;
}

// Ordered list of free Groq models to try. If one model's daily/per-minute quota runs out
// mid-demo, we fall through to the next rather than getting stuck - each model has its own
// separate quota. GROQ_MODEL (if set) is tried first.
const FALLBACK_MODELS = [
  'qwen/qwen3.6-27b',
  'llama-3.3-70b-versatile',
  'llama-3.1-8b-instant',
  'openai/gpt-oss-20b',
  'openai/gpt-oss-120b',
];

// preferredModel lets a caller ask for a specific model FIRST for this one call (e.g. a fast small
// model for a structured/mechanical task where the default GROQ_MODEL would be needless overkill),
// while still falling through to the normal GROQ_MODEL -> FALLBACK_MODELS chain if it fails - so a
// speed preference never becomes a hard dependency on one model actually being available.
function modelsToTry(preferredModel) {
  const configured = process.env.GROQ_MODEL;
  const list = [preferredModel, configured, ...FALLBACK_MODELS].filter(Boolean);
  return [...new Set(list)];
}

// GROQ_API_KEY_2 / _3 belong to separate Groq accounts, so each one carries its OWN independent
// daily token quota - one account maxing out for the day does not touch the others. GROQ_API_KEY
// is always tried first; the rest are fallback-only, used once every model has exhausted it.
function keysToTry() {
  const keys = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEY_2, process.env.GROQ_API_KEY_3].filter(
    (k) => typeof k === 'string' && k.trim()
  );
  return [...new Set(keys)];
}

// reasoning_effort's valid values differ per model family - only Qwen 3.6 accepts "none";
// gpt-oss models require low/medium/high; other models (llama, compound) don't take it at all.
function reasoningParamsFor(model) {
  if (model.startsWith('qwen/')) return { reasoning_effort: 'none' };
  if (model.startsWith('openai/gpt-oss')) return { reasoning_effort: 'low' };
  return {};
}

async function callOnce(model, apiKey, messages, temperature) {
  const res = await fetch(GROQ_URL, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ model, messages, temperature, ...reasoningParamsFor(model) }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    const err = new Error(`Groq API error ${res.status} (model ${model}): ${text}`);
    err.status = res.status;
    err.body = text;
    throw err;
  }

  const data = await res.json();
  let content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error(`Groq returned an empty response (model ${model})`);
  // Safety net: strip any stray <think>...</think> reasoning trace that slips through.
  content = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  if (!content) throw new Error(`Groq returned only a reasoning trace with no final answer (model ${model})`);
  return content;
}

async function callLLM(messages, { temperature = 0.2, model: preferredModel } = {}) {
  const keys = keysToTry();
  if (keys.length === 0) {
    const err = new Error('No Groq API key is set. Add GROQ_API_KEY to your .env file.');
    err.code = 'NO_API_KEY';
    throw err;
  }

  const candidates = modelsToTry(preferredModel);
  let lastErr;
  // Model is the outer loop, key the inner one: this stays on the preferred model across every
  // available account before dropping to a lower-quality fallback model - so model choice only
  // degrades once ALL accounts are out of quota for that model, not as soon as the first is.
  for (const model of candidates) {
    for (const apiKey of keys) {
      // Up to 2 tries per (model, key): the first attempt, and one quick retry only if Groq says a
      // short wait fixes it (a per-minute blip). A long wait (that account's daily quota is
      // exhausted) or any other error moves on to the next key, then the next model - never stall
      // waiting on one account.
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          return await callOnce(model, apiKey, messages, temperature);
        } catch (err) {
          lastErr = err;
          if (err.status === 429 && attempt === 1) {
            const waitSeconds = parseRetryAfterSeconds(err.body || '');
            if (waitSeconds !== null && waitSeconds <= 8) {
              await sleep(waitSeconds * 1000 + 250);
              continue;
            }
          }
          break; // give up on this (model, key) pair, try the next key (or next model)
        }
      }
    }
  }
  throw lastErr;
}

module.exports = { callLLM };
