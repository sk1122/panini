CREATE TABLE "context_document_embeddings" (
	"organization_id" uuid NOT NULL,
	"context_entry_id" uuid NOT NULL,
	"model" text NOT NULL,
	"input_hash" text NOT NULL,
	"vectors" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "context_document_embeddings" ADD CONSTRAINT "context_document_embeddings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "context_document_embeddings" ADD CONSTRAINT "context_document_embeddings_context_entry_id_context_entries_id_fk" FOREIGN KEY ("context_entry_id") REFERENCES "public"."context_entries"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "context_document_embeddings_entry_idx" ON "context_document_embeddings" USING btree ("organization_id","context_entry_id");--> statement-breakpoint
CREATE INDEX "context_document_embeddings_model_idx" ON "context_document_embeddings" USING btree ("organization_id","model");
--> statement-breakpoint
CREATE FUNCTION purge_context_document_embeddings_on_entry_change() RETURNS trigger AS $$
BEGIN
  DELETE FROM context_document_embeddings WHERE context_entry_id = NEW.id;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER context_document_embeddings_entry_change
  AFTER UPDATE OF title, body, kind, lifecycle_state, source_event_id, effective_from, effective_to, evidence_ids
  ON context_entries FOR EACH ROW
  EXECUTE FUNCTION purge_context_document_embeddings_on_entry_change();--> statement-breakpoint
CREATE FUNCTION purge_context_document_embeddings_on_source_revoke() RETURNS trigger AS $$
BEGIN
  IF OLD.content_state = 'active' AND NEW.content_state <> 'active' THEN
    DELETE FROM context_document_embeddings idx
      USING context_entries ce
      WHERE idx.context_entry_id = ce.id
        AND (ce.source_event_id = NEW.id OR NEW.id = ANY(ce.evidence_ids));
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER context_document_embeddings_source_revoke
  AFTER UPDATE OF content_state ON source_events FOR EACH ROW
  EXECUTE FUNCTION purge_context_document_embeddings_on_source_revoke();
