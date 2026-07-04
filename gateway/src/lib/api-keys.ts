import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

const KEY_PREFIX = 'sk_live_';
// 8 chars of secret after the fixed prefix: enough for a human to tell
// keys apart in a listing, far too short to reconstruct the key.
const DISPLAY_PREFIX_LENGTH = KEY_PREFIX.length + 8;

export interface GeneratedApiKey {
  key: string;
  keyHash: string;
  keyPrefix: string;
}

export function generateApiKey(): GeneratedApiKey {
  const key = `${KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
  return { key, keyHash: hashApiKey(key), keyPrefix: key.slice(0, DISPLAY_PREFIX_LENGTH) };
}

export function hashApiKey(key: string): string {
  return createHash('sha256').update(key).digest('hex');
}

export function looksLikeApiKey(candidate: string): boolean {
  return candidate.startsWith(KEY_PREFIX);
}

export function hashesMatch(a: string, b: string): boolean {
  const bufA = Buffer.from(a, 'hex');
  const bufB = Buffer.from(b, 'hex');
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB);
}
