import type { NewProposal } from "./types.js";

export interface PolicyConfig {
  mode?: "autonomous" | "manual_review";
  autoApproveNewTasks: boolean;
  autoApproveContext: boolean;
  requireReviewForTaskChanges: boolean;
}

export interface PolicyDecision {
  action: "auto_apply" | "adjudicate" | "review";
  reason: string;
}

export class ProposalPolicy {
  constructor(private readonly config: PolicyConfig) {}

  decide(proposal: NewProposal): PolicyDecision {
    // Connector observations are evidence, not authority to change accepted work.
    // Direct human creation has its own explicit acceptance path in TeamLedger.

    if (
      proposal.kind === "context_update" ||
      proposal.kind === "context_file_upsert" ||
      proposal.kind === "context_fact_upsert"
    ) {
      return { action: "review", reason: "Manual-review policy requires a person to decide model-derived context." };
    }

    return { action: "review", reason: "Manual-review policy requires a person to decide before task state changes." };
  }

}
