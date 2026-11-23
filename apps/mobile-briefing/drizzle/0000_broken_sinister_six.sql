CREATE TABLE `assets` (
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`content_id` text NOT NULL,
	`object_key` text NOT NULL,
	`role` text NOT NULL,
	`label` text NOT NULL,
	`file_name` text NOT NULL,
	`mime_type` text NOT NULL,
	`bytes` integer NOT NULL,
	`is_directory` integer NOT NULL,
	`available` integer NOT NULL,
	`item_count` integer,
	`etag` text NOT NULL,
	PRIMARY KEY(`run_id`, `id`),
	FOREIGN KEY (`run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `assets_content` ON `assets` (`run_id`,`content_id`);--> statement-breakpoint
CREATE TABLE `contents` (
	`run_id` text NOT NULL,
	`id` text NOT NULL,
	`title` text NOT NULL,
	`date` text NOT NULL,
	`date_basis` text NOT NULL,
	`stage` text NOT NULL,
	`next_action` text NOT NULL,
	`public_url` text NOT NULL,
	PRIMARY KEY(`run_id`, `id`),
	FOREIGN KEY (`run_id`) REFERENCES `sync_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `contents_stage` ON `contents` (`run_id`,`stage`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`latest_run_id` text,
	`heartbeat_at` text NOT NULL,
	`source_updated_at` text,
	`status` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`source_revision` text NOT NULL,
	`created_at` text NOT NULL,
	`status` text NOT NULL,
	`content_count` integer NOT NULL,
	`asset_count` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `media_requests` (
	`id` text PRIMARY KEY NOT NULL,
	`object_key` text NOT NULL,
	`etag` text NOT NULL,
	`range_start` integer NOT NULL,
	`range_end` integer NOT NULL,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`expires_at` text NOT NULL,
	`error` text
);
