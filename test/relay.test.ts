import { generateKeyPairSync } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { RelayKeychain } from "../src/relay/keychain.js";
import { runRelayCli } from "../src/relay/cli.js";
import { RelayOutbox } from "../src/relay/outbox.js";
import { createRelayEnvelope, serializeRelayEnvelope, signRelayEnvelope, verifyRelayEnvelope } from "../src/relay/protocol.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("local relay", () => {
  it("encrypts queued reports, signs stable envelopes, and delivers a retry once semantically", async () => {
    const directory = await mkdtemp(join(tmpdir(), "panini-relay-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "outbox.sqlite");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const privatePem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const publicPem = publicKey.export({ type: "spki", format: "pem" }).toString();
    const outbox = new RelayOutbox(databasePath, Buffer.alloc(32, 4).toString("base64"));
    const report = {
      reportId: "report-1",
      workItemId: null,
      phase: "verified" as const,
      outcome: "Tests passed.",
      artifactRefs: ["git:abc123"],
      verification: ["pnpm test"],
      occurredAt: "2026-09-16T12:00:00.000Z",
    };
    expect(outbox.enqueue("00000000-0000-4000-8000-000000000010", report, privatePem)).toMatchObject({ inserted: true });
    expect(outbox.enqueue("00000000-0000-4000-8000-000000000010", report, privatePem)).toMatchObject({ inserted: false });
    const queued = outbox.pending()[0]!;
    expect(verifyRelayEnvelope(queued.body, queued.signature, publicPem)).toBe(true);
    expect(await readFile(databasePath)).not.toContain(Buffer.from("Tests passed."));
    const result = await outbox.flush(async (delivery) => {
      expect(verifyRelayEnvelope(delivery.body, delivery.signature, publicPem)).toBe(true);
      return { accepted: true, retryable: false };
    });
    expect(result).toEqual({ delivered: 1, deferred: 0 });
    expect(outbox.count("pending")).toBe(0);
    expect(outbox.count("delivered")).toBe(1);
    outbox.close();
  });

  it("detects changes to a signed envelope", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const body = serializeRelayEnvelope(createRelayEnvelope("00000000-0000-4000-8000-000000000010", {
      reportId: "report-2", workItemId: null, phase: "checkpoint", outcome: "Ready",
      artifactRefs: [], verification: [], occurredAt: "2026-09-16T12:00:00.000Z",
    }));
    const signature = signRelayEnvelope(body, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    expect(verifyRelayEnvelope(Buffer.concat([body, Buffer.from(" ")]), signature, publicKey.export({ type: "spki", format: "pem" }).toString())).toBe(false);
  });

  it("uses the macOS login keychain and refuses a plaintext fallback", async () => {
    const stored = {
      privateKeyPem: "private-key",
      outboxEncryptionKey: Buffer.alloc(32, 9).toString("base64"),
    };
    const runner = vi.fn(async (args: string[], _standardInput?: string) => ({
      stdout: args[0] === "find-generic-password" ? JSON.stringify(stored) : "",
    }));
    const keychain = new RelayKeychain("work.panini.test", runner, "darwin");
    await keychain.set("device-1", stored);
    expect(await keychain.get("device-1")).toEqual(stored);
    expect(runner.mock.calls[0]?.[0].slice(0, 5)).toEqual([
      "add-generic-password", "-a", "device-1", "-s", "work.panini.test",
    ]);
    expect(runner.mock.calls[0]?.[0]).not.toContain(JSON.stringify(stored));
    expect(runner.mock.calls[0]?.[1]).toBe(`${JSON.stringify(stored)}\n`);

    const unsupported = new RelayKeychain("work.panini.test", runner, "linux");
    await expect(unsupported.get("device-1")).rejects.toThrow("no file-backed secret fallback");
  });

  it("initializes a runnable relay without writing private keys to its config", async () => {
    const directory = await mkdtemp(join(tmpdir(), "panini-relay-cli-"));
    temporaryDirectories.push(directory);
    const configPath = join(directory, "relay.json");
    const stored: unknown[] = [];
    const keychain = {
      async set(account: string, secrets: unknown) { stored.push({ account, secrets }); },
    } as unknown as RelayKeychain;
    const write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    try {
      await runRelayCli(["init", "--server", "http://127.0.0.1:4141", "--config", configPath], keychain);
    } finally {
      write.mockRestore();
    }
    const config = await readFile(configPath, "utf8");
    expect(config).toContain("BEGIN PUBLIC KEY");
    expect(config).not.toContain("BEGIN PRIVATE KEY");
    expect(config).not.toContain("outboxEncryptionKey");
    expect(stored).toMatchObject([{ account: expect.stringMatching(/^relay-/), secrets: { privateKeyPem: expect.stringContaining("BEGIN PRIVATE KEY") } }]);
  });
});
