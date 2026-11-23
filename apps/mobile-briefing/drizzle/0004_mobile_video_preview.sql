CREATE TABLE `preview_preparations` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`etag` text NOT NULL,
	`preset` text NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`bytes` integer,
	`preview_etag` text,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `preview_preparations_expiry` ON `preview_preparations` (`expires_at`);--> statement-breakpoint
CREATE INDEX `preview_preparations_queue` ON `preview_preparations` (`status`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `preview_preparations_revision` ON `preview_preparations` (`object_key`,`etag`,`preset`);--> statement-breakpoint
CREATE TABLE `preview_ranges` (
	`id` text PRIMARY KEY NOT NULL,
	`preview_id` text NOT NULL,
	`object_key` text NOT NULL,
	`etag` text NOT NULL,
	`preset` text NOT NULL,
	`preview_etag` text NOT NULL,
	`range_start` integer NOT NULL,
	`range_end` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`error` text
);
--> statement-breakpoint
CREATE INDEX `preview_ranges_expiry` ON `preview_ranges` (`expires_at`);--> statement-breakpoint
CREATE INDEX `preview_ranges_queue` ON `preview_ranges` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `assets_object_revision` ON `assets` (`run_id`,`object_key`,`etag`);