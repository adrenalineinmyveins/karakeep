CREATE TABLE `agentPublications` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`agentProfileId` text NOT NULL,
	`title` text NOT NULL,
	`description` text,
	`tags` text DEFAULT '[]' NOT NULL,
	`pricePerCall` integer DEFAULT 0 NOT NULL,
	`status` text DEFAULT 'published' NOT NULL,
	`delistingAt` integer,
	`delistedAt` integer,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agentProfileId`) REFERENCES `agentProfiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agentPublications_userId_idx` ON `agentPublications` (`userId`);--> statement-breakpoint
CREATE INDEX `agentPublications_status_idx` ON `agentPublications` (`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `agentPublications_userId_agentProfileId_unique` ON `agentPublications` (`userId`,`agentProfileId`);