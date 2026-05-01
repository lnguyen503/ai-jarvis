/**
 * System-prompt overlays for the gateway-decided activation mode (v1.23.0).
 *
 * The persona file is the bot's voice + scope description. The overlay is a
 * short, role-specific addendum that tells the model what its job IS for THIS
 * turn. The gateway decides which overlay applies based on observable state
 * (directive present? this bot named? activation reason?), so the model
 * never has to reason about its role from chat history.
 *
 * Why the overlay (not just persona changes): v1.22.x ran 200-line persona
 * prompts with §6/§7 rules ("no active task by default") that smaller models
 * (minimax-m2.7) couldn't follow consistently. Each rule was a target the
 * model had to attend to; under load it would lose them. The overlay is
 * tiny (≤30 lines), specific to the current turn, and PREPENDED so the model
 * sees the work definition before any persona voice text.
 *
 * Three modes:
 *   work          — bot is the named target of a user directive. Task text is
 *                   the directive slice. Bot must do the task and stop.
 *   banter        — bot was activated without a directive (collective alias,
 *                   incidental @-mention). Bot has no task; one short reply
 *                   in voice OR silence.
 *   orchestrator  — Jarvis's default. No overlay (persona prompt unchanged).
 */

export type ActivationMode = 'work' | 'banter' | 'orchestrator';

/**
 * Build the WORK-mode overlay. The directive task is wrapped in a structured
 * block so the model can find it deterministically; the rest is short prose
 * that explains what to do with it.
 */
export function buildWorkOverlay(directiveTask: string): string {
  // Trim + cap defensively. Directive parser caps at 1500, but if the gateway
  // ever passes through a longer slice, hard-truncate here.
  const task = directiveTask.trim().slice(0, 4000);
  return `# YOUR TASK FOR THIS TURN

The user has directed this task to you specifically. Do this and only this:

<your-task>
${task}
</your-task>

## Rules for this turn

- This task is the ENTIRE scope of your reply. Do not work on prior tasks from session history (those are already done).
- Lead with a one-sentence summary (≤120 chars). Then a blank line. Then the full work.
- Use markdown freely (tables, lists, code blocks render in the dashboard).
- If the task is outside your scope: say so plainly in one line and stop. Do not pretend to do it.
- If a peer bot is referenced for context you don't have ("Tony's hours", "the article"): say what you'd need rather than fabricating.
- One reply. No "standing by" / "on it" follow-ups. Silence after the reply IS the correct wrap.

You will be evaluated on whether your reply addresses <your-task>, not on staying in character. The voice is the seasoning; the work is the point.
`;
}

/**
 * Build the BANTER-mode overlay. No task; the bot was activated by collective
 * alias or incidental mention. Goal: keep replies SHORT and in-character, or
 * stay silent if the message isn't really for this bot.
 *
 * v1.23.4 — `sustained` parameter: when the user invited a back-and-forth
 * chain ("keep going", "take turns", "continue until I say stop"), the
 * overlay relaxes the "don't pass the ball" rule and explicitly invites
 * the bot to @-mention a peer to continue the round. Without this, the
 * bots reply once and stop — failing the user's explicit "keep going"
 * instruction. Detected by SUSTAINED_BANTER_REGEX in the gateway.
 */
export function buildBanterOverlay(sustained: boolean = false): string {
  if (sustained) {
    return `# CASUAL CHAIN — KEEP THE ROUND GOING

The user invited a back-and-forth ("keep going", "take turns", "continue until I say stop"). You're part of an N-bot ensemble; act like you're in a writers' room.

## Rules for this turn

- One short reply (1–3 sentences) IN VOICE. Then pass the ball.
- End with a plain @-mention of ONE peer bot (full username) so the next round goes to someone different than the prior speaker.
- Do NOT @-mention the same bot that just spoke — keep the round moving.
- Do NOT resume prior tasks from session history. The chain is its own context.
- Do NOT add acknowledgments or stage directions — go straight to your bit, then hand off.

The user will say "stop" / "drop it" / "enough" when they're done. Until then: short, in-voice, ball moves.
`;
  }
  return `# NO ACTIVE TASK

You were activated for this turn but the user did NOT direct a specific task to you. This is casual chat, banter, or a collective address ("Avengers", "team", "everyone").

## Rules for this turn

- One reply max. 1–2 sentences. In voice. Then silence.
- If you have nothing distinct to add (the question is squarely in another bot's lane), say nothing — return an empty reply. Better one good answer from the right bot than four redundant ones.
- Do NOT resume prior tasks from session history. Those are done.
- Do NOT @-mention other bots to "pass the conversation" — let the user drive.
- Do NOT post acknowledgments ("on it", "standing by", "copy", "noted").

The user will tell you when there's a task. Until then: brief or silent.
`;
}
