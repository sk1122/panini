import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { GithubAppClient, githubPkceChallenge, type GithubRepository } from "../src/connectors/github/app-client.js";
import { GithubRepositorySync, type GithubSyncClient } from "../src/connectors/github/sync.js";
import { DomainError } from "../src/domain/errors.js";
import { ProposalPolicy } from "../src/domain/policy.js";
import { TeamLedger } from "../src/domain/team-ledger.js";
import { MemoryLedgerStore } from "../src/store/memory.js";

const repository: GithubRepository = {
  id: 42, name: "pilot", full_name: "acme/pilot", private: true,
  html_url: "https://github.com/acme/pilot", default_branch: "main", archived: false,
};

function system(client: GithubSyncClient) {
  const store = new MemoryLedgerStore();
  const ledger = new TeamLedger(store, new ProposalPolicy({
    autoApproveNewTasks: false, autoApproveContext: false, requireReviewForTaskChanges: true,
  }));
  const sync = new GithubRepositorySync(client, ledger, { record: (input) => store.appendSourceEvent(input) });
  return { store, ledger, sync };
}

describe("GitHub App connection and sync", () => {
  it("uses OAuth state and PKCE and requests a scoped installation token without escalating permissions", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const requests: Array<{ url: string; body: Record<string, unknown> }> = [];
    const client = new GithubAppClient({
      appId: 7, clientId: "client", clientSecret: "secret", appSlug: "panini",
      privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
      callbackUrl: "https://panini.example/api/github/oauth/callback",
    }, (async (url, init) => {
      requests.push({ url: String(url), body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown> });
      return new Response(JSON.stringify({ token: "installation-token" }), { status: 201 });
    }) as typeof fetch);
    const authorization = new URL(client.authorizationUrl("csrf-state", "verifier"));
    expect(authorization.searchParams.get("state")).toBe("csrf-state");
    expect(authorization.searchParams.get("code_challenge")).toBe(githubPkceChallenge("verifier"));
    expect(await client.installationToken(12, [42])).toBe("installation-token");
    expect(requests[0]?.body).toEqual({ repository_ids: [42] });
    expect(await client.installationToken(12)).toBe("installation-token");
    expect(requests[1]?.body).toEqual({});
  });

  it("backfills selected repository activity once and revokes it when access disappears", async () => {
    let available = [repository];
    let discoveryError: Error | null = null;
    const tokenRequests: Array<number[] | undefined> = [];
    const client: GithubSyncClient = {
      async installationToken(_installationId, repositoryIds) {
        if (!repositoryIds && discoveryError) throw discoveryError;
        tokenRequests.push(repositoryIds);
        return "token";
      },
      async installationRepositories() { return available; },
      async repositoryData<T>(_token: string, path: string): Promise<T> {
        if (path.includes("/branches?")) return [{ name: "feature/ACME-42", commit: { sha: "abc" }, protected: false }] as T;
        if (path.includes("/pulls?")) return [{
          id: 77, number: 7, title: "ACME-42 delivery", body: "Implements the import",
          state: "closed", merged_at: "2026-09-19T12:00:00Z", updated_at: "2026-09-19T12:00:00Z",
          created_at: "2026-09-18T12:00:00Z", html_url: "https://github.com/acme/pilot/pull/7",
          head: { ref: "feature/ACME-42", sha: "abc" }, base: { ref: "main" }, user: { id: 9, login: "dev" },
        }] as T;
        if (path.includes("/reviews?")) return [] as T;
        if (path.includes("/compare/")) return { ahead_by: 0, commits: [] } as T;
        if (path.includes("/commits?")) return [] as T;
        if (path.includes("/check-runs?")) return { check_runs: [{
          id: 88, name: "CI", status: "completed", conclusion: "success",
          completed_at: "2026-09-19T12:01:00Z", html_url: "https://github.com/acme/pilot/actions/runs/88",
        }] } as T;
        throw new Error(`Unexpected path: ${path}`);
      },
    };
    const { ledger, sync } = system(client);
    const installation = await ledger.configureInstallation({
      provider: "github", installationKey: "12", displayName: "GitHub: acme", transport: "webhook",
      config: { installationId: 12, repositoryIds: [42], repositories: ["acme/pilot"] },
    }, "user:admin");
    expect(await sync.syncInstallation(installation.id)).toEqual({ observed: 3, incomplete: false });
    expect(await sync.syncInstallation(installation.id)).toEqual({ observed: 0, incomplete: false });
    expect(tokenRequests).toEqual([undefined, [42], undefined, [42]]);
    expect((await ledger.listEvidence()).filter((event) => event.provider === "github")).toHaveLength(3);

    discoveryError = new Error("Temporary GitHub network failure");
    expect(await sync.syncInstallation(installation.id)).toEqual({ observed: 0, incomplete: true });
    expect((await ledger.listEvidence()).filter((event) => event.provider === "github")).toHaveLength(3);
    discoveryError = new DomainError("GitHub API request failed (403).", "FORBIDDEN");
    expect(await sync.syncInstallation(installation.id)).toEqual({ observed: 0, incomplete: true });
    expect((await ledger.listEvidence()).filter((event) => event.provider === "github")).toHaveLength(3);
    discoveryError = null;

    available = [];
    expect(await sync.syncInstallation(installation.id)).toEqual({ observed: 0, incomplete: true });
    expect((await ledger.listEvidence()).filter((event) => event.provider === "github")).toHaveLength(0);
    expect((await ledger.workspace()).connectorSyncs).toEqual(expect.arrayContaining([
      expect.objectContaining({ resourceKey: "github:repository:42", status: "revoked" }),
    ]));
  });

  it("keeps branch, PR, and commit coverage when checks permission is absent", async () => {
    const requested: string[] = [];
    const client: GithubSyncClient = {
      async installationToken() { return "token"; },
      async installationRepositories() { return [repository]; },
      async repositoryData<T>(_token: string, path: string): Promise<T> {
        requested.push(path);
        if (path.includes("/branches?")) return [{ name: "main", commit: { sha: "abc" }, protected: true }] as T;
        if (path.includes("/pulls?")) return [{
          id: 77, number: 7, title: "ACME-42 delivery", body: "Implements the import",
          state: "open", merged_at: null, updated_at: "2026-09-19T12:00:00Z",
          created_at: "2026-09-18T12:00:00Z", html_url: "https://github.com/acme/pilot/pull/7",
          head: { ref: "feature/ACME-42", sha: "abc" }, base: { ref: "main" }, user: { id: 9, login: "dev" },
        }] as T;
        if (path.includes("/reviews?")) return [] as T;
        if (path.includes("/commits?")) return [{
          sha: "abc", html_url: "https://github.com/acme/pilot/commit/abc",
          commit: { message: "ACME-42 import", author: { date: "2026-09-19T12:00:00Z" }, committer: { date: "2026-09-19T12:00:00Z" } },
          author: { id: 9, login: "dev" },
        }] as T;
        if (path.includes("/check-runs?")) throw new DomainError("GitHub API request failed (403).", "FORBIDDEN");
        throw new Error(`Unexpected path: ${path}`);
      },
    };
    const { ledger, sync } = system(client);
    const installation = await ledger.configureInstallation({
      provider: "github", installationKey: "12", displayName: "GitHub: acme", transport: "webhook",
      config: { installationId: 12, repositoryIds: [42], repositories: ["acme/pilot"],
        permissions: { contents: "read", pull_requests: "read" } },
    }, "user:admin");
    expect(await sync.syncInstallation(installation.id)).toEqual({ observed: 3, incomplete: false });
    expect(requested.some((path) => path.includes("/check-runs?"))).toBe(false);
    expect((await ledger.listEvidence()).filter((event) => event.provider === "github")).toHaveLength(3);
  });

  // Failure case: a feature branch can contain task-relevant commits that are
  // absent from the default branch and from the pull-request title/body.
  it("captures commits unique to a feature branch through a complete comparison", async () => {
    const requested: string[] = [];
    const commit = (sha: string) => ({
      sha, html_url: `https://github.com/acme/pilot/commit/${sha}`,
      commit: { message: `${sha} implementation`, author: { date: "2026-09-19T12:00:00Z" }, committer: { date: "2026-09-19T12:00:00Z" } },
      author: { id: 9, login: "dev" },
    });
    const client: GithubSyncClient = {
      async installationToken() { return "token"; },
      async installationRepositories() { return [repository]; },
      async repositoryData<T>(_token: string, path: string): Promise<T> {
        requested.push(path);
        if (path.includes("/branches?")) return [
          { name: "main", commit: { sha: "main1" }, protected: true },
          { name: "feature/ACME-42", commit: { sha: "feature1" }, protected: false },
        ] as T;
        if (path.includes("/pulls?")) return [] as T;
        if (path.includes("/compare/main1...feature1") && path.includes("&page=1")) return {
          ahead_by: 101, commits: Array.from({ length: 100 }, (_, index) => commit(`feature${index}`)),
        } as T;
        if (path.includes("/compare/main1...feature1") && path.includes("&page=2")) return {
          ahead_by: 101, commits: [commit("feature100")],
        } as T;
        if (path.includes("/commits?")) return [commit("main1")] as T;
        throw new Error(`Unexpected path: ${path}`);
      },
    };
    const { ledger, sync } = system(client);
    const installation = await ledger.configureInstallation({
      provider: "github", installationKey: "12", displayName: "GitHub: acme", transport: "webhook",
      config: { installationId: 12, repositoryIds: [42], repositories: ["acme/pilot"],
        permissions: { contents: "read", pull_requests: "read" } },
    }, "user:admin");
    expect(await sync.syncInstallation(installation.id)).toEqual({ observed: 104, incomplete: false });
    const events = (await ledger.listEvidence(200)).filter((event) => event.eventKind === "commit.snapshot");
    expect(events).toHaveLength(102);
    expect(events.map((event) => event.sourceRef)).toEqual(expect.arrayContaining([
      "github:42:commit.snapshot:feature100", "github:42:commit.snapshot:main1",
    ]));
    expect(requested.some((path) => path.includes("/compare/main1...feature1") && path.includes("&page=2"))).toBe(true);
    const state = (await ledger.workspace()).connectorSyncs.find((item) => item.resourceKey === "github:repository:42");
    expect(state?.cursor.coverage).toBe("default_plus_branch_comparisons");
  });
});
