ALTER TABLE model_calls DROP CONSTRAINT model_calls_purpose_check;
--> statement-breakpoint
ALTER TABLE model_calls ADD CONSTRAINT model_calls_purpose_check CHECK (purpose IN ('observe','route','embed','rank','extract','identity','assess','verify','summarize','artifact_fetch'));
--> statement-breakpoint
ALTER TABLE observation_dispositions DROP CONSTRAINT observation_dispositions_state_check;
--> statement-breakpoint
ALTER TABLE observation_dispositions ADD CONSTRAINT observation_dispositions_state_check CHECK (state IN ('pending','processing','processed','extracted','partial','no_claim','duplicate','unresolved','failed'));
