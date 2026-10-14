import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { JsonValue } from "../domain/types.js";

export interface EncryptedPayload {
  ciphertext: string;
  iv: string;
  authTag: string;
  keyVersion: string;
}

function decodeKey(value: string): Buffer {
  const trimmed = value.trim();
  const key = /^[a-f0-9]{64}$/i.test(trimmed)
    ? Buffer.from(trimmed, "hex")
    : Buffer.from(trimmed, "base64");
  if (key.length !== 32) {
    throw new Error("CONTENT_ENCRYPTION_KEY must encode exactly 32 bytes (base64 or 64 hexadecimal characters).");
  }
  return key;
}

export class PayloadCipher {
  private readonly key: Buffer;

  constructor(secret: string, readonly keyVersion = "v1") {
    this.key = decodeKey(secret);
  }

  encrypt(payload: JsonValue): EncryptedPayload {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), "utf8"),
      cipher.final(),
    ]);
    return {
      ciphertext: ciphertext.toString("base64"),
      iv: iv.toString("base64"),
      authTag: cipher.getAuthTag().toString("base64"),
      keyVersion: this.keyVersion,
    };
  }

  decrypt(payload: EncryptedPayload): JsonValue {
    if (payload.keyVersion !== this.keyVersion) {
      throw new Error(`Unsupported content-encryption key version ${payload.keyVersion}.`);
    }
    const decipher = createDecipheriv("aes-256-gcm", this.key, Buffer.from(payload.iv, "base64"));
    decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(payload.ciphertext, "base64")),
      decipher.final(),
    ]).toString("utf8");
    return JSON.parse(plaintext) as JsonValue;
  }
}
