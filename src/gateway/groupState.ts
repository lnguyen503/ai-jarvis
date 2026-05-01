/**
 * In-memory per-chat state for group activation (v1.7.13).
 *
 * Tracks three things, all per-chat, all ephemeral (reset on process
 * restart — same posture as /voice, /vision, /calendar, /debate):
 *
 *   1. "Bot last spoke to user X at time T" — drives the follow-up
 *      heuristic: a new message from X within the window is a conversational
 *      continuation and activates Jarvis without needing the keyword.
 *
 *   2. "Pending confirmation" — when the intent classifier is unsure, Jarvis
 *      asks "@X were you talking to me?" and stashes the original message
 *      here. X's next message (yes/no/addressed) resolves the pending state.
 *
 *   3. Per-chat rate-limit buckets for the classifier — caps how many
 *      non-keyword messages in a chat per minute trigger an LLM call. Prevents
 *      a chatty group from burning model quota on small-talk.
 *
 * All state is ephemeral by design. If someone cares about persistence later,
 * it lives next to /voice /vision /calendar /debate on the same TODO item.
 */

export interface BotSpokeRecord {
  /** Unix ms when Jarvis last replied in this chat. */
  at: number;
  /** Telegram user id of who the reply addressed (from the @Name prefix). */
  addressedUserId: number;
}

export interface PendingConfirmation {
  /** Who triggered the "were you asking me?" prompt. */
  userId: number;
  /** Their display name (first_name || username). */
  senderName: string;
  /** The original message text we'd run through the agent if confirmed. */
  userText: string;
  /** Whether the original was a voice message (so we know if we already echoed it). */
  wasVoice: boolean;
  /** Unix ms when this pending state expires and self-clears. */
  expiresAt: number;
}

// --- state stores (module-level Maps — no class needed for this) ---

const botSpoke = new Map<number, BotSpokeRecord>();
const pending = new Map<number, PendingConfirmation>();
const rateBuckets = new Map<number, number[]>(); // chatId -> list of Unix-ms call timestamps
const intentDisabledChats = new Set<number>();

// --- bot-spoke / follow-up ---

export function recordBotSpoke(chatId: number, addressedUserId: number, now = Date.now()): void {
  botSpoke.set(chatId, { at: now, addressedUserId });
}

export function getBotSpoke(chatId: number): BotSpokeRecord | undefined {
  return botSpoke.get(chatId);
}

/**
 * Is the current message a conversational follow-up?
 *
 * Rule: Jarvis replied to this same user within the configured window. Any
 * other user's message inside the window does NOT count — otherwise any
 * bystander chat in the same group would activate Jarvis.
 */
export function isFollowUpFromSameUser(
  chatId: number,
  senderUserId: number,
  windowSeconds: number,
  now = Date.now(),
): boolean {
  const rec = botSpoke.get(chatId);
  if (!rec) return false;
  if (rec.addressedUserId !== senderUserId) return false;
  return now - rec.at <= windowSeconds * 1000;
}

// --- pending confirmation ---

export function setPending(chatId: number, entry: PendingConfirmation): void {
  pending.set(chatId, entry);
}

export function getPending(chatId: number, now = Date.now()): PendingConfirmation | undefined {
  const entry = pending.get(chatId);
  if (!entry) return undefined;
  if (entry.expiresAt <= now) {
    pending.delete(chatId);
    return undefined;
  }
  return entry;
}

export function clearPending(chatId: number): void {
  pending.delete(chatId);
}

/**
 * Interpret a message as a yes/no response to a pending confirmation.
 * Only the user who triggered the confirmation can answer it.
 *
 * Returns:
 *   - 'yes'     : run the original stashed text through the agent
 *   - 'no'      : discard the pending state, stay silent
 *   - 'unclear' : not a yes/no shape; caller can decide (usually: treat the
 *                 new message through the normal gate and discard pending)
 *   - null      : no pending state OR the responder isn't the pending user
 */
export function interpretConfirmationResponse(
  chatId: number,
  senderUserId: number,
  text: string,
  now = Date.now(),
): 'yes' | 'no' | 'unclear' | null {
  const entry = getPending(chatId, now);
  if (!entry) return null;
  if (entry.userId !== senderUserId) return null;

  const t = text.trim().toLowerCase();
  // Explicit positives — short acks or the word "jarvis" in reply ("yes jarvis", "jarvis yes")
  if (
    /^(y|ye|yes|yep|yeah|yup|correct|affirmative|sure|do it|go ahead|please|ok|okay)\b/.test(t) ||
    /\bjarvis\b/.test(t)
  ) {
    return 'yes';
  }
  // Explicit negatives
  if (/^(n|no|nope|nah|not you|wasn'?t you|never mind|nvm)\b/.test(t)) {
    return 'no';
  }
  return 'unclear';
}

// --- classifier rate limiter ---

/**
 * Record one classifier call for this chat and return whether we're under
 * the cap. Call this IMMEDIATELY BEFORE invoking the classifier, not after —
 * if it returns false, skip the classifier and stay silent (treat as low
 * confidence).
 *
 * Sliding window: keeps timestamps from the last 60 seconds; caller passes
 * perMinute cap.
 */
export function tryRateLimit(
  chatId: number,
  perMinute: number,
  now = Date.now(),
): boolean {
  const bucket = rateBuckets.get(chatId) ?? [];
  const cutoff = now - 60_000;
  const recent = bucket.filter((t) => t > cutoff);
  if (recent.length >= perMinute) {
    rateBuckets.set(chatId, recent); // compact the bucket opportunistically
    return false;
  }
  recent.push(now);
  rateBuckets.set(chatId, recent);
  return true;
}

// --- per-chat /jarvis_intent toggle (default ON) ---

export function isIntentDetectionEnabledForChat(chatId: number): boolean {
  return !intentDisabledChats.has(chatId);
}

export function setIntentDetectionForChat(chatId: number, enabled: boolean): void {
  if (enabled) intentDisabledChats.delete(chatId);
  else intentDisabledChats.add(chatId);
}

// --- test-only resets ---

export function _resetGroupState(): void {
  botSpoke.clear();
  pending.clear();
  rateBuckets.clear();
  intentDisabledChats.clear();
}
