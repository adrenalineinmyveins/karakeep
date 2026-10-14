ALTER TABLE "agentMessages" ADD COLUMN "parentMessageId" text;--> statement-breakpoint
ALTER TABLE "agentMessages" ADD COLUMN "depth" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "agentProfiles" ADD COLUMN "consultBudget" integer;