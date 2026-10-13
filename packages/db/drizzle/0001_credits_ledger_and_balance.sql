CREATE TABLE "creditTransactions" (
	"id" text PRIMARY KEY NOT NULL,
	"userId" text NOT NULL,
	"delta" integer NOT NULL,
	"type" text NOT NULL,
	"referenceType" text,
	"referenceId" text,
	"balanceAfter" integer NOT NULL,
	"createdAt" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agentMessages" ADD COLUMN "creditsCharged" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "user" ADD COLUMN "creditsBalance" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "creditTransactions" ADD CONSTRAINT "creditTransactions_userId_user_id_fk" FOREIGN KEY ("userId") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "creditTransactions_userId_idx" ON "creditTransactions" USING btree ("userId");--> statement-breakpoint
CREATE INDEX "creditTransactions_userType_idx" ON "creditTransactions" USING btree ("userId","type");--> statement-breakpoint
CREATE INDEX "creditTransactions_reference_idx" ON "creditTransactions" USING btree ("referenceType","referenceId");