/**
 * Tool: update_memory — append a fact to the speaker's per-user memory.
 *
 * The agent calls this when the user explicitly asks Jarvis to remember
 * something ("remember I prefer brief replies"), OR when the user gives
 * a behavioral correction worth retaining ("stop apologizing first").
 *
 * What flows in is filtered by src/memory/userMemoryPrivacy.ts before
 * landing on disk — phone numbers, SSNs, credit cards, emails, API
 * keys, health-specific terms, and other sensitive shapes are rejected
 * with a reason the agent can relay to the user.
 *
 * Per-user, not per-chat: a fact saved when Boss talks in DM is also
 * loaded when Boss talks in any group chat. Other users' memories are
 * not touched.
 */

import { z } from 'zod';
import path from 'node:path';
import type { Tool, ToolResult, ToolContext } from './types.js';
import { appendUserMemoryEntry, type MemoryCategory } from '../memory/userMemory.js';
import { filterMemoryFact } from '../memory/userMemoryPrivacy.js';

const CATEGORY_VALUES = ['profile', 'preferences', 'projects', 'people', 'avoid'] as const;

const UpdateMemoryInput = z.object({
  category: z.enum(CATEGORY_VALUES).describe(
    'Which section to add the fact under. ' +
      '"profile" = stable facts the user shared (role, languages, time zone, OS). ' +
      '"preferences" = how the user wants Jarvis to respond (length, tone, default model, formatting). ' +
      '"projects" = recurring work the user references (name, path, tech stack). ' +
      '"people" = names of people the user references repeatedly + their relationship (no contact info). ' +
      '"avoid" = behaviors Jarvis should NOT do (corrections the user has given).',
  ),
  fact: z
    .string()
    .min(3)
    .max(500)
    .describe(
      'A short declarative sentence to remember about the user. ' +
        'Good: "prefers brief replies", "uses Vim", "deploys to Cloud Run". ' +
        'BAD (will be rejected): phone numbers, addresses, emails, SSN, credit cards, ' +
        'passwords, API keys, health-specific terms (cancer/diabetes/etc.), salary or financial specifics. ' +
        'When in doubt, do not save it.',
    ),
});

type UpdateMemoryInputType = z.infer<typeof UpdateMemoryInput>;

export const updateMemoryTool: Tool<UpdateMemoryInputType> = {
  name: 'update_memory',
  description:
    'Add a fact to the user\'s persistent memory file. ' +
    'Call ONLY when the user explicitly asks you to remember something ' +
    '(e.g. "remember that I prefer brief replies") OR when they correct your behavior ' +
    'in a way that should persist across chats. ' +
    '\n\n' +
    'NEVER save: personal contact info (phone, address, SSN), credentials (passwords, API keys, tokens), ' +
    'health-specific information, financial specifics (salary, account numbers), ' +
    'or third-party private information. The privacy filter will reject these patterns ' +
    'and you will receive a refusal — relay the refusal reason to the user. ' +
    '\n\n' +
    'DO save: stated preferences, recurring projects, technical context, working style, ' +
    'tooling choices, time zone, language preferences, expertise level, ' +
    'relationships ("Kim is my sister" — name + role only, no contact info). ' +
    '\n\n' +
    'Each fact should be a single declarative sentence under 500 characters. ' +
    'Memory is per-user and persists across all chats the user appears in.',
  parameters: UpdateMemoryInput,

  async execute(input, ctx: ToolContext): Promise<ToolResult> {
    const log = ctx.logger.child({ component: 'tools.update_memory' });

    if (!ctx.userId || !Number.isFinite(ctx.userId)) {
      return {
        ok: false,
        output: 'Cannot update memory: speaker user id is not available for this turn. If this came from a scheduled task created before v1.10.0 or without an owner, recreate the task via `schedule` — the new task will carry your user id automatically.',
        error: { code: 'NO_USER_ID', message: 'ctx.userId missing' },
      };
    }

    // Privacy filter — reject sensitive patterns BEFORE touching disk.
    const filter = filterMemoryFact(input.fact);
    if (!filter.ok || !filter.fact) {
      log.info(
        { userId: ctx.userId, category: input.category, reason: filter.reason },
        'update_memory: privacy filter rejected fact',
      );
      // Audit-log the rejection so the user can see what we refused.
      ctx.memory.auditLog.insert({
        category: 'memory.write',
        actor_chat_id: ctx.chatId,
        actor_user_id: ctx.userId,
        session_id: ctx.sessionId,
        detail: { result: 'rejected', reason: filter.reason ?? 'unknown', factPreview: input.fact.slice(0, 80) },
      });
      return {
        ok: false,
        output: `Refused to save: ${filter.reason ?? 'unknown reason'}. Try rephrasing without sensitive details.`,
        error: { code: 'PRIVACY_FILTER_REJECTED', message: filter.reason ?? 'rejected' },
      };
    }

    const dataDir = path.resolve(ctx.config.memory?.dbPath
      ? path.dirname(ctx.config.memory.dbPath)
      : 'data');

    try {
      await appendUserMemoryEntry(
        ctx.userId,
        input.category as MemoryCategory,
        filter.fact,
        ctx.userName ?? `user ${ctx.userId}`,
        dataDir,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ userId: ctx.userId, err: msg }, 'update_memory: append failed');
      return {
        ok: false,
        output: `Failed to write memory: ${msg}`,
        error: { code: 'WRITE_FAILED', message: msg },
      };
    }

    ctx.memory.auditLog.insert({
      category: 'memory.write',
      actor_chat_id: ctx.chatId,
      actor_user_id: ctx.userId,
      session_id: ctx.sessionId,
      detail: { result: 'saved', category: input.category, factPreview: filter.fact.slice(0, 80) },
    });
    log.info(
      { userId: ctx.userId, category: input.category, factLen: filter.fact.length },
      'update_memory: saved',
    );
    return {
      ok: true,
      output: `Saved under ${input.category}: "${filter.fact}".`,
      data: { category: input.category, fact: filter.fact },
    };
  },
};
