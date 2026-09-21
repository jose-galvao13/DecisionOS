// Readable random password for the person adding a team member to hand over.
// Uses the browser's crypto RNG (never Math.random) and rejection sampling, so
// every character is equally likely. No look-alikes (0/O, 1/l/I). Always has
// a lower-case, an upper-case, a digit and a symbol, and stays far below
// bcrypt's 72-byte limit.
const SETS = {
  lower: "abcdefghijkmnpqrstuvwxyz",
  upper: "ABCDEFGHJKLMNPQRSTUVWXYZ",
  digit: "23456789",
  symbol: "!@#$%&*?-_+",
};
const ALL = Object.values(SETS).join("");

function randomBelow(max) {
  const limit = Math.floor(0x100000000 / max) * max; // reject the biased tail
  const buf = new Uint32Array(1);
  do { crypto.getRandomValues(buf); } while (buf[0] >= limit);
  return buf[0] % max;
}
const pick = (chars) => chars[randomBelow(chars.length)];

export function generatePassword(length = 14) {
  const chars = Object.values(SETS).map(pick); // one of each class first...
  while (chars.length < length) chars.push(pick(ALL));
  for (let i = chars.length - 1; i > 0; i--) { // ...then shuffle (Fisher–Yates)
    const j = randomBelow(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}
