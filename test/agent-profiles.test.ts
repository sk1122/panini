import { describe, expect, it } from "vitest";
import { buildAgentSetup } from "../src/domain/agent-setup.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

function makeLedger() {
	return new TeamLedger(
		new MemoryLedgerStore(),
		new ProposalPolicy({
			autoApproveNewTasks: true,
			autoApproveContext: true,
			requireReviewForTaskChanges: true,
		}),
	);
}

describe("agent profiles", () => {
	it("binds every active profile to an active workspace member", async () => {
		const ledger = makeLedger();
		const member = (await ledger.workspace()).members[0]!;
		const enrollment = await ledger.createAgentProfile({
			memberId: member.id,
			name: "Member-bound researcher",
			harness: "codex",
		});

		expect(enrollment.profile).toMatchObject({
			memberId: member.id,
			owner: member.displayName,
			status: "active",
		});
		expect(
			await ledger.authenticateAgentSecret(enrollment.secret),
		).toMatchObject({
			profile: { id: enrollment.profile.id, memberId: member.id },
			member: { id: member.id, status: "active" },
		});
		await expect(
			ledger.createAgentProfile({
				memberId: "00000000-0000-4000-8000-000000000099",
				name: "Orphan profile",
				harness: "codex",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
	});

	it("allows one member to own multiple independently authenticated profiles", async () => {
		const ledger = makeLedger();
		const member = (await ledger.workspace()).members[0]!;
		const first = await ledger.createAgentProfile({
			memberId: member.id,
			name: "Research",
			harness: "codex",
		});
		const second = await ledger.createAgentProfile({
			memberId: member.id,
			name: "Delivery",
			harness: "claude_code",
		});

		expect(first.secret).toMatch(/^tl_agent_/);
		expect(first.secret).not.toBe(second.secret);
		expect(await ledger.listAgentProfiles(member.id)).toHaveLength(2);
		expect(first.profile.capabilities).toContain("source:read");
		expect(first.profile).not.toHaveProperty("tokenHash");
		expect(
			await ledger.authenticateAgentSecret(first.secret),
		).toMatchObject({
			profile: {
				id: first.profile.id,
				memberId: member.id,
				owner: member.displayName,
			},
			member: { id: member.id },
		});
	});

	it("invalidates the old secret on rotation and all secrets on revocation", async () => {
		const ledger = makeLedger();
		const member = (await ledger.workspace()).members[0]!;
		const enrollment = await ledger.createAgentProfile({
			memberId: member.id,
			name: "Operator",
			harness: "pi",
		});
		const rotated = await ledger.rotateAgentSecret(enrollment.profile.id);

		expect(
			await ledger.authenticateAgentSecret(enrollment.secret),
		).toBeNull();
		expect(
			await ledger.authenticateAgentSecret(rotated.secret),
		).toMatchObject({ profile: { id: enrollment.profile.id } });
		await ledger.revokeAgentProfile(enrollment.profile.id);
		expect(await ledger.authenticateAgentSecret(rotated.secret)).toBeNull();
	});

	it("keeps versioned agent files private and revokes access with the profile", async () => {
		const ledger = makeLedger();
		const member = (await ledger.workspace()).members[0]!;
		const first = await ledger.createAgentProfile({
			memberId: member.id,
			name: "Private research",
			harness: "codex",
		});
		const second = await ledger.createAgentProfile({
			memberId: member.id,
			name: "Private delivery",
			harness: "claude_code",
		});
		const firstAccess = {
			kind: "agent" as const,
			organizationId: member.organizationId,
			memberId: member.id,
			agentProfileId: first.profile.id,
			dataScope: first.profile.dataScope,
		};
		const secondAccess = {
			...firstAccess,
			agentProfileId: second.profile.id,
		};

		const created = await ledger.writeAgentWorkspaceFile(
			firstAccess,
			"notes/research.md",
			"One lead",
			0,
		);

		expect(created.uri).toBe(
			`panini://${member.id}/${first.profile.id}/notes/research.md`,
		);
		expect(
			(await ledger.readAgentWorkspaceFile(firstAccess, created.uri))
				?.content,
		).toBe("One lead");
		await expect(
			ledger.readAgentWorkspaceFile(secondAccess, created.uri),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(await ledger.listAgentWorkspaceFiles(secondAccess)).toEqual([]);
		await expect(
			ledger.writeAgentWorkspaceFile(
				firstAccess,
				"notes/research.md",
				"Lost update",
				0,
			),
		).rejects.toMatchObject({ code: "CONFLICT" });

		const updated = await ledger.writeAgentWorkspaceFile(
			firstAccess,
			"notes/research.md",
			"Two leads",
			1,
		);

		expect(updated.version).toBe(2);
		expect(await ledger.listAgentWorkspaceFiles(firstAccess)).toMatchObject(
			[{ version: 2 }],
		);
		await expect(
			ledger.writeAgentWorkspaceFile(
				firstAccess,
				"../escape.md",
				"Bad",
				0,
			),
		).rejects.toMatchObject({ code: "INVALID" });
		await ledger.writeAgentWorkspaceFile(
			firstAccess,
			"notes/research.md",
			null,
			2,
		);
		expect(
			await ledger.readAgentWorkspaceFile(firstAccess, created.uri),
		).toBeNull();
		await ledger.revokeAgentProfile(first.profile.id);
		await expect(
			ledger.listAgentWorkspaceFiles(firstAccess),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
	});

	it("generates harness-specific setup without embedding the secret", async () => {
		const ledger = makeLedger();
		const member = (await ledger.workspace()).members[0]!;
		const enrollment = await ledger.createAgentProfile({
			memberId: member.id,
			name: "Context scout",
			harness: "codex",
			capabilities: ["work:read", "context:read"],
		});
		const setup = buildAgentSetup(
			enrollment.profile,
			"http://127.0.0.1:4141",
		);

		expect(setup.steps.map((step) => step.code).join("\n")).toContain(
			"codex mcp add",
		);
		expect(setup.steps.map((step) => step.code).join("\n")).toContain(
			"--bearer-token-env-var",
		);
		expect(JSON.stringify(setup)).not.toContain(enrollment.secret);
	});

	it("keeps every harness recipe secret-free and uses the supported connection shape", async () => {
		const ledger = makeLedger();
		const member = (await ledger.workspace()).members[0]!;
		const cases = [
			{
				harness: "codex" as const,
				marker: "codex mcp add",
				expectedReference: "--bearer-token-env-var",
			},
			{
				harness: "claude_code" as const,
				marker: "claude mcp add-json --scope user",
				expectedReference: "Bearer ${PANINI_AGENT_",
			},
			{
				harness: "hermes" as const,
				marker: "mcp_servers:",
				expectedReference: "Bearer ${PANINI_AGENT_",
			},
			{
				harness: "pi" as const,
				marker: "/integrations/pi/panini.ts",
				expectedReference: 'PANINI_AGENT_TOKEN="$PANINI_AGENT_',
			},
			{
				harness: "generic_mcp" as const,
				marker: "mcpServers",
				expectedReference: "Bearer ${PANINI_AGENT_",
			},
		];

		for (const [index, item] of cases.entries()) {
			const enrollment = await ledger.createAgentProfile({
				memberId: member.id,
				name: `Harness ${index}`,
				harness: item.harness,
			});
			const setup = buildAgentSetup(
				enrollment.profile,
				"http://127.0.0.1:4141",
			);
			const code = setup.steps.map((step) => step.code).join("\n");

			expect(code).toContain(item.marker);
			expect(code).toContain(item.expectedReference);
			expect(code).not.toContain(enrollment.secret);
			expect(setup.endpoint).toBe("http://127.0.0.1:4141/mcp");
			expect(setup.serverName).toMatch(/^panini-/);
			if (item.harness === "hermes") {
				expect(code).toContain("hermes mcp test");
				expect(code).toContain("hermes chat");
			}
		}
	});
});
