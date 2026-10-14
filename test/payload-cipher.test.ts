import { describe, expect, it } from "vitest";
import { PayloadCipher } from "../src/security/payload-cipher.js";

describe("PayloadCipher", () => {
  it("round-trips JSON with authenticated encryption and does not retain plaintext", () => {
    const cipher = new PayloadCipher(Buffer.alloc(32, 7).toString("base64"));
    const encrypted = cipher.encrypt({ private: "selected Slack excerpt" });
    expect(encrypted.ciphertext).not.toContain("Slack");
    expect(cipher.decrypt(encrypted)).toEqual({ private: "selected Slack excerpt" });
  });

  it("rejects tampered ciphertext", () => {
    const cipher = new PayloadCipher(Buffer.alloc(32, 8).toString("base64"));
    const encrypted = cipher.encrypt({ value: true });
    const bytes = Buffer.from(encrypted.ciphertext, "base64");
    bytes[0] = (bytes[0] ?? 0) ^ 1;
    expect(() => cipher.decrypt({ ...encrypted, ciphertext: bytes.toString("base64") })).toThrow();
  });
});
