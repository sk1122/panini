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
		throw new Error(
			"CONTENT_ENCRYPTION_KEY must encode exactly 32 bytes (base64 or 64 hexadecimal characters).",
		);
	}
	return key;
}

/**
 * AES-256-GCM with a key ring. New data uses the current key and version; data
 * written under an older version still decrypts while that key is listed in
 * CONTENT_ENCRYPTION_PREVIOUS_KEYS ("v1:<key>,v2:<key>").
 */
export class PayloadCipher {
	private readonly key: Buffer;
	private readonly ring = new Map<string, Buffer>();

	constructor(
		secret: string,
		readonly keyVersion = "v1",
		previous: Record<string, string> = {},
	) {
		this.key = decodeKey(secret);
		for (const [version, value] of Object.entries(previous))
			this.ring.set(version, decodeKey(value));
		this.ring.set(keyVersion, this.key);
	}

	/** The content cipher for this installation, including any previous keys. */
	static fromEnvironment(
		secret: string,
		env: NodeJS.ProcessEnv = process.env,
	): PayloadCipher {
		const version = env.CONTENT_ENCRYPTION_KEY_VERSION?.trim() || "v1";
		const previous: Record<string, string> = {};

		for (const item of (env.CONTENT_ENCRYPTION_PREVIOUS_KEYS ?? "")
			.split(",")
			.map((value) => value.trim())
			.filter(Boolean)) {
			const separator = item.indexOf(":");

			if (separator < 1)
				throw new Error(
					"CONTENT_ENCRYPTION_PREVIOUS_KEYS entries must look like version:key.",
				);
			previous[item.slice(0, separator)] = item.slice(separator + 1);
		}
		return new PayloadCipher(secret, version, previous);
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
		const key = this.ring.get(payload.keyVersion);

		if (!key) {
			throw new Error(
				`Unsupported content-encryption key version ${payload.keyVersion}.`,
			);
		}

		const decipher = createDecipheriv(
			"aes-256-gcm",
			key,
			Buffer.from(payload.iv, "base64"),
		);

		decipher.setAuthTag(Buffer.from(payload.authTag, "base64"));

		const plaintext = Buffer.concat([
			decipher.update(Buffer.from(payload.ciphertext, "base64")),
			decipher.final(),
		]).toString("utf8");

		return JSON.parse(plaintext) as JsonValue;
	}
}
