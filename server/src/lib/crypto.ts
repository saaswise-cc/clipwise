// AES-256-GCM encryption for values that must not sit in the database in
// plaintext — currently the calendar OAuth tokens in `calendar_connections`
// (SAA-115). Key read lazily inside each function, matching lib/voyage.ts's
// convention, not at module load: this module has to be importable (and the
// server has to start) before CALENDAR_TOKEN_ENCRYPTION_KEY exists.

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // 96-bit nonce, the GCM-recommended size.
const KEY_BYTES = 32; // AES-256.

function loadKey(): Buffer {
  const encoded = process.env.CALENDAR_TOKEN_ENCRYPTION_KEY;
  if (!encoded) {
    throw new Error(
      "CALENDAR_TOKEN_ENCRYPTION_KEY not set. Generate one with: openssl rand -base64 32",
    );
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `CALENDAR_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes; got ${key.length}. ` +
        "Generate one with: openssl rand -base64 32",
    );
  }
  return key;
}

// Output shape: base64(iv) . base64(authTag) . base64(ciphertext), joined
// with ".". Storing iv and tag alongside the ciphertext is what makes each
// row independently decryptable — GCM requires both to open.
export function encrypt(plaintext: string): string {
  const key = loadKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv, authTag, ciphertext].map((b) => b.toString("base64")).join(".");
}

export function decrypt(encoded: string): string {
  const key = loadKey();
  const parts = encoded.split(".");
  if (parts.length !== 3) {
    throw new Error("malformed ciphertext: expected iv.authTag.ciphertext");
  }
  const [ivB64, authTagB64, ciphertextB64] = parts;
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(authTagB64, "base64");
  const ciphertext = Buffer.from(ciphertextB64, "base64");
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString("utf8");
}
