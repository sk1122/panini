import { PostgresLedgerStore } from "../../src/store/postgres.js";
import { TeamLedger } from "../../src/domain/team-ledger.js";
import { ProposalPolicy } from "../../src/domain/policy.js";

const [organizationId, proposalId] = process.argv.slice(2);
const databaseUrl = process.env.PANINI_TEST_DATABASE_URL;

if (!organizationId || !proposalId || !databaseUrl?.includes("panini_e2e")) {
	throw new Error("Isolated approval recovery arguments required.");
}

const store = new PostgresLedgerStore(
	databaseUrl,
	Buffer.alloc(32, 19).toString("base64"),
	organizationId,
);
const ledger = new TeamLedger(
	store,
	new ProposalPolicy({
		autoApproveNewTasks: false,
		autoApproveContext: false,
		requireReviewForTaskChanges: true,
	}),
);

await ledger.approveProposal(proposalId, "user:e2e", "Reviewer confirmed");
process.kill(process.pid, "SIGKILL");
