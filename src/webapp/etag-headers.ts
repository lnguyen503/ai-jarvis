/**
 * Wire-protocol constants for ETag / If-Match / conflict-resolution headers (v1.14.4 RA1).
 *
 * Single source of truth for all header names and code values used across:
 *   - items.read.ts   (ETAG_HEADER on GET /:id)
 *   - items.mutate.ts (all mutation handlers + 412 envelope)
 *   - items.shared.ts (readIfMatchHeader + readForceOverride helpers)
 *   - tests           (import for header sends and assertions)
 *
 * NOT co-located with src/organize/etag.ts because these are webapp wire-protocol
 * constants, not framework-agnostic ETag computation.
 */

/** Standard response/request ETag header name (RFC 7232). */
export const ETAG_HEADER = 'ETag';

/** Standard conditional-request header name (RFC 7232). */
export const IF_MATCH_HEADER = 'If-Match';

/** Custom request header for the Save Anyway / Delete Anyway escape hatch (v1.14.4 D5/R9). */
export const FORCE_OVERRIDE_HEADER = 'X-Force-Override';

/** Value that activates force-override when present in FORCE_OVERRIDE_HEADER. */
export const FORCE_OVERRIDE_VALUE = '1';

/** Error code returned in the 412 response body (matches existing envelope discipline). */
export const PRECONDITION_FAILED_CODE = 'PRECONDITION_FAILED';

/**
 * Audit-row field name for bypass-after-412 forensics (v1.14.4 R2).
 * Kept here so the audit emit and future audit-query path both reference the same source.
 */
export const AUDIT_FIELD_BYPASS_AFTER_412 = 'bypassAfter412';

/**
 * Audit category for new-item creation (v1.14.6 D7).
 * NOT debounced — every successful POST /api/webapp/items gets its own row.
 */
export const WEBAPP_ITEM_CREATE_CATEGORY = 'webapp.item_create';
