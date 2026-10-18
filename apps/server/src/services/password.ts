import argon2 from 'argon2';

/**
 * Password hashing (Q1). argon2id with a per-password salt that argon2 embeds in
 * the digest; nothing here ever sees or stores plaintext beyond the call.
 *
 * Parameters follow the OWASP minimum for argon2id. They are recorded inside the
 * digest, so raising them later does not invalidate existing passwords: an old
 * digest still verifies, and `needsRehash` reports that it should be upgraded on
 * the next successful login.
 */
const HASH_OPTIONS = {
  type: argon2.argon2id,
  memoryCost: 19_456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
} as const;

/** Rejected before hashing, so a 1-character password cannot be stored at all. */
export const MIN_PASSWORD_LENGTH = 12;
/**
 * argon2 has no practical maximum, but an unbounded password is a cheap way to
 * make the server do expensive work.
 */
export const MAX_PASSWORD_LENGTH = 200;

export async function hashPassword(plaintext: string): Promise<string> {
  if (plaintext.length < MIN_PASSWORD_LENGTH) {
    throw new Error(`Password must be at least ${String(MIN_PASSWORD_LENGTH)} characters.`);
  }
  if (plaintext.length > MAX_PASSWORD_LENGTH) {
    throw new Error(`Password must be at most ${String(MAX_PASSWORD_LENGTH)} characters.`);
  }

  return argon2.hash(plaintext, HASH_OPTIONS);
}

/**
 * Verifies a password against a stored digest.
 *
 * Returns `false` rather than throwing for a malformed or absent digest, so a
 * user who has been invited but has not set a password yet takes the same path
 * as a wrong password and reveals nothing about which case applied.
 */
export async function verifyPassword(digest: string | null, plaintext: string): Promise<boolean> {
  if (digest === null || digest === '') return false;

  try {
    return await argon2.verify(digest, plaintext);
  } catch {
    return false;
  }
}

/** True when the digest was made with weaker parameters than current policy. */
export function needsRehash(digest: string): boolean {
  try {
    return argon2.needsRehash(digest, HASH_OPTIONS);
  } catch {
    return false;
  }
}
