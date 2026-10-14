import { createHash, sign } from "node:crypto";
import { DomainError } from "../../domain/errors.js";

export interface GithubAppCredentials {
  appId: number;
  clientId: string;
  clientSecret: string;
  appSlug: string;
  privateKey: string;
  callbackUrl: string;
}

export interface GithubAccount {
  id: number;
  login: string;
  type: string;
}

export interface GithubInstallation {
  id: number;
  account: GithubAccount;
  permissions: Record<string, string>;
  repository_selection: "all" | "selected";
  suspended_at: string | null;
}

export interface GithubRepository {
  id: number;
  name: string;
  full_name: string;
  private: boolean;
  html_url: string;
  default_branch: string;
  archived: boolean;
}

type Fetch = typeof fetch;

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url");
}

export function githubAppJwt(credentials: Pick<GithubAppCredentials, "appId" | "privateKey">, now = Date.now()): string {
  const issuedAt = Math.floor(now / 1000);
  const head = base64Url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const payload = base64Url(JSON.stringify({ iat: issuedAt - 60, exp: issuedAt + 540, iss: credentials.appId }));
  const message = `${head}.${payload}`;
  const signature = sign("RSA-SHA256", Buffer.from(message), credentials.privateKey).toString("base64url");
  return `${message}.${signature}`;
}

export function githubPkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export class GithubAppClient {
  constructor(readonly credentials: GithubAppCredentials, private readonly fetchImpl: Fetch = fetch) {}

  authorizationUrl(state: string, verifier: string): string {
    const url = new URL("https://github.com/login/oauth/authorize");
    url.searchParams.set("client_id", this.credentials.clientId);
    url.searchParams.set("redirect_uri", this.credentials.callbackUrl);
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", githubPkceChallenge(verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return url.toString();
  }

  installationUrl(): string {
    return `https://github.com/apps/${encodeURIComponent(this.credentials.appSlug)}/installations/new`;
  }

  async exchangeCode(code: string, verifier: string): Promise<string> {
    const response = await this.fetchImpl("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        client_id: this.credentials.clientId,
        client_secret: this.credentials.clientSecret,
        code,
        redirect_uri: this.credentials.callbackUrl,
        code_verifier: verifier,
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const body = await response.json() as { access_token?: string; error?: string };
    if (!response.ok || !body.access_token) {
      throw new DomainError(`GitHub authorization failed: ${body.error ?? response.status}.`, "FORBIDDEN");
    }
    return body.access_token;
  }

  async user(token: string): Promise<GithubAccount> {
    return this.request<GithubAccount>("/user", token);
  }

  async organizationMemberships(token: string): Promise<GithubAccount[]> {
    const memberships = await this.request<Array<{ organization: GithubAccount; state: string }>>(
      "/user/memberships/orgs?state=active&per_page=100", token,
    );
    return memberships.filter((item) => item.state === "active").map((item) => item.organization);
  }

  async userInstallations(token: string): Promise<GithubInstallation[]> {
    return this.paginate<GithubInstallation>("/user/installations", token, "installations");
  }

  async userInstallationRepositories(token: string, installationId: number): Promise<GithubRepository[]> {
    return this.paginate<GithubRepository>(
      `/user/installations/${installationId}/repositories`, token, "repositories",
    );
  }

  async installationToken(installationId: number, repositoryIds?: number[]): Promise<string> {
    if (repositoryIds && !repositoryIds.length) throw new DomainError("Select at least one GitHub repository.", "INVALID");
    const result = await this.request<{ token: string }>(
      `/app/installations/${installationId}/access_tokens`, githubAppJwt(this.credentials), "POST",
      repositoryIds ? { repository_ids: repositoryIds } : {},
    );
    if (!result.token) throw new DomainError("GitHub did not return an installation token.", "INVALID");
    return result.token;
  }

  async installationRepositories(token: string): Promise<GithubRepository[]> {
    return this.paginate<GithubRepository>("/installation/repositories", token, "repositories");
  }

  async repositoryData<T>(token: string, path: string): Promise<T> {
    if (!/^\/repos\/[^/?]+\/[^/?]+\//.test(path)) throw new DomainError("GitHub repository path is invalid.", "INVALID");
    return this.request<T>(path, token);
  }

  async conditionalRepositoryData<T>(token: string, path: string, etag: string | null): Promise<{
    kind: "fresh"; data: T; etag: string | null;
  } | { kind: "not_modified"; etag: string | null }> {
    if (!/^\/repos\/[^/?]+\/[^/?]+\//.test(path)) {
      throw new DomainError("GitHub repository path is invalid.", "INVALID");
    }
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(etag ? { "If-None-Match": etag } : {}) },
      signal: AbortSignal.timeout(20_000),
    });
    if (response.status === 304 && etag) return { kind: "not_modified",
      etag: response.headers.get("etag") ?? etag };
    if (!response.ok) {
      throw new DomainError(`GitHub API request failed (${response.status}).`,
        [401, 403, 404].includes(response.status) ? "FORBIDDEN" : "INVALID");
    }
    return { kind: "fresh", data: await response.json() as T,
      etag: response.headers.get("etag") };
  }

  private async paginate<T>(path: string, token: string, key: "installations" | "repositories"): Promise<T[]> {
    const items: T[] = [];
    for (let page = 1; page <= 100; page += 1) {
      const separator = path.includes("?") ? "&" : "?";
      const response = await this.request<Record<string, T[]>>(`${path}${separator}per_page=100&page=${page}`, token);
      const batch = response[key];
      if (!Array.isArray(batch)) throw new DomainError("GitHub returned an invalid paginated response.", "INVALID");
      items.push(...batch);
      if (batch.length < 100) return items;
    }
    throw new DomainError("GitHub pagination exceeded the configured limit.", "INVALID");
  }

  private async request<T>(path: string, token: string, method = "GET", body?: unknown): Promise<T> {
    const response = await this.fetchImpl(`https://api.github.com${path}`, {
      method,
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2026-03-10",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(20_000),
    });
    if (!response.ok) {
      throw new DomainError(`GitHub API request failed (${response.status}).`,
        [401, 403, 404].includes(response.status) ? "FORBIDDEN" : "INVALID");
    }
    return await response.json() as T;
  }
}
