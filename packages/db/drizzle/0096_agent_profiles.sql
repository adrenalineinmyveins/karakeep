CREATE TABLE `agentProfiles` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`type` text NOT NULL,
	`baseUrl` text,
	`apiKey` text,
	`model` text,
	`command` text,
	`timeoutMinutes` integer DEFAULT 5 NOT NULL,
	`systemPrompt` text,
	`enableTools` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agentProfiles_userId_idx` ON `agentProfiles` (`userId`);--> statement-breakpoint
ALTER TABLE `chatSessions` ADD `agentProfileId` text REFERENCES agentProfiles(id);