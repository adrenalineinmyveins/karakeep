CREATE TABLE `widgetVersions` (
	`id` text PRIMARY KEY NOT NULL,
	`widgetId` text NOT NULL,
	`version` integer NOT NULL,
	`code` text NOT NULL,
	`manifest` text,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`widgetId`) REFERENCES `widgets`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `widgetVersions_widgetId_idx` ON `widgetVersions` (`widgetId`,`version`);--> statement-breakpoint
CREATE TABLE `widgets` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`manifest` text,
	`code` text NOT NULL,
	`status` text NOT NULL,
	`current_version` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `widgets_userId_idx` ON `widgets` (`userId`);--> statement-breakpoint
CREATE INDEX `widgets_userId_modifiedAt_idx` ON `widgets` (`userId`,`modifiedAt`);