ALTER TABLE `chatSessions` ADD `ownerUserId` text REFERENCES user(id) ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE `chatSessions` ADD `publicationId` text REFERENCES agentPublications(id) ON DELETE SET NULL;
