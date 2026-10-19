import { randomUUID } from "node:crypto";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { GithubEvidenceVerifier } from "../src/connectors/github/evidence-verifier.js";
import { PostgresLedgerStore } from "../src/store/postgres.js";

const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;
const organizationId = randomUUID();
const sha = "a".repeat(40);
const otherSha = "b".repeat(40);

describe("GitHub artifact verification with durable receipts", () => {
	let pool: pg.Pool;
	let store: PostgresLedgerStore;

	beforeAll(async () => {
		if (!databaseUrl || !databaseUrl.includes("panini_e2e"))
			throw new Error("Isolated test database required");
		pool = new pg.Pool({ connectionString: databaseUrl });
		expect(
			(
				await pool.query<{ current_database: string }>(
					"SELECT current_database()",
				)
			).rows[0]?.current_database,
		).toBe("panini_e2e");
		await pool.query(
			"INSERT INTO organizations (id,slug,name) VALUES ($1,$2,$3)",
			[
				organizationId,
				`github-verify-${organizationId}`,
				"GitHub Verification E2E",
			],
		);
		store = new PostgresLedgerStore(
			databaseUrl,
			Buffer.alloc(32, 71).toString("base64"),
			organizationId,
		);
	});
	afterAll(async () => {
		await store?.close();
		await pool?.end();
	});

	const fixture = (
		checkSha: string,
		deploymentSha: string | null,
		fileCount = 1,
	) => {
		const paths: string[] = [];
		const client = {
			async repositoryData<T>(_token: string, path: string): Promise<T> {
				paths.push(path);

				let value: unknown;

				if (path.endsWith("/pulls/7"))
					value = {
						id: 70,
						number: 7,
						head: { sha },
						merged: true,
						merged_at: "2026-10-01T00:00:00Z",
					};
				else if (path.endsWith(`/git/commits/${sha}`)) value = { sha };
				else if (path.includes("/pulls/7/files"))
					value = Array.from({ length: fileCount }, (_, n) => ({
						filename: `src/file-${n}.ts`,
						status: "modified",
						patch: "+change",
						sha,
					}));
				else if (path.includes("/check-runs"))
					value = {
						total_count: 1,
						check_runs: [
							{
								id: 80,
								name: "build",
								head_sha: checkSha,
								status: "completed",
								conclusion: "success",
							},
						],
					};
				else if (path.includes("/deployments?"))
					value = deploymentSha
						? [
								{
									id: 90,
									sha: deploymentSha,
									environment: "production",
								},
							]
						: [];
				else if (path.includes("/deployments/90/statuses"))
					value = [
						{
							id: 91,
							state: "success",
							created_at: "2026-10-01T00:10:00Z",
						},
					];
				else throw new Error(`Unexpected GitHub path ${path}`);
				return value as T;
			},
		};

		return { client, paths };
	};

	it("keeps a merged PR with a wrong-SHA check and missing deployment insufficient", async () => {
		const { client, paths } = fixture(otherSha, null);
		const verifier = new GithubEvidenceVerifier({
			client,
			store,
			installationKey: "fixture-app",
		});
		const before = (
			await pool.query<{ count: string }>(
				"SELECT count(*) FROM tasks WHERE organization_id=$1",
				[organizationId],
			)
		).rows[0]!.count;
		const result = await verifier.verify({
			repository: "acme/app",
			pullNumber: 7,
			requiredHeadSha: sha,
			requiredChecks: ["build"],
			requiredDeploymentEnvironment: "production",
			token: "local-fixture",
		});

		expect(result).toMatchObject({
			state: "insufficient",
			reasonCodes: expect.arrayContaining([
				"check_missing_for_sha",
				"deployment_missing",
			]),
			observedHeadSha: sha,
			sourceEventId: expect.any(String),
		});
		expect(
			paths.some((path) => path.includes(`/commits/${sha}/check-runs`)),
		).toBe(true);
		expect(
			paths.some((path) =>
				path.includes(`/commits/${otherSha}/check-runs`),
			),
		).toBe(false);
		expect(
			(await store.getSourceEvents([result.sourceEventId!]))[0]?.payload,
		).toMatchObject({
			requiredHeadSha: sha,
			state: "insufficient",
			mergeVerified: true,
		});
		expect(
			(
				await pool.query<{ count: string }>(
					"SELECT count(*) FROM tasks WHERE organization_id=$1",
					[organizationId],
				)
			).rows[0]?.count,
		).toBe(before);
	});

	it("verifies only a matching SHA, successful check, and matching production deployment", async () => {
		const { client } = fixture(sha, sha);
		const verifier = new GithubEvidenceVerifier({
			client,
			store,
			installationKey: "fixture-app",
		});
		const result = await verifier.verify({
			repository: "acme/app",
			pullNumber: 7,
			requiredHeadSha: sha,
			requiredChecks: ["build"],
			requiredDeploymentEnvironment: "production",
			token: "local-fixture",
		});

		expect(result).toMatchObject({
			state: "verified",
			reasonCodes: [],
			sourceEventId: expect.any(String),
		});
		expect(result.requestCount).toBeLessThanOrEqual(10);
	});

	it("does not treat an over-limit diff as verified", async () => {
		const { client } = fixture(sha, sha, 21);
		const verifier = new GithubEvidenceVerifier({
			client,
			store,
			installationKey: "fixture-app",
		});
		const result = await verifier.verify({
			repository: "acme/app",
			pullNumber: 7,
			requiredHeadSha: sha,
			requiredChecks: ["build"],
			requiredDeploymentEnvironment: "production",
			token: "local-fixture",
		});

		expect(result).toMatchObject({
			state: "insufficient",
			reasonCodes: expect.arrayContaining(["file_limit"]),
			sourceEventId: expect.any(String),
		});
	});

	it("follows file pages and keeps truncated files or checks insufficient", async () => {
		const { client } = fixture(sha, sha);
		const paths: string[] = [];

		const paged = (secondPageCount: number, incompleteChecks: boolean) => ({
			async repositoryData<T>(token: string, path: string): Promise<T> {
				paths.push(path);
				if (path.includes("/pulls/7/files?")) {
					const count = path.endsWith("page=1")
						? 100
						: secondPageCount;

					return Array.from({ length: count }, (_, index) => ({
						filename: `src/page-${path.endsWith("page=1") ? "one" : "two"}-${index}.ts`,
						status: "modified",
						patch: "+change",
						sha,
					})) as T;
				}
				if (incompleteChecks && path.includes("/check-runs"))
					return {
						total_count: 2,
						check_runs: [
							{
								id: 80,
								name: "build",
								head_sha: sha,
								status: "completed",
								conclusion: "success",
							},
						],
					} as T;
				return client.repositoryData<T>(token, path);
			},
		});

		const overFiles = await new GithubEvidenceVerifier({
			client: paged(51, false),
			store,
			installationKey: "fixture-app",
			maxFiles: 150,
		}).verify({
			repository: "acme/app",
			pullNumber: 7,
			requiredHeadSha: sha,
			requiredChecks: ["build"],
			requiredDeploymentEnvironment: "production",
			token: "local-fixture",
		});

		expect(
			paths.some((path) =>
				path.endsWith("/pulls/7/files?per_page=100&page=2"),
			),
		).toBe(true);
		expect(overFiles).toMatchObject({
			state: "insufficient",
			reasonCodes: expect.arrayContaining(["file_limit"]),
		});
		paths.length = 0;

		const incomplete = await new GithubEvidenceVerifier({
			client: paged(10, true),
			store,
			installationKey: "fixture-app",
			maxFiles: 150,
		}).verify({
			repository: "acme/app",
			pullNumber: 7,
			requiredHeadSha: sha,
			requiredChecks: ["build"],
			requiredDeploymentEnvironment: "production",
			token: "local-fixture",
		});

		expect(
			paths.some((path) =>
				path.endsWith("/pulls/7/files?per_page=100&page=2"),
			),
		).toBe(true);
		expect(incomplete).toMatchObject({
			state: "insufficient",
			reasonCodes: expect.arrayContaining([
				"check_pagination_incomplete",
			]),
		});
	});

	it("does not bind changed files to a PR head that moves during verification", async () => {
		const { client } = fixture(sha, sha);
		let pullReads = 0;
		const moving = {
			async repositoryData<T>(token: string, path: string): Promise<T> {
				const response = await client.repositoryData<T>(token, path);

				if (path.endsWith("/pulls/7") && ++pullReads === 2) {
					return {
						...(response as object),
						head: { sha: otherSha },
					} as T;
				}
				return response;
			},
		};
		const verifier = new GithubEvidenceVerifier({
			client: moving,
			store,
			installationKey: "fixture-app",
		});
		const result = await verifier.verify({
			repository: "acme/app",
			pullNumber: 7,
			requiredHeadSha: sha,
			requiredChecks: ["build"],
			requiredDeploymentEnvironment: "production",
			token: "local-fixture",
		});

		expect(pullReads).toBe(2);
		expect(result).toMatchObject({
			state: "insufficient",
			reasonCodes: expect.arrayContaining([
				"head_changed_during_verification",
			]),
		});
	});

	it("does not accept an older successful check when the latest run failed at the same SHA", async () => {
		const { client } = fixture(sha, sha);
		const retries = {
			async repositoryData<T>(token: string, path: string): Promise<T> {
				if (path.includes("/check-runs"))
					return {
						total_count: 2,
						check_runs: [
							{
								id: 81,
								name: "build",
								head_sha: sha,
								status: "completed",
								conclusion: "failure",
								completed_at: "2026-10-01T00:12:00Z",
							},
							{
								id: 80,
								name: "build",
								head_sha: sha,
								status: "completed",
								conclusion: "success",
								completed_at: "2026-10-01T00:10:00Z",
							},
						],
					} as T;
				return client.repositoryData<T>(token, path);
			},
		};
		const verifier = new GithubEvidenceVerifier({
			client: retries,
			store,
			installationKey: "fixture-app",
		});
		const result = await verifier.verify({
			repository: "acme/app",
			pullNumber: 7,
			requiredHeadSha: sha,
			requiredChecks: ["build"],
			requiredDeploymentEnvironment: "production",
			token: "local-fixture",
		});

		expect(result).toMatchObject({
			state: "insufficient",
			reasonCodes: expect.arrayContaining(["check_missing_for_sha"]),
		});
	});

	it("does not accept an older successful deployment when the latest attempt failed", async () => {
		const { client } = fixture(sha, sha);
		const attempts = {
			async repositoryData<T>(token: string, path: string): Promise<T> {
				if (path.includes("/deployments?"))
					return [
						{ id: 92, sha, environment: "production" },
						{ id: 90, sha, environment: "production" },
					] as T;
				if (path.includes("/deployments/92/statuses"))
					return [
						{
							id: 93,
							state: "failure",
							created_at: "2026-10-01T00:20:00Z",
						},
					] as T;
				return client.repositoryData<T>(token, path);
			},
		};
		const verifier = new GithubEvidenceVerifier({
			client: attempts,
			store,
			installationKey: "fixture-app",
		});
		const result = await verifier.verify({
			repository: "acme/app",
			pullNumber: 7,
			requiredHeadSha: sha,
			requiredChecks: ["build"],
			requiredDeploymentEnvironment: "production",
			token: "local-fixture",
		});

		expect(result).toMatchObject({
			state: "insufficient",
			reasonCodes: expect.arrayContaining(["deployment_missing"]),
		});
	});
});
