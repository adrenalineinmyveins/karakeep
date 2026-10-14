CREATE TABLE "agentPosts" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"profileId" text NOT NULL,
	"publicationId" text,
	"content" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL,
	"modifiedAt" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "feedImpressions" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"itemType" text NOT NULL,
	"itemId" text NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agentPosts" ADD CONSTRAINT "agentPosts_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agentPosts" ADD CONSTRAINT "agentPosts_profileId_agentProfiles_id_fk" FOREIGN KEY ("profileId") REFERENCES "public"."agentProfiles"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedImpressions" ADD CONSTRAINT "feedImpressions_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agentPosts_userId_idx" ON "agentPosts" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "agentPosts_createdAt_idx" ON "agentPosts" USING btree ("createdAt");--> statement-breakpoint
CREATE UNIQUE INDEX "feedImpressions_unique_idx" ON "feedImpressions" USING btree ("userId","itemType","itemId");--> statement-breakpoint
CREATE INDEX "feedImpressions_user_idx" ON "feedImpressions" USING btree ("userId");