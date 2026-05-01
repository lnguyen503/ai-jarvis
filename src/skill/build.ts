/**
 * Build skill — create a small app, feature, or script from a description.
 *
 * Good at: "build me a script that X", "add a feature that Y", "make a
 * small tool for Z". NOT good at: building production systems from scratch,
 * multi-service architectures, long-running multi-session builds. This
 * skill is a one-shot multi-step agent, not a full SDLC pipeline —
 * complex builds should still go through the full factory at
 * <factory-repo>.
 *
 * Output: a small working project (or patch on an existing one) saved
 * under the chat's plan directory, with a README describing what was built
 * and how to run it.
 */

import type { SkillDefinition } from './types.js';

const PLANNER_SYSTEM = `You are a task decomposer for a BUILD workflow. The user wants you to build
a small app, feature, or script. You break the request into 3 to 7 concrete
build tasks that an AI agent can execute one at a time using file write,
shell commands, web search for docs, and headless browsing.

Rules:
- Each task is a single declarative sentence (~10-20 words).
- Tasks run sequentially, each in an isolated context. Each task stands on
  its own; later tasks read files written by earlier tasks.
- The workflow has a natural shape:
    1. Clarify / research: look up necessary libraries, APIs, or patterns
       (skip if trivial)
    2. Design: sketch the structure in a design.md file (one-liner folder
       layout + entry points)
    3. Implement: write the code files (split into multiple tasks if the
       project has multiple modules)
    4. Verify: try to run/test what was built; capture the output
    5. Package: write a README describing what was built and how to use it
- Be SPECIFIC about what each task should produce. "Implement the backend"
  is too vague — prefer "Implement src/server.ts with the Express routes
  for /users and /orders". The planner has no knowledge of the code
  structure yet, so tasks can reference anticipated file paths.
- The LAST task is always a README-writing task that reads the files
  created by earlier tasks and documents the project.
- Do NOT mention tool names, models, or implementation details.
- Do NOT number the tasks; the executor does that.
- Do NOT add any preamble, explanation, or trailing notes.

Output format: one task per line, nothing else. Example:

Research the simplest approach to build a CLI tool that converts CSV to JSON in Node.js.
Write a design.md sketching the project structure, dependencies, and main entry point.
Implement index.js with argument parsing, file reading, CSV parsing, and JSON output.
Write a small test script that runs the tool on a sample CSV and verifies the output.
Run the test script and capture any errors; fix them if present.
Write README.md documenting what the tool does, how to install, and how to run.`;

function buildBuildTaskBrief(plan: { planDir: string; goal: string; tasks: unknown[] }, task: { index: number; title: string }): string {
  return `[Build task ${task.index} of ${plan.tasks.length}]
What we're building: ${plan.goal}
Your task: ${task.title}

Be concrete — this is engineering, not exploration:
- Write real, runnable code. No placeholder comments like "TODO: implement here".
- All files go under ${plan.planDir}/. The project lives there; use
  subdirectories (src/, tests/, etc.) if the project is nontrivial.
- Save a brief write-up of what you did — what you created, key decisions,
  what's left for the next task — to ${plan.planDir}/t${task.index}-build-notes.md.
  Later tasks and the final synthesizer read this file.
- If you test something and it fails, DON'T silently move on. Record the
  failure in your notes so the next task can address it.

After writing the file, return a single paragraph summarizing what you built,
key file paths, and any open issues.`;
}

export const buildSkill: SkillDefinition = {
  name: 'build',
  label: 'Build',
  plannerSystemPrompt: PLANNER_SYSTEM,
  buildTaskBrief: buildBuildTaskBrief as SkillDefinition['buildTaskBrief'],
  planWallTimeMs: 30 * 60 * 1000,    // 30 min — multi-file writes + tests + iteration
  perTaskWallTimeMs: 8 * 60 * 1000,  // 8 min — code-write tasks are slower than search
};
