// Shared "let me out of here" detection.
//
// Every guided flow in this app (booking/quotation creation, status change, PDF choice) used to be
// a one-way door: outside the very first phase there was no wording at all that abandoned it, so an
// unrelated question ("how many bookings are there?") just bounced off the same prompt forever and
// the only real escape was the New Chat button - which throws the whole conversation away.

// Explicitly about the whole thing, so it's safe to honour in ANY phase - including the ones where
// a bare "cancel" already means something narrower ("don't add THIS hotel").
//
// The verb and noun are kept close together (only a short determiner/adjective allowed between
// them), not "anywhere within 25 characters" - that looser version matched free text with zero
// cancel intent purely by coincidence. Reproduced live: a booking note reading "end to end test
// booking, booked by Claude, ..." matched "end" ... "booking" (25 chars apart) and silently wiped
// an entire in-progress booking - hotel, 4 itinerary items, pricing, all of it - with no warning,
// while the user was simply typing a note, not trying to cancel anything.
// "end" was in this verb list too, but it's too common in unrelated phrases ("weekend", "end
// date", "end to end", "in the end") to safely pair with a noun even a few words later - "week end
// booking" still matched with zero gap. Dropped rather than chased further: cancel/stop/discard/
// abort/forget/leave/exit already cover the same real intent without that risk.
const CANCEL_FILLER = String.raw`(?:this|the|that|my|our|whole|entire)`;
const WHOLE_FLOW_CANCEL_RE = new RegExp(
  String.raw`\b(cancel|stop|abort|discard|forget|leave|exit)\b(?:\s+${CANCEL_FILLER}){0,2}\s+\b(booking|quotation|flow|process|everything|all of (it|this)|whole thing)\b` +
    String.raw`|\b(start over|start again|restart)\b`,
  'i'
);

// A bare "cancel" / "stop" / "quit" and nothing else. Anchored on both ends so narrower phrases
// ("cancel this hotel", "no logo") are left to the flow that knows what they mean.
const BARE_CANCEL_RE =
  /^\s*(cancel|stop|quit|exit|abort|nevermind|never mind|forget it|leave it|no thanks|rehne do|chhod do|chhodo|band karo)\b[\s.!]*$/i;

function isWholeFlowCancel(text) {
  return WHOLE_FLOW_CANCEL_RE.test(text);
}

function isBareCancel(text) {
  return BARE_CANCEL_RE.test(text);
}

function isAnyCancel(text) {
  return isWholeFlowCancel(text) || isBareCancel(text);
}

module.exports = { isWholeFlowCancel, isBareCancel, isAnyCancel };
