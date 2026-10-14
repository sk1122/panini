import { DomainError } from "../domain/errors.js";
import { outcomeContractSchema, taskPatchSchema } from "../domain/evidence-schema.js";
import type { TaskPatchOperation } from "../domain/evidence-types.js";
import type {
  Task,
  TaskFields,
  TaskProposalChanges,
} from "../domain/types.js";

const requiredTaskKeys = [
  "externalRef",
  "title",
  "description",
  "status",
  "priority",
  "owner",
  "project",
  "dueDate",
  "dependencyRefs",
  "sourceUrl",
] as const satisfies readonly (keyof TaskFields)[];

export function taskFieldsFromCreate(changes: TaskProposalChanges): TaskFields {
  for (const key of requiredTaskKeys) {
    if (!(key in changes)) {
      throw new DomainError(`Task creation is missing ${key}.`, "INVALID");
    }
  }
  return changes as TaskFields;
}

export function compileTaskPatch(operations: readonly TaskPatchOperation[]): TaskProposalChanges {
  const parsed = taskPatchSchema.parse(operations);
  const patch: TaskProposalChanges = {};
  const clearToNull = new Set(["owner", "project", "projectId", "dueDate", "sourceUrl"]);
  for (const operation of parsed) {
    if (operation.op === "set") {
      Object.assign(patch, { [operation.field]: operation.value });
    } else if (operation.field === "dependencyRefs") {
      patch.dependencyRefs = [];
    } else if (clearToNull.has(operation.field)) {
      Object.assign(patch, { [operation.field]: null });
    } else {
      throw new DomainError(`Field cannot be cleared: ${operation.field}`, "INVALID");
    }
  }
  return patch;
}

export function applyTaskChanges(task: Task, changes: TaskProposalChanges, now: string): Task {
  return {
    ...task,
    ...changes,
    id: task.id,
    version: task.version + 1,
    createdAt: task.createdAt,
    updatedAt: now,
  };
}

/** Contract provenance is assigned at acceptance, never trusted from a proposal body. */
export function acceptedTaskChanges(input: { previous: Task | null; changes: TaskProposalChanges;
  proposalId: string; evidenceIds: string[]; decidedBy: string; decidedAt: string;
  state: "approved" | "auto_applied" }): TaskProposalChanges {
  if (input.changes.outcomeContract === undefined) return input.changes;
  if (input.changes.outcomeContract === null) {
    throw new DomainError("An accepted outcome contract cannot be cleared.", "INVALID");
  }
  if (input.state !== "approved" || input.decidedBy.startsWith("intelligence:")) {
    throw new DomainError("An outcome contract needs an explicit reviewer.", "FORBIDDEN");
  }
  const contract = outcomeContractSchema.parse(input.changes.outcomeContract);
  const expectedVersion = (input.previous?.outcomeContract?.version ?? 0) + 1;
  if (contract.version !== expectedVersion) {
    throw new DomainError("Outcome contract version must advance exactly once.", "CONFLICT");
  }
  const acceptedAt = input.decidedAt;
  return { ...input.changes, outcomeContract: {
    ...contract,
    criteria: contract.criteria.map((criterion) => ({ ...criterion,
      acceptedBy: input.decidedBy, acceptedAt })),
    provenance: { proposalId: input.proposalId,
      evidenceIds: [...new Set(input.evidenceIds)].sort(), actor: input.decidedBy, acceptedAt },
  } };
}
