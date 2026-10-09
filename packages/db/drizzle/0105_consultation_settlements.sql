CREATE TABLE `consultationSettlements` (
	`id` text PRIMARY KEY NOT NULL,
	`publicationId` text NOT NULL,
	`userId` text NOT NULL,
	`amount` integer NOT NULL,
	`usageCount` integer NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`publicationId`) REFERENCES `agentPublications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `consultationSettlements_publicationId_idx` ON `consultationSettlements` (`publicationId`);--> statement-breakpoint
ALTER TABLE `consultationUsages` ADD `settlementId` text REFERENCES consultationSettlements(id);