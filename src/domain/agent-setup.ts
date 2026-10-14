import type { AgentProfile } from "./types.js";
import { agentHarnesses } from "./types.js";

export function buildAgentSetups(profile: AgentProfile, baseUrl: string, enrollmentSecret?: string): AgentSetupRecipe[] {
  return agentHarnesses.map((harness) => buildAgentSetup({ ...profile, harness }, baseUrl, enrollmentSecret));
}

export interface AgentSetupStep {
  title: string;
  copy: string;
  code: string;
}

export interface AgentSetupRecipe {
  profileId: string;
  harness: AgentProfile["harness"];
  harnessLabel: string;
  serverName: string;
  endpoint: string;
  tokenEnvironmentVariable: string;
  steps: readonly AgentSetupStep[];
  verificationPrompt: string;
  notes: readonly string[];
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 36) || "agent";
}

function shellSecretStep(environmentVariable: string): AgentSetupStep {
  return {
    title: "Load the secret",
    copy: "Paste the one-time secret when the terminal waits, then press Enter. Save it in your normal secret manager for future sessions.",
    code: `read -r -s ${environmentVariable}\nexport ${environmentVariable}`,
  };
}

export function buildAgentSetup(profile: AgentProfile, baseUrl: string, enrollmentSecret?: string): AgentSetupRecipe {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/mcp`;
  const serverName = `panini-${slug(profile.name)}-${profile.id.slice(0, 6)}`;
  const tokenEnvironmentVariable = `PANINI_AGENT_${profile.id.replaceAll("-", "").slice(0, 8).toUpperCase()}_TOKEN`;
  const shared = {
    profileId: profile.id,
    harness: profile.harness,
    serverName,
    endpoint,
    tokenEnvironmentVariable,
    verificationPrompt: "Read the company context index, find my current work, and explain which changes require review.",
    notes: [
      "The secret is shown only after creation or rotation.",
      "Agent writes create reviewable proposals or evidence. They do not directly change accepted work or context.",
      `Granted capabilities: ${profile.capabilities.join(", ")}.`,
    ],
  } as const;

  if (profile.harness === "codex") {
    return {
      ...shared,
      harnessLabel: "Codex",
      steps: [
        shellSecretStep(tokenEnvironmentVariable),
        {
          title: "Connect Panini",
          copy: "Add the profile as a user-scoped Streamable HTTP MCP server.",
          code: `codex mcp add ${serverName} --url ${endpoint} --bearer-token-env-var ${tokenEnvironmentVariable}`,
        },
        ...(enrollmentSecret ? [{
          title: "Or connect with the secret directly",
          copy: "Use this only on a private machine. Codex stores the secret in plaintext in your user config.",
          code: `[mcp_servers.${serverName}]\nurl = ${JSON.stringify(endpoint)}\nhttp_headers = { Authorization = ${JSON.stringify(`Bearer ${enrollmentSecret}`)} }`,
        }] : []),
        { title: "Verify", copy: "Restart Codex if it is already open, then confirm the server is present.", code: "codex mcp list" },
      ],
    };
  }

  if (profile.harness === "claude_code") {
    const json = JSON.stringify({
      type: "http",
      url: endpoint,
      headers: { Authorization: `Bearer \${${tokenEnvironmentVariable}}` },
    });
    return {
      ...shared,
      harnessLabel: "Claude Code",
      steps: [
        shellSecretStep(tokenEnvironmentVariable),
        {
          title: "Connect Panini",
          copy: "Add a private user-scoped server. The saved configuration references the environment variable, not the secret value.",
          code: `claude mcp add-json --scope user ${serverName} '${json}'`,
        },
        { title: "Verify", copy: "Inspect the connection, or open /mcp inside Claude Code.", code: `claude mcp get ${serverName}` },
      ],
    };
  }

  if (profile.harness === "hermes") {
    return {
      ...shared,
      harnessLabel: "Hermes Agent",
      steps: [
        shellSecretStep(tokenEnvironmentVariable),
        {
          title: "Add Panini to Hermes",
          copy: "Add this server block under mcp_servers in ~/.hermes/config.yaml. Hermes resolves the environment variable when it connects.",
          code: `mcp_servers:\n  ${serverName}:\n    url: "${endpoint}"\n    headers:\n      Authorization: "Bearer \${${tokenEnvironmentVariable}}"`,
        },
        {
          title: "Test and reload",
          copy: "Test the connection, then start Hermes. Use /reload-mcp in an existing session after changing the config.",
          code: `hermes mcp test ${serverName}\nhermes chat`,
        },
      ],
    };
  }

  if (profile.harness === "pi") {
    return {
      ...shared,
      harnessLabel: "Pi",
      steps: [
        shellSecretStep(tokenEnvironmentVariable),
        {
          title: "Install the adapter",
          copy: "Pi keeps MCP outside its core. This reviewed TypeScript extension maps Pi tools to Panini's authenticated MCP endpoint.",
          code: `mkdir -p ~/.pi/agent/extensions\ncurl -fsSL ${baseUrl.replace(/\/$/, "")}/integrations/pi/panini.ts -o ~/.pi/agent/extensions/panini.ts`,
        },
        {
          title: "Start Pi",
          copy: "Launch Pi with this profile's secret. If Pi is already running, reload extensions after setting the variables.",
          code: `PANINI_URL=${baseUrl.replace(/\/$/, "")} PANINI_AGENT_TOKEN=\"$${tokenEnvironmentVariable}\" pi`,
        },
      ],
    };
  }

  const genericConfig = JSON.stringify({
    mcpServers: {
      [serverName]: {
        type: "http",
        url: endpoint,
        headers: { Authorization: `Bearer \${${tokenEnvironmentVariable}}` },
      },
    },
  }, null, 2);
  return {
    ...shared,
    harnessLabel: "Generic MCP",
    steps: [
      shellSecretStep(tokenEnvironmentVariable),
      {
        title: "Add the server",
        copy: "Paste this into the harness's MCP configuration and keep environment expansion enabled.",
        code: genericConfig,
      },
      { title: "Verify", copy: "Ask the harness to list MCP tools, then use the verification prompt below.", code: shared.verificationPrompt },
    ],
  };
}
