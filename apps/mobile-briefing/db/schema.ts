import { sqliteTable, text, integer, primaryKey, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
export const sources = sqliteTable('sources', {
 id:text('id').primaryKey(), label:text('label').notNull(), latestRunId:text('latest_run_id'),
 heartbeatAt:text('heartbeat_at').notNull(), sourceUpdatedAt:text('source_updated_at'), status:text('status').notNull(),
 // Bridge readiness for mobile instructions, reported with the heartbeat (null when an older bridge never reported it).
 instructionsReady:integer('instructions_ready'), instructionsReason:text('instructions_reason'), instructionsAt:text('instructions_at'),
});
export const syncRuns=sqliteTable('sync_runs', {
 id:text('id').primaryKey(), sourceId:text('source_id').notNull().references(()=>sources.id),
 monitor:text('monitor'),sourceRevision:text('source_revision').notNull(), createdAt:text('created_at').notNull(), status:text('status').notNull(),
 contentCount:integer('content_count').notNull(), assetCount:integer('asset_count').notNull(),
});
export const contents=sqliteTable('contents',{
 runId:text('run_id').notNull().references(()=>syncRuns.id),id:text('id').notNull(), title:text('title').notNull(),
 progress:text('progress'),date:text('date').notNull(),dateBasis:text('date_basis').notNull(),stage:text('stage').notNull(),nextAction:text('next_action').notNull(),publicUrl:text('public_url').notNull(),publishingCopy:text('publishing_copy'),routeMap:text('route_map'),routeMapStatus:text('route_map_status'),
},t=>[primaryKey({columns:[t.runId,t.id]}),index('contents_stage').on(t.runId,t.stage)]);
export const assets=sqliteTable('assets',{
 runId:text('run_id').notNull().references(()=>syncRuns.id),id:text('id').notNull(),contentId:text('content_id').notNull(),
 objectKey:text('object_key').notNull(),role:text('role').notNull(),label:text('label').notNull(),fileName:text('file_name').notNull(),mimeType:text('mime_type').notNull(),
 bytes:integer('bytes').notNull(),isDirectory:integer('is_directory').notNull(),available:integer('available').notNull(),itemCount:integer('item_count'),etag:text('etag').notNull(),
},t=>[primaryKey({columns:[t.runId,t.id]}),index('assets_content').on(t.runId,t.contentId),index('assets_object_revision').on(t.runId,t.objectKey,t.etag)]);
export const transfers=sqliteTable('media_requests',{
 id:text('id').primaryKey(),objectKey:text('object_key').notNull(),etag:text('etag').notNull(),start:integer('range_start').notNull(),end:integer('range_end').notNull(),
 status:text('status').notNull(),createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),error:text('error'),
});
export const previewPreparations=sqliteTable('preview_preparations',{
 id:text('id').primaryKey(),objectKey:text('object_key').notNull(),etag:text('etag').notNull(),preset:text('preset').notNull(),
 status:text('status').notNull(),createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),
 bytes:integer('bytes'),previewEtag:text('preview_etag'),error:text('error'),
},t=>[
 index('preview_preparations_expiry').on(t.expiresAt),
 index('preview_preparations_queue').on(t.status,t.createdAt),
 uniqueIndex('preview_preparations_revision').on(t.objectKey,t.etag,t.preset),
]);
export const previewRanges=sqliteTable('preview_ranges',{
 id:text('id').primaryKey(),previewId:text('preview_id').notNull(),objectKey:text('object_key').notNull(),
 etag:text('etag').notNull(),preset:text('preset').notNull(),previewEtag:text('preview_etag').notNull(),
 start:integer('range_start').notNull(),end:integer('range_end').notNull(),
 status:text('status').notNull(),createdAt:text('created_at').notNull(),expiresAt:text('expires_at').notNull(),error:text('error'),
},t=>[
 index('preview_ranges_expiry').on(t.expiresAt),
 index('preview_ranges_queue').on(t.status,t.createdAt),
]);

// Mobile instructions. The text is the owner's own words and lives only in this table;
// API responses never include owner_id or idempotency_key.
export const instructions=sqliteTable('instructions',{
 id:text('id').primaryKey(),ownerId:text('owner_id').notNull(),idempotencyKey:text('idempotency_key').notNull(),
 text:text('text').notNull(),target:text('target'),endLevel:text('end_level'),status:text('status').notNull(),
 createdAt:text('created_at').notNull(),updatedAt:text('updated_at').notNull(),claimedAt:text('claimed_at'),startedAt:text('started_at'),finishedAt:text('finished_at'),expiresAt:text('expires_at').notNull(),
 sessionName:text('session_name'),summary:text('summary'),question:text('question'),errorCode:text('error_code'),
},t=>[uniqueIndex('instructions_owner_key').on(t.ownerId,t.idempotencyKey),index('instructions_status').on(t.status,t.createdAt),index('instructions_owner_created').on(t.ownerId,t.createdAt)]);
// One row per state change (created, claimed, every status change, cancel, expiry). Notes are fixed codes only.
export const instructionEvents=sqliteTable('instruction_events',{
 id:text('id').primaryKey(),instructionId:text('instruction_id').notNull().references(()=>instructions.id),at:text('at').notNull(),
 actor:text('actor').notNull(),fromStatus:text('from_status'),toStatus:text('to_status').notNull(),note:text('note'),
},t=>[index('instruction_events_instruction').on(t.instructionId,t.at)]);
