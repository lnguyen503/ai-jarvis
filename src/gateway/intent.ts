/**
 * Intent classifier for group activation (v1.7.13).
 *
 * Decides whether a group-chat message is addressed to Jarvis without
 * requiring the "jarvis" keyword or a reply-to-bot. Calls a cheap LLM
 * (defaults to a small Ollama Cloud model) with a strict-JSON prompt and a
 * short recent-message window for context.
 *
 * Used ONLY when the deterministic gate (keyword / reply-to-bot / follow-up
 * heuristic) didn't activate. High confidence → activate. Medium → Jarvis
 * replies with a confirmation prompt. Low → silent.
 *
 * Robustness: the classifier model is on the hook for returning valid JSON,
 * but we don't trust it — parseClassifierOutput handles code fences, strays,
 * and missing fields, and falls back to "low confidence, not addressed" if
 * nothing recognisable comes back.
 */

import type pino from 'pino';
import type { ModelProvider, UnifiedMessage } from '../providers/types.js';
import { stripThinkTags } from '../providers/adapters.js';
import { child } from '../logger/index.js';

const defaultLog = child({ component: 'gateway.intent' });

/** Max tokens the classifier is allowed to emit. JSON is ~50 tokens; extra room for reasoning models. */
const CLASSIFIER_MAX_TOKENS = 300;
/** Hard timeout on the classifier call. If the provider is slow, we'd rather stay silent than hang the chat. */
export const CLASSIFIER_TIMEOUT_MS = 10_000;

export type IntentConfidence = 'high' | 'medium' | 'low';

export interface IntentResult {
  addressed: boolean;
  confidence: IntentConfidence;
  reason: string;
}

export interface RecentMessage {
  /** Sender's display name, or "Jarvis" for bot replies. */
  from: string;
  /** Message body (plain text, not HTML). Already truncated by the caller. */
  text: string;
}

export interface ClassifyParams {
  /** The text under evaluation (plain text, already transcribed if voice). */
  text: string;
  /** Display name of the person who sent the current message. */
  senderName: string;
  /** Most recent chat history in oldest-first order. 3-6 messages is plenty. */
  recent: RecentMessage[];
  /** Whether Jarvis spoke recently in this chat — shifts the prior toward "addressed". */
  botSpokeRecently: boolean;
  provider: ModelProvider;
  model: string;
  abortSignal: AbortSignal;
  logger?: pino.Logger;
}

const SYSTEM_PROMPT = `You are a gatekeeper for a Telegram bot named Jarvis that lives in group chats. You decide whether a new message is ADDRESSED TO JARVIS (the bot) or TO OTHER HUMANS in the group.

You must output STRICT JSON only. No markdown, no code fences, no prose:
{"addressed": true|false, "confidence": "high"|"medium"|"low", "reason": "<=10 words"}

Signals that a message IS addressed to Jarvis (bot):
- Direct commands / imperatives a bot would execute ("search for X", "read my email", "what's on my calendar", "check the logs", "find...", "write a...")
- Technical / system / file / web questions
- Short conversational follow-up right after Jarvis just spoke ("yes do it", "thanks", "also...")
- Rhetorical-sounding questions about the user's own data (schedule, inbox, tasks)

Signals that a message is NOT addressed to Jarvis (human-to-human):
- Named address of a specific human ("Kim, did you...", "@alice ...")
- Social chat between members ("how was your weekend", "lol")
- Group logistics ("who's picking up the kids", "running late")
- Short reactions to a HUMAN'S prior message ("lol", "yep", "true") when the last speaker was a human, not Jarvis

Ties go to "not addressed, low confidence" — it is less bad to stay silent than to barge into a human conversation.`;

/** Wrap a promise in an abort-driven timeout so a stuck provider can't block the chat. */
function withTimeout<T>(p: Promise<T>, ms: number, abortSignal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`classifier timeout after ${ms}ms`)), ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('classifier aborted'));
    };
    abortSignal.addEventListener('abort', onAbort, { once: true });
    p.then(
      (v) => {
        clearTimeout(timer);
        abortSignal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        abortSignal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
  });
}

export async function classifyAddressedToBot(params: ClassifyParams): Promise<IntentResult> {
  const log = (params.logger ?? defaultLog).child({ sender: params.senderName });

  const historyBlock =
    params.recent.length === 0
      ? '(no recent messages in this chat)'
      : params.recent.map((m) => `${m.from}: ${m.text}`).join('\n');

  const priorLine = params.botSpokeRecently
    ? 'Jarvis spoke in this chat within the last 2 minutes, so conversational follow-ups are more likely to be addressed to Jarvis.'
    : 'Jarvis has not spoken recently; a fresh message without clear signals is less likely to be addressed to Jarvis.';

  const userMessage =
    `${priorLine}\n\n` +
    `## Recent chat (oldest first)\n${historyBlock}\n\n` +
    `## New message from ${params.senderName}\n${params.text}\n\n` +
    `Respond with the JSON object only.`;

  const messages: UnifiedMessage[] = [{ role: 'user', content: userMessage }];

  let raw: string;
  try {
    const res = await withTimeout(
      params.provider.call({
        model: params.model,
        system: SYSTEM_PROMPT,
        messages,
        tools: [],
        maxTokens: CLASSIFIER_MAX_TOKENS,
        abortSignal: params.abortSignal,
      }),
      CLASSIFIER_TIMEOUT_MS,
      params.abortSignal,
    );
    raw = stripThinkTags(res.content).trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn({ err: message }, 'Classifier call failed — defaulting to silent');
    return { addressed: false, confidence: 'low', reason: `classifier error: ${message}` };
  }

  const parsed = parseClassifierOutput(raw);
  log.info(
    { addressed: parsed.addressed, confidence: parsed.confidence, reason: parsed.reason },
    'Intent classified',
  );
  return parsed;
}

/**
 * Robust parser for the classifier's JSON output. Tolerates:
 *   - ```json fences
 *   - leading prose before the JSON ("Here's my answer: {...}")
 *   - missing fields (defaults to low-confidence not-addressed)
 *   - trailing commentary
 *
 * Exported for unit testing.
 */
export function parseClassifierOutput(raw: string): IntentResult {
  const def: IntentResult = { addressed: false, confidence: 'low', reason: 'unparseable' };
  if (!raw) return def;

  // Strip code fences if present.
  let cleaned = raw.replace(/```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();

  // Extract the first balanced-looking JSON object.
  const match = cleaned.match(/\{[\s\S]*\}/);
  if (!match) return def;
  cleaned = match[0];

  let obj: unknown;
  try {
    obj = JSON.parse(cleaned);
  } catch {
    return def;
  }
  if (!obj || typeof obj !== 'object') return def;
  const o = obj as Record<string, unknown>;

  const addressed = Boolean(o['addressed']);
  const confRaw = typeof o['confidence'] === 'string' ? (o['confidence'] as string).toLowerCase() : 'low';
  const confidence: IntentConfidence =
    confRaw === 'high' || confRaw === 'medium' || confRaw === 'low' ? confRaw : 'low';
  const reason = typeof o['reason'] === 'string' ? (o['reason'] as string).slice(0, 120) : '';

  return { addressed, confidence, reason };
}
