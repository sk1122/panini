import { Buffer } from "node:buffer";
import { DomainError } from "./errors.js";

const uuid = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const workspaceUri = new RegExp(`^panini://(${uuid})/(${uuid}|user)/(.+)$`, "i");
export const MAX_AGENT_FILE_BYTES = 100_000;

export function normalizeAgentWorkspacePath(input: string): string {
  if (!input || input.length > 500 || input.startsWith("/") || input.endsWith("/") || input.includes("%")) {
    throw new DomainError("Agent workspace path is invalid.", "INVALID");
  }
  const segments = input.split("/");
  if (segments.some((segment) => segment === "." || segment === ".." || segment.length > 120
    || !/^[a-zA-Z0-9._-]+$/.test(segment))) {
    throw new DomainError("Agent workspace path is invalid.", "INVALID");
  }
  return segments.join("/");
}

export function agentWorkspaceUri(memberId: string, agentProfileId: string, path: string): string {
  return `panini://${memberId}/${agentProfileId}/${normalizeAgentWorkspacePath(path)}`;
}

export function parseAgentWorkspaceUri(uri: string): { memberId: string; agentProfileId: string; path: string } {
  const match = workspaceUri.exec(uri);
  if (!match) throw new DomainError("Agent workspace URI is invalid.", "INVALID");
  return {
    memberId: match[1]!.toLowerCase(),
    agentProfileId: match[2]!.toLowerCase(),
    path: normalizeAgentWorkspacePath(match[3]!),
  };
}

export function validateAgentWorkspaceContent(content: string): void {
  if (content.includes("\0") || Buffer.byteLength(content, "utf8") > MAX_AGENT_FILE_BYTES) {
    throw new DomainError(`Agent workspace file must be text below ${MAX_AGENT_FILE_BYTES} bytes.`, "INVALID");
  }
}
