import { AsyncLocalStorage } from "node:async_hooks";
import { DomainError } from "../domain/errors.js";
import type { AccessScope } from "../domain/access.js";
import type { AgentCapability, AgentProfile, Member } from "../domain/types.js";

export type McpPrincipal =
	| { kind: "admin" }
	| { kind: "agent"; profile: AgentProfile; member: Member };

const principals = new AsyncLocalStorage<McpPrincipal>();

export function runWithMcpPrincipal<T>(
	principal: McpPrincipal,
	operation: () => T,
): T {
	return principals.run(principal, operation);
}

export function currentMcpPrincipal(): McpPrincipal {
	const principal = principals.getStore();

	if (!principal)
		throw new DomainError(
			"An authenticated agent profile is required.",
			"FORBIDDEN",
		);
	return principal;
}

export function requireMcpCapability(
	capability: AgentCapability,
): McpPrincipal {
	const principal = currentMcpPrincipal();

	if (
		principal.kind === "agent" &&
		!principal.profile.capabilities.includes(capability)
	) {
		throw new DomainError(
			`Agent profile lacks the ${capability} capability grant.`,
			"FORBIDDEN",
		);
	}
	return principal;
}

export function hasMcpCapability(capability: AgentCapability): boolean {
	const principal = currentMcpPrincipal();

	return (
		principal.kind === "admin" ||
		principal.profile.capabilities.includes(capability)
	);
}

export function mcpActor(): string {
	const principal = currentMcpPrincipal();

	return principal.kind === "admin"
		? "admin:mcp"
		: `agent:${principal.profile.id}:${principal.profile.name}`;
}

export function mcpInstallationKey(): string {
	const principal = currentMcpPrincipal();

	return principal.kind === "admin" ? "admin:mcp" : principal.profile.id;
}

export function mcpAccessScope(): AccessScope {
	const principal = currentMcpPrincipal();

	return principal.kind === "admin"
		? { kind: "admin" }
		: {
				kind: "agent",
				organizationId: principal.member.organizationId,
				memberId: principal.member.id,
				agentProfileId: principal.profile.id,
				dataScope: principal.profile.dataScope,
			};
}
