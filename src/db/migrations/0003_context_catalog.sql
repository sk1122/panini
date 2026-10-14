ALTER TABLE proposals DROP CONSTRAINT IF EXISTS proposals_kind_check;
ALTER TABLE proposals
  ADD CONSTRAINT proposals_kind_check
  CHECK (kind IN (
    'task_create', 'task_change', 'context_update', 'context_file_upsert', 'context_fact_upsert'
  ));

CREATE TABLE IF NOT EXISTS context_entries (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('file', 'fact')),
  source_event_id uuid NOT NULL REFERENCES source_events(id),
  source_ref text NOT NULL UNIQUE,
  path text NOT NULL UNIQUE,
  title text NOT NULL,
  body text,
  fact_type text,
  fact_value jsonb,
  source_url text,
  content_hash text NOT NULL,
  evidence_ids uuid[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL,
  CONSTRAINT context_entries_shape_check CHECK (
    (kind = 'file' AND body IS NOT NULL AND fact_type IS NULL AND fact_value IS NULL)
    OR
    (kind = 'fact' AND body IS NULL AND fact_type IN (
      'identity', 'decision', 'policy', 'constraint', 'preference',
      'relationship', 'metric', 'reference', 'other'
    ) AND jsonb_typeof(fact_value) IN ('string', 'number', 'boolean'))
  )
);

CREATE INDEX IF NOT EXISTS context_entries_kind_path_idx ON context_entries (kind, path);
CREATE INDEX IF NOT EXISTS context_entries_evidence_ids_idx ON context_entries USING gin (evidence_ids);

WITH prepared AS (
  SELECT
    document.*,
    regexp_replace(lower(split_part(document.key, ':', 1)), '[^a-z0-9]+', '-', 'g') AS slug,
    count(*) OVER (
      PARTITION BY regexp_replace(lower(split_part(document.key, ':', 1)), '[^a-z0-9]+', '-', 'g')
    ) AS sibling_count
  FROM context_documents document
)
INSERT INTO context_entries (
  id, kind, source_event_id, source_ref, path, title, body, fact_type, fact_value,
  source_url, content_hash, evidence_ids, updated_at
)
SELECT
  id,
  'file',
  source_event_id,
  source_ref,
  '/sources/notion/' || CASE
    WHEN sibling_count = 1 THEN COALESCE(NULLIF(slug, ''), 'untitled')
    ELSE COALESCE(NULLIF(slug, ''), 'untitled') || '-' || left(id::text, 8)
  END || '.md',
  title,
  body,
  NULL,
  NULL,
  source_url,
  content_hash,
  ARRAY[source_event_id]::uuid[],
  updated_at
FROM prepared
ON CONFLICT (source_ref) DO NOTHING;
