// Run before changing the installer: failures are asserted against real files and PostgreSQL.
import assert from "node:assert/strict";
import { mkdtemp, readFile, stat, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { PayloadCipher } from "../dist/src/security/payload-cipher.js";

const directory = await mkdtemp(resolve(tmpdir(), "panini-install-e2e-"));

const run = (...args) =>
	spawnSync(
		process.execPath,
		["scripts/selfhost.mjs", ...args, "--directory", directory],
		{ encoding: "utf8" },
	);

const checks = [];

assert.equal(run("init").status, 0);

const original = await readFile(resolve(directory, ".env"), "utf8");

assert.match(original, /POSTGRES_PASSWORD=[a-f0-9]{64}/);
assert.equal((await stat(resolve(directory, ".env"))).mode & 0o777, 0o600);
assert.equal(run("init").status, 0);
assert.equal(await readFile(resolve(directory, ".env"), "utf8"), original);
checks.push(
	"Init generates private strong secrets and preserves existing configuration byte-for-byte.",
);
assert.notEqual(run("init", "--url", "http://example.com").status, 0);
checks.push("Public plaintext HTTP is rejected.");

// Actual backup/restore uses only the isolated E2E stack. The target must reject an occupied DB.
const shared = [
	"--compose-file",
	"test/compose.e2e.yaml",
	"--project",
	"panini-production-e2e",
];
const cipher = new PayloadCipher(Buffer.alloc(32, 11).toString("base64"));
const originalPayload = {
	text: "Private evidence survives the recovery drill.",
	version: 1,
};
const encrypted = JSON.stringify(cipher.encrypt(originalPayload));
const seeded = spawnSync(
	"docker",
	[
		"compose",
		"-p",
		"panini-production-e2e",
		"-f",
		"test/compose.e2e.yaml",
		"exec",
		"-T",
		"postgres",
		"psql",
		"-U",
		"panini_e2e",
		"-d",
		"panini_e2e",
		"-v",
		"ON_ERROR_STOP=1",
		"-c",
		`CREATE TABLE IF NOT EXISTS e2e_backup_probe (payload jsonb); DELETE FROM e2e_backup_probe; INSERT INTO e2e_backup_probe VALUES ('${encrypted}'::jsonb);`,
	],
	{ encoding: "utf8" },
);

assert.equal(seeded.status, 0, seeded.stderr);

const backup = resolve(directory, "database.dump");
const result = run("backup", "--file", backup, ...shared);

assert.equal(result.status, 0, result.stderr);
assert.ok((await stat(backup)).size > 1000);
assert.equal((await stat(backup)).mode & 0o777, 0o600);
assert.notEqual(
	run("backup", "--file", backup, ...shared).status,
	0,
	"Backup must not overwrite an existing dump.",
);
assert.notEqual(
	run("restore", "--file", backup, ...shared).status,
	0,
	"Restore must refuse a populated DB.",
);
checks.push(
	"Real PostgreSQL backup is private, cannot overwrite an existing backup, and restore refuses a populated database.",
);

const restored = [
	"--compose-file",
	"test/compose.restore-e2e.yaml",
	"--project",
	"panini-restore-e2e",
];

const compose = (...args) =>
	spawnSync(
		"docker",
		[
			"compose",
			"-p",
			"panini-restore-e2e",
			"-f",
			"test/compose.restore-e2e.yaml",
			...args,
		],
		{ encoding: "utf8" },
	);

try {
	const started = compose("up", "-d", "--wait");

	assert.equal(started.status, 0, started.stderr);

	const recovery = run("restore", "--file", backup, ...restored);

	assert.equal(recovery.status, 0, recovery.stderr);

	const count = compose(
		"exec",
		"-T",
		"postgres",
		"psql",
		"-U",
		"panini_e2e",
		"-d",
		"panini_e2e",
		"-Atc",
		"SELECT count(*) FROM member_accounts",
	);

	assert.equal(count.status, 0, count.stderr);
	assert.ok(
		Number(count.stdout.trim()) >= 2,
		"Browser owner and teammate must survive restore.",
	);

	const evidence = compose(
		"exec",
		"-T",
		"postgres",
		"psql",
		"-U",
		"panini_e2e",
		"-d",
		"panini_e2e",
		"-Atc",
		"SELECT payload FROM e2e_backup_probe",
	);

	assert.equal(evidence.status, 0, evidence.stderr);
	assert.deepEqual(
		cipher.decrypt(JSON.parse(evidence.stdout.trim())),
		originalPayload,
	);
	assert.throws(() =>
		new PayloadCipher(Buffer.alloc(32, 12).toString("base64")).decrypt(
			JSON.parse(evidence.stdout.trim()),
		),
	);
	checks.push(
		"Recovered AES-GCM evidence decrypts with the original key and rejects a different key.",
	);
	assert.notEqual(
		run("restore", "--file", backup, ...restored).status,
		0,
		"Second restore must reject populated DB.",
	);
	checks.push(
		"A real dump restores transactionally into a separate empty database and preserves browser accounts; a second restore is refused.",
	);
} finally {
	assert.equal(
		compose("down").status,
		0,
		"Disposable restore stack should be stopped.",
	);
}
await mkdir(".panini/e2e", { recursive: true });
await writeFile(
	".panini/e2e/selfhost-results.json",
	JSON.stringify(
		{
			passed: true,
			checks,
			directory,
			timestamp: new Date().toISOString(),
		},
		null,
		2,
	),
);
console.log(JSON.stringify({ passed: true, checks, directory }, null, 2));
