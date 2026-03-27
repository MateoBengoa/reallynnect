import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "crypto";

const ALGO = "aes-256-gcm";
const IV_LEN = 16;
const TAG_LEN = 16;
const SALT = "linkedin-saas-v1";

function keyFromEnv(): Buffer {
  const raw = process.env.COOKIE_ENCRYPTION_KEY;
  if (!raw || raw.length < 32) {
    throw new Error("COOKIE_ENCRYPTION_KEY must be set (min 32 chars recommended)");
  }
  return scryptSync(raw, SALT, 32);
}

export function encryptSecret(plain: string): string {
  const key = keyFromEnv();
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString("base64url");
}

export function decryptSecret(payload: string): string {
  const key = keyFromEnv();
  const buf = Buffer.from(payload, "base64url");
  const iv = buf.subarray(0, IV_LEN);
  const tag = buf.subarray(IV_LEN, IV_LEN + TAG_LEN);
  const data = buf.subarray(IV_LEN + TAG_LEN);
  const decipher = createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

export function maskSecret(s: string): string {
  if (s.length <= 4) return "****";
  return `****${s.slice(-4)}`;
}
