import { randomBytes, scrypt, timingSafeEqual } from "node:crypto";

// OWASP's scrypt minimum: N=2^17, r=8, p=1 (128 MiB).
const parameters = { N: 131_072, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let running = 0;

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Bound per-process memory use as well as rate-limiting requests in PostgreSQL.
  if (running >= 2) throw new AuthError("Sign-in is busy. Please try again shortly.", 429);
  running++;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 64, parameters, (error, key) => error ? reject(error) : resolve(key));
    });
  } finally { running--; }
}

export class AuthError extends Error {
  constructor(message: string, readonly status: number) { super(message); this.name = "AuthError"; }
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 15 || password.length > 128) throw new AuthError("Use a password between 15 and 128 characters.", 400);
  const salt = randomBytes(16);
  return `scrypt$131072$8$1$${salt.toString("base64url")}$${(await derive(password, salt)).toString("base64url")}`;
}

export async function verifyPassword(password: string, encoded?: string): Promise<boolean> {
  const parts = encoded?.split("$");
  const valid = parts?.length === 6 && parts.slice(0, 4).join("$") === "scrypt$131072$8$1";
  const salt = valid ? Buffer.from(parts[4]!, "base64url") : Buffer.alloc(16, 19);
  const expected = valid ? Buffer.from(parts[5]!, "base64url") : Buffer.alloc(64);
  const actual = await derive(password.slice(0, 128), salt);
  return Boolean(valid && expected.length === actual.length && timingSafeEqual(expected, actual));
}
