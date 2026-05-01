/**
 * @deprecated since v1.8.1 — use `src/messaging/adapter.ts` (for the type)
 *                             and `src/messaging/telegram.ts` (for the factory).
 *
 * This file is a thin re-export shim kept for one release so existing
 * imports don't break while we migrate consumers. New code MUST import
 * from `src/messaging/*` — the adapter interface is platform-neutral now
 * and the name `TelegramAdapter` is misleading.
 *
 * The `TelegramAdapter` type alias below is maintained for source-level
 * compatibility and intentionally equals `MessagingAdapter`. Remove in v1.9.
 */

export { createTelegramAdapter } from '../messaging/telegram.js';
export type { MessagingAdapter as TelegramAdapter } from '../messaging/adapter.js';
