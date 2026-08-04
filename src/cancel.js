// Shared "let me out of here" detection.
//
// Every guided flow in this app (booking/quotation creation, status change, PDF choice) used to be
// a one-way door: outside the very first phase there was no wording at all that abandoned it, so an
// unrelated question ("how many bookings are there?") just bounced off the same prompt forever and
// the only real escape was the New Chat button - which throws the whole conversation away.

// Explicitly about the whole thing, so it's safe to honour in ANY phase - including the ones where
// a bare "cancel" already means something narrower ("don't add THIS hotel").
const WHOLE_FLOW_CANCEL_RE =
  /\b(cancel|stop|abort|discard|forget|leave|end|exit)\b[^.]{0,25}\b(booking|quotation|flow|process|everything|all of (it|this)|whole thing)\b|\b(start over|start again|restart)\b/i;

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
