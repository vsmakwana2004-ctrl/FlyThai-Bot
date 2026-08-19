// Shared typo-tolerant word matching, used by every intent detector that watches for specific
// trigger words in free-typed chat text (documents.js's PDF/report requests, statusUpdate.js's
// change verbs, jobSheetCopy.js's copy requests, ...). Originally lived only in documents.js -
// pulled out here once a second module needed the exact same behavior, so both stay in sync instead
// of drifting apart with their own separate (and possibly inconsistent) typo tolerance.

// Plain Levenshtein edit distance - lets a typo'd trigger word ("downlode", "qutaion", "chnge")
// still match instead of silently falling through to a completely different (wrong) response path -
// reproduced live: "downlode qutaion of FTQ09260005" matched none of the real words exactly, so the
// message fell through to an ordinary detail lookup instead of offering a PDF link, with no error or
// sign anything had gone wrong.
function levenshtein(a, b) {
  const m = a.length;
  const n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1]);
    }
  }
  return dp[m][n];
}

// True if any word in `text` is an exact or near-exact (typo-tolerant) match for one of `targets`.
// Tolerance scales with word length so short words ("pdf") still require an exact/near-exact hit
// rather than matching almost anything. `exclude` is a { [target]: [realWordsToNeverTreatAsATypo] }
// map for known false-positive collisions (e.g. "general" is edit-distance 2 from "generate", the
// same distance a real typo like "generat"/"genrate" needs to still match) - checked as an exact-word
// denylist per target instead of loosening the tolerance globally, which would also lose genuine
// typo tolerance for that target.
function fuzzyWordMatch(text, targets, exclude = {}) {
  const words = text.toLowerCase().match(/[a-z]+/g) || [];
  for (const w of words) {
    for (const target of targets) {
      if (w === target) return true;
      if ((exclude[target] || []).includes(w)) continue;
      const maxDist = target.length <= 4 ? 1 : 2;
      if (Math.abs(w.length - target.length) <= maxDist && levenshtein(w, target) <= maxDist) return true;
    }
  }
  return false;
}

module.exports = { levenshtein, fuzzyWordMatch };
