import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { AppError, ERROR_CODES } from '@ubmp/shared';

/**
 * Encryption of provider secrets at rest (I5.3, CLAUDE.md).
 *
 * AES-256-GCM with a fresh 12-byte IV per value. The stored form is
 * `v1:<iv>:<tag>:<ciphertext>`, all base64, so a key rotation can add `v2`
 * without guessing what an old row holds. GCM's tag means a tampered row fails
 * to decrypt instead of yielding a wrong token.
 */
export function requireKey(key: Buffer | null): Buffer {
  if (key === null) {
    throw new AppError(
      ERROR_CODES.SERVICE_UNAVAILABLE,
      'Integrations cannot be connected because no encryption key is configured.',
      { hint: 'Set ENCRYPTION_KEY in the server environment (openssl rand -base64 32).' },
    );
  }
  return key;
}

export function encryptSecret(plaintext: string, key: Buffer): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return ['v1', iv.toString('base64'), tag.toString('base64'), ciphertext.toString('base64')].join(
    ':',
  );
}

export function decryptSecret(stored: string, key: Buffer): string {
  const [version, iv, tag, ciphertext] = stored.split(':');
  if (version !== 'v1' || iv === undefined || tag === undefined || ciphertext === undefined) {
    throw new Error('unrecognised secret format');
  }
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

/** The only form of a secret the interface ever shows (I5.3). */
export function lastFour(secret: string): string {
  return secret.length <= 4 ? '••••' : `••••${secret.slice(-4)}`;
}
