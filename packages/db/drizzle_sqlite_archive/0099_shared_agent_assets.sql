CREATE TABLE `sharedAgentAssets` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`assetType` text NOT NULL,
	`assetId` text NOT NULL,
	`shareToken` text NOT NULL,
	`name` text NOT NULL,
	`payload` text NOT NULL,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sharedAgentAssets_shareToken_unique` ON `sharedAgentAssets` (`shareToken`);--> statement-breakpoint
CREATE INDEX `sharedAgentAssets_userId_idx` ON `sharedAgentAssets` (`userId`);--> statement-breakpoint
CREATE UNIQUE INDEX `sharedAgentAssets_userId_assetType_assetId_unique` ON `sharedAgentAssets` (`userId`,`assetType`,`assetId`);