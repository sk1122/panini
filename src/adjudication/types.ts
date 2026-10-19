import type {
	JsonValue,
	ProposalKind,
	ProposalState,
} from "../domain/types.js";
import type { ModelUsage } from "../model-usage.js";

export type AdjudicationAction =
	"approve" | "reject" | "supersede" | "escalate";

export interface AdjudicationEvidenceDigest {
	id: string;
	provider: string;
	eventKind: string;
	occurredAt: string;
	fetchedAt: string;
	receivedAt: string;
	sourceRef: string;
	sourceUrl: string | null;
	payloadExcerpt: string;
}

export interface AdjudicationProposalDigest {
	id: string;
	kind: ProposalKind;
	taskId: string | null;
	baseVersion: number | null;
	changes: JsonValue;
	rationale: string;
	requestedBy: string;
	evidenceIds: string[];
	createdAt: string;
}

export interface AcceptedRevisionDigest {
	version: number;
	proposalId: string;
	appliedAt: string;
	appliedBy: string;
	snapshot: JsonValue;
	evidenceOccurredAt: string | null;
}

export interface RelatedProposalDigest {
	id: string;
	state: ProposalState;
	kind: ProposalKind;
	changes: JsonValue;
	rationale: string;
	requestedBy: string;
	createdAt: string;
	decidedAt: string | null;
	decisionNote: string | null;
	evidenceOccurredAt: string | null;
}

export interface AdjudicationCase {
	proposal: AdjudicationProposalDigest;
	targetKey: string;
	staleBase: boolean;
	currentTarget: JsonValue | null;
	acceptedHistory: AcceptedRevisionDigest[];
	relatedProposals: RelatedProposalDigest[];
	candidateEvidenceOccurredAt: {
		earliest: string | null;
		latest: string | null;
	};
	currentEvidenceOccurredAt: string | null;
}

export interface AdjudicationBatchInput {
	companyName: string;
	adjudicatedAt: string;
	evidence: AdjudicationEvidenceDigest[];
	cases: AdjudicationCase[];
}

export interface AdjudicationDecision {
	proposalId: string;
	action: AdjudicationAction;
	confidence: number;
	rationale: string;
	temporalBasis: string;
	historicalBasis: string[];
}

export interface AdjudicationBatchOutput {
	decisions: AdjudicationDecision[];
	usage?: ModelUsage;
}

export interface AdjudicationProvider {
	readonly name: string;
	adjudicate(input: AdjudicationBatchInput): Promise<AdjudicationBatchOutput>;
}

export interface AdjudicationConfig {
	enabled: boolean;
	mode: "manual" | "interval";
	intervalSeconds: number;
	maxProposalsPerRun: number;
	maxEvidenceCharacters: number;
	maxHistoryCharacters: number;
	maxHistoryItems: number;
	approvalMinimumConfidence: number;
}

export interface CompletionPolicy {
	minimumEvidenceItems: number;
	evidenceProviders: string[];
}

export interface AdjudicationOutcome {
	proposalId: string;
	action: AdjudicationAction;
	state: ProposalState;
	confidence: number;
	reason: string;
	source: "deterministic" | "model";
	replacementProposalId: string | null;
}

export interface AdjudicationRunReport {
	state: "completed" | "no_proposals";
	model: string;
	outcomes: AdjudicationOutcome[];
	usage: ModelUsage | null;
	startedAt: string;
	finishedAt: string;
}
