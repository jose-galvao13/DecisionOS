/** One rule for every place a password is set (register, add a team member,
 *  reset, change). Returns an error message, or null when it is acceptable.
 *  bcrypt only looks at the first 72 bytes, so a longer password would be
 *  silently truncated — reject it instead of pretending it was all used. */
export function passwordProblem(password) {
  if (typeof password !== "string" || password.length < 8) return "password must be at least 8 characters";
  if (Buffer.byteLength(password, "utf8") > 72) return "password must be at most 72 bytes (about 72 characters)";
  return null;
}
