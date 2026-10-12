CREATE TABLE `agentSkills` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`agentProfileId` text NOT NULL,
	`name` text NOT NULL,
	`description` text NOT NULL,
	`promptTemplate` text NOT NULL,
	`outputHint` text,
	`params_schema` text,
	`enabled` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`agentProfileId`) REFERENCES `agentProfiles`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `agentSkills_profileId_idx` ON `agentSkills` (`agentProfileId`);