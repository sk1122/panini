import { pantryConnection } from "./panini-token.mjs";

// Claude Code runs this as the MCP server's headersHelper, so the token is read
// from the keychain at request time and never written into ~/.claude.json.
const connection = pantryConnection();

if (!connection) {
	process.stderr.write(
		"Panini is not connected. Run: npx panini-work connect\n",
	);
	process.exit(1);
}
process.stdout.write(
	JSON.stringify({
		Authorization: `Bearer ${connection.token}`,
		"x-panini-harness": "claude_code",
	}),
);
