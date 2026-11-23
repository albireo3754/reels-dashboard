CREATE TABLE `instruction_events` (
	`id` text PRIMARY KEY NOT NULL,
	`instruction_id` text NOT NULL,
	`at` text NOT NULL,
	`actor` text NOT NULL,
	`from_status` text,
	`to_status` text NOT NULL,
	`note` text,
	FOREIGN KEY (`instruction_id`) REFERENCES `instructions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `instruction_events_instruction` ON `instruction_events` (`instruction_id`,`at`);--> statement-breakpoint
CREATE TABLE `instructions` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_id` text NOT NULL,
	`idempotency_key` text NOT NULL,
	`text` text NOT NULL,
	`target` text,
	`end_level` text,
	`status` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`claimed_at` text,
	`started_at` text,
	`finished_at` text,
	`expires_at` text NOT NULL,
	`session_name` text,
	`summary` text,
	`question` text,
	`error_code` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `instructions_owner_key` ON `instructions` (`owner_id`,`idempotency_key`);--> statement-breakpoint
CREATE INDEX `instructions_status` ON `instructions` (`status`,`created_at`);--> statement-breakpoint
CREATE INDEX `instructions_owner_created` ON `instructions` (`owner_id`,`created_at`);--> statement-breakpoint
ALTER TABLE `sources` ADD `instructions_ready` integer;--> statement-breakpoint
ALTER TABLE `sources` ADD `instructions_reason` text;--> statement-breakpoint
ALTER TABLE `sources` ADD `instructions_at` text;