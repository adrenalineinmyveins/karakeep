CREATE TABLE `canvases` (
	`id` text PRIMARY KEY NOT NULL,
	`title` text DEFAULT '未命名画布' NOT NULL,
	`userId` text NOT NULL,
	`data` text,
	`createdAt` integer NOT NULL,
	`modifiedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `canvases_userId_idx` ON `canvases` (`userId`);--> statement-breakpoint
CREATE INDEX `canvases_userId_modifiedAt_idx` ON `canvases` (`userId`,`modifiedAt`);