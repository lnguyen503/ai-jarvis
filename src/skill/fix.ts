/**
 * Fix skill — diagnose a bug, problem, or failure and produce a proposed
 * (or applied) fix with verification steps.
 *
 * Good at: "why is X broken", "logs show Y, what's wrong", "tests are failing",
 * "this command won't work", "something changed in the last N days and broke
 * something else".
 *
 * Defensive posture: the planner steers tasks toward INVESTIGATION first,
 * then diagnosis, then a proposed fix. The agent doesn't blindly rewrite
 * code — it gathers evidence, locates the bug, proposes or applies a change,
 * and verifies. The final synthesized report is a root-cause write-up +
 * the fix applied (or proposed) + how to verify.
 */

import type { SkillDefinition } from './types.js';

const PLANNER_SYSTEM = `You are a task decomposer for a FIX workflow. The user reports a bug,
problem, or system issue. You break it into 3 to 7 concrete diagnosis-and-repair
tasks that an AI agent can execute one at a time using tools like file read/write,
shell commands, log tailing, and web search.

Rules:
- Each task is a single declarative sentence (~10-20 words).
- Tasks run sequentially, each in an isolated context. Each task stands on
  its own; later tasks read files saved by earlier tasks.
- The workflow has a natural shape:
    1. Gather current state (read logs, read relevant source files, note symptoms)
    2. Reproduce or verify the issue if possible
    3. Identify the root cause with evidence (cite specific files/lines)
    4. Propose a fix, or apply a small change if confident
    5. Verify the fix (re-run tests, re-check the symptom)
  Most fix plans will have 4-6 tasks covering these phases.
- Be cautious about applying fixes in early tasks. Investigate thoroughly
  before changing code. A task that says "apply the fix" should come AFTER
  a task that says "identify the root cause".
- Do NOT mention tool names, models, file paths, or implementation details.
- Do NOT number the tasks; the executor does that.
- Do NOT add any preamble, explanation, or trailing notes.

Output format: one task per line, nothing else. Example:

Read the recent error logs and identify the exact error messages and timestamps.
Locate the source files referenced in the stack trace and note the relevant code sections.
Verify whether the issue reproduces by running the failing command or test.
Determine the root cause by cross-referencing the logs with the code.
Propose a minimal code change that addresses the root cause without introducing regressions.
Verify the proposed fix by re-running the failing test and confirming the symptom is gone.`;

function buildFixTaskBrief(plan: { planDir: string; goal: string; tasks: unknown[] }, task: { index: number; title: string }): string {
  return `[Fix task ${task.index} of ${plan.tasks.length}]
Reported issue: ${plan.goal}
Your task: ${task.title}

Be rigorous — this is diagnosis, not a quick guess:
- Read before writing. Cite specific files and lines when you claim a cause.
- Do not make speculative edits. If you apply a change, it should be minimal,
  targeted, and justified by earlier task findings.
- Save your raw evidence (log excerpts, file contents, test output, diffs)
  to ${plan.planDir}/t${task.index}-evidence.md. The synthesizer downstream
  reads this file to compose the root-cause write-up — missing file means
  the evidence is lost.

After writing the file, return a single paragraph summarizing what you found
and the file path. If you applied a code change, include the file path of the
change and the change itself in 1-2 sentences.`;
}

export const fixSkill: SkillDefinition = {
  name: 'fix',
  label: 'Fix',
  plannerSystemPrompt: PLANNER_SYSTEM,
  buildTaskBrief: buildFixTaskBrief as SkillDefinition['buildTaskBrief'],
  planWallTimeMs: 20 * 60 * 1000,    // 20 min — investigation + repair takes longer than research
  perTaskWallTimeMs: 5 * 60 * 1000,  // 5 min — same as research
};
