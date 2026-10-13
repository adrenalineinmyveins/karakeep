CREATE TABLE `agentMessages` (
	`id` text PRIMARY KEY NOT NULL,
	`requesterUserId` text NOT NULL,
	`requesterProfileId` text,
	`targetPublicationId` text NOT NULL,
	`skillId` text,
	`sessionId` text,
	`question` text NOT NULL,
	`answer` text,
	`state` text DEFAULT 'pending' NOT NULL,
	`note` text,
	`expiresAt` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`requesterUserId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`requesterProfileId`) REFERENCES `agentProfiles`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`targetPublicationId`) REFERENCES `agentPublications`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`skillId`) REFERENCES `agentSkills`(`id`) ON UPDATE no action ON DELETE set null,
	FOREIGN KEY (`sessionId`) REFERENCES `chatSessions`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE INDEX `agentMessages_target_state_idx` ON `agentMessages` (`targetPublicationId`,`state`);--> statement-breakpoint
CREATE INDEX `agentMessages_requester_created_idx` ON `agentMessages` (`requesterUserId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `agentMessages_session_idx` ON `agentMessages` (`sessionId`);--> statement-breakpoint
ALTER TABLE `agentPublications` ADD `auto_expertise` text;--> statement-breakpoint
ALTER TABLE `agentPublications` ADD `avatarAssetId` text;