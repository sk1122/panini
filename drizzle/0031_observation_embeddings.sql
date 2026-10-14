ALTER TABLE "work_entity_embeddings" DROP CONSTRAINT "work_entity_embeddings_type_check";--> statement-breakpoint
ALTER TABLE "work_entity_embeddings" ADD CONSTRAINT "work_entity_embeddings_type_check" CHECK ("entity_type" IN ('task','project','claim','context','query'));
