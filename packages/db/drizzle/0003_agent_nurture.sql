ALTER TABLE "agentProfiles" ADD COLUMN "bio" text;--> statement-breakpoint
ALTER TABLE "agentProfiles" ADD COLUMN "expertise_tags" jsonb;--> statement-breakpoint
ALTER TABLE "agentProfiles" ADD COLUMN "nurture_auto" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "agentProfiles" ADD COLUMN "nurture_state" jsonb;