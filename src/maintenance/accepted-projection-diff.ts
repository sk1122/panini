import { contentHash } from "../domain/content-hash.js";
import type { LedgerStore } from "../domain/store.js";

type EntitySnapshot = { count: number; hash: string; rows: Record<string, string> };
export type AcceptedProjectionSnapshot = {
  tasks: EntitySnapshot;
  context: EntitySnapshot;
  links: EntitySnapshot;
};

function snapshot<T extends { id: string }>(items: T[]): EntitySnapshot {
  const rows = Object.fromEntries(items.map((item) => [item.id, contentHash(item)]));
  return { count: items.length, hash: contentHash(rows), rows };
}

export async function acceptedProjectionSnapshot(store: LedgerStore): Promise<AcceptedProjectionSnapshot> {
  const [tasks, context, links] = await Promise.all([
    store.listTasks(), store.listContextEntries(), store.listWorkLinks(),
  ]);
  return { tasks: snapshot(tasks), context: snapshot(context), links: snapshot(links) };
}

export function acceptedProjectionDiff(before: AcceptedProjectionSnapshot,
  after: AcceptedProjectionSnapshot) {
  const compare = (type: keyof AcceptedProjectionSnapshot) => {
    const original = before[type];
    const current = after[type];
    const missing = Object.keys(original.rows).filter((id) => !(id in current.rows)).sort();
    const extra = Object.keys(current.rows).filter((id) => !(id in original.rows)).sort();
    const changed = Object.keys(original.rows).filter((id) =>
      id in current.rows && original.rows[id] !== current.rows[id]).sort();
    return { beforeCount: original.count, afterCount: current.count,
      beforeHash: original.hash, afterHash: current.hash,
      missing, extra, changed,
      unchanged: missing.length === 0 && extra.length === 0 && changed.length === 0
        && original.hash === current.hash };
  };
  const tasks = compare("tasks");
  const context = compare("context");
  const links = compare("links");
  return { tasks, context, links, unchanged: tasks.unchanged && context.unchanged && links.unchanged };
}
