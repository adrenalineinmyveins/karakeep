CREATE TABLE `consultationUsages` (
	`id` text PRIMARY KEY NOT NULL,
	`publicationId` text NOT NULL,
	`consulteeUserId` text NOT NULL,
	`sessionId` text NOT NULL,
	`amount` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`publicationId`) REFERENCES `agentPublications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`consulteeUserId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`sessionId`) REFERENCES `chatSessions`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `consultationUsages_sessionId_idx` ON `consultationUsages` (`sessionId`);--> statement-breakpoint
CREATE INDEX `consultationUsages_publicationId_idx` ON `consultationUsages` (`publicationId`);