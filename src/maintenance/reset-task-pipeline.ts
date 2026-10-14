import { randomUUID } from "node:crypto";
import pg from "pg";

const { Pool } = pg;
const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required.");
const apply = process.argv.includes("--apply");
const backup = process.argv.find((arg) => arg.startsWith("--backup="))?.slice("--backup=".length);
if (apply && !backup) throw new Error("A verified backup reference is required for --apply.");

const pool = new Pool({ connectionString: databaseUrl });
const client = await pool.connect();
try {
  await client.query("BEGIN");
  await client.query("LOCK TABLE tasks, context_entries, proposals IN ACCESS EXCLUSIVE MODE");
  const organizationResult = await client.query<{ id: string }>(
    "SELECT id FROM organizations WHERE slug = 'default'",
  );
  if (organizationResult.rows.length !== 1) throw new Error("Expected exactly one default organization.");
  const organizationId = organizationResult.rows[0]!.id;
  const counts = await client.query<{ tasks: number; context: number; proposals: number; proposalOutboxJobs: number;
    projects: number; sources: number }>(
    `SELECT (SELECT count(*) FROM tasks WHERE organization_id = $1)::int AS tasks,
      (SELECT count(*) FROM context_entries WHERE organization_id = $1)::int AS context,
      (SELECT count(*) FROM proposals WHERE organization_id = $1)::int AS proposals,
      (SELECT count(*) FROM outbox_jobs oj
        WHERE oj.organization_id = $1
          AND EXISTS (SELECT 1 FROM proposals p
            WHERE p.organization_id = $1 AND p.id::text = oj.payload->>'proposalId'))::int AS "proposalOutboxJobs",
      (SELECT count(*) FROM projects WHERE organization_id = $1)::int AS projects,
      (SELECT count(*) FROM source_events WHERE organization_id = $1)::int AS sources`,
    [organizationId],
  );
  const before = counts.rows[0]!;
  if (!apply) {
    await client.query("ROLLBACK");
    console.log(JSON.stringify({ dryRun: true, before }));
  } else {
    // Accepted Task and Context projections are included in the external
    // backup. Source observations, Projects, interpretation runs, and audits remain.
    await client.query("DELETE FROM task_revisions WHERE organization_id = $1", [organizationId]);
    await client.query("DELETE FROM context_revisions WHERE organization_id = $1", [organizationId]);
    await client.query("DELETE FROM context_document_embeddings WHERE organization_id = $1", [organizationId]);
    await client.query("DELETE FROM work_links WHERE organization_id = $1", [organizationId]);
    await client.query("DELETE FROM tasks WHERE organization_id = $1", [organizationId]);
    await client.query("DELETE FROM context_entries WHERE organization_id = $1", [organizationId]);
    await client.query(
      `DELETE FROM outbox_jobs oj
        WHERE oj.organization_id = $1
          AND EXISTS (SELECT 1 FROM proposals p
            WHERE p.organization_id = $1 AND p.id::text = oj.payload->>'proposalId')`,
      [organizationId],
    );
    await client.query("DELETE FROM proposals WHERE organization_id = $1", [organizationId]);
    await client.query(
      `INSERT INTO audit_events (id, organization_id, actor, action, target_type, target_id, details, occurred_at)
       VALUES ($1, $2::uuid, 'system:projection-reset', 'work_context_projections.reset', 'organization', $2::text,
         $3::jsonb, now())`,
      [randomUUID(), organizationId, JSON.stringify({ backup, removedTasks: before.tasks,
        removedContextEntries: before.context, removedProposals: before.proposals,
        removedProposalOutboxJobs: before.proposalOutboxJobs, retainedProjects: before.projects,
        retainedSourceEvents: before.sources })],
    );
    await client.query("COMMIT");
    console.log(JSON.stringify({ applied: true, before, after: { tasks: 0, context: 0, proposals: 0,
      projects: before.projects, sources: before.sources } }));
  }
} catch (error) {
  await client.query("ROLLBACK");
  throw error;
} finally {
  client.release();
  await pool.end();
}
