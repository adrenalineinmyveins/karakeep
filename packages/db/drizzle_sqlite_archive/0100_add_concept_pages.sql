CREATE TABLE `conceptPageSources` (
	`pageId` text NOT NULL,
	`bookmarkId` text NOT NULL,
	`attachedAt` integer,
	PRIMARY KEY(`pageId`, `bookmarkId`),
	FOREIGN KEY (`pageId`) REFERENCES `conceptPages`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`bookmarkId`) REFERENCES `bookmarks`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conceptPageSources_bookmarkId_idx` ON `conceptPageSources` (`bookmarkId`);--> statement-breakpoint
CREATE TABLE `conceptPages` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`anchorType` text NOT NULL,
	`anchorId` text NOT NULL,
	`title` text NOT NULL,
	`slug` text NOT NULL,
	`content` text DEFAULT '' NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`lastError` text,
	`sourceCount` integer DEFAULT 0 NOT NULL,
	`sourceContentHash` text,
	`compileVersion` integer DEFAULT 0 NOT NULL,
	`lastCompiledAt` integer,
	`modifiedAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `conceptPages_userId_status_idx` ON `conceptPages` (`userId`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `conceptPages_userId_anchorType_anchorId_unique` ON `conceptPages` (`userId`,`anchorType`,`anchorId`);--> statement-breakpoint
CREATE UNIQUE INDEX `conceptPages_userId_slug_unique` ON `conceptPages` (`userId`,`slug`);