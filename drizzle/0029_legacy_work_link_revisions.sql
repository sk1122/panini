-- Existing accepted links predate work_link_revisions. Record their observed
-- projection as a legacy snapshot; do not infer an earlier actor or proposal.
INSERT INTO work_link_revisions
  (id, organization_id, link_id, version, previous, current, changed_at, changed_by, proposal_id)
SELECT
  (
    substr(md5('panini-work-link-backfill:' || link.id::text), 1, 8) || '-' ||
    substr(md5('panini-work-link-backfill:' || link.id::text), 9, 4) || '-' ||
    substr(md5('panini-work-link-backfill:' || link.id::text), 13, 4) || '-' ||
    substr(md5('panini-work-link-backfill:' || link.id::text), 17, 4) || '-' ||
    substr(md5('panini-work-link-backfill:' || link.id::text), 21, 12)
  )::uuid,
  link.organization_id,
  link.id,
  1,
  NULL,
  jsonb_build_object(
    'id', link.id,
    'organizationId', link.organization_id,
    'taskId', link.task_id,
    'targetTaskId', link.target_task_id,
    'targetRef', link.target_ref,
    'linkType', link.link_type,
    'createdAt', to_char(link.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
    'updatedAt', to_char(link.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
  ),
  link.updated_at,
  'system:migration:legacy-link-snapshot',
  NULL
FROM work_links AS link
WHERE NOT EXISTS (
  SELECT 1 FROM work_link_revisions AS revision WHERE revision.link_id = link.id
)
ON CONFLICT (link_id, version) DO NOTHING;
