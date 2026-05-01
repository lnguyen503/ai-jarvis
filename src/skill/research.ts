/**
 * Research skill — gather information from multiple angles and produce a
 * comprehensive report. This is the original /plan behavior (v1.8.0)
 * extracted into a skill definition.
 *
 * Good at: market research, technical topic deep-dives, comparative analysis,
 * "what's the state of the art on X" questions.
 */

import type { SkillDefinition } from './types.js';

const PLANNER_SYSTEM = `You are a task decomposer for a RESEARCH workflow. The user gives you a complex
topic to research. You break it into 3 to 8 concrete tasks that an AI agent
can execute one at a time using tools like web search, file read/write,
headless browsing, and shell commands.

Rules:
- Each task is a single declarative sentence (~10-20 words).
- Tasks run sequentially, each in an isolated context — so each task must
  stand on its own. The later task does NOT see the earlier task's tool
  results; it only sees files saved to the plan directory.
- Make tasks ATTACK DIFFERENT ANGLES of the topic (historical, quantitative,
  contrarian, stakeholder-specific, failure-cases, comparisons). Do not
  generate compounding tasks like "now look at X we found in task 1" —
  the downstream task won't have that context.
- The LAST task should gather and organize findings from the task data
  files, not do fresh research.
- Do NOT mention tool names, models, file paths, or implementation details.
- Do NOT number the tasks; the executor does that.
- Do NOT add any preamble, explanation, or trailing notes.

Output format: one task per line, nothing else. Example:

Research the overall market size and revenue trends for electric car washes in Southern California.
Investigate typical operating costs (labor, water, utilities, insurance) for a modern car wash facility.
Examine location and zoning regulations specific to Los Angeles and Orange County.
Analyze the competitive landscape and identify the top operators and their business models.
Review case studies of successful and failed car wash investments in the region.
Organize all findings into a comprehensive investment analysis report.`;

function buildResearchTaskBrief(plan: { planDir: string; goal: string; tasks: unknown[] }, task: { index: number; title: string }): string {
  return `[Research task ${task.index} of ${plan.tasks.length}]
Goal: ${plan.goal}
Your task: ${task.title}

Be thorough — this is research, not a chat reply:
- Run at least 2 search queries and browse at least 2 full sources; more if the topic warrants it. Vary angles, sources, time ranges.
- Extract specific facts: numbers, dates, names, quotes. Note contradictions and gaps; do not paper over uncertainty.
- Your task is not complete until you have written the extracted raw data to ${plan.planDir}/t${task.index}-data.md. The synthesizer downstream reads this file — an empty or missing file means the research is lost.

After writing the file, return a single paragraph summarizing what you did and the file path.`;
}

export const researchSkill: SkillDefinition = {
  name: 'research',
  label: 'Research',
  plannerSystemPrompt: PLANNER_SYSTEM,
  buildTaskBrief: buildResearchTaskBrief as SkillDefinition['buildTaskBrief'],
};
