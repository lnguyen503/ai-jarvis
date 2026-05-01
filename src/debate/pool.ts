/**
 * Debater pools — which Ollama Cloud models participate in a debate,
 * keyed by question type. Mirrors `src/router/task-classifier.ts` but
 * returns a list of models for multi-agent debate rather than a single
 * model for single-turn routing.
 *
 * Four debaters per topic (v1.12.1+): the original triple plus DeepSeek v4
 * as a heavyweight reasoner. Trade-off: ~33% more wall time per round and
 * one more message per exchange. The default exchangesPerRound (2) and
 * maxRounds (2) keeps total turns bounded (4 debaters × 2 exchanges × 2
 * rounds = 16 turns max for the whole debate, fits in the panel's 4000-char
 * expanded view with R6 truncation).
 */

export interface DebaterRoster {
  /** Human-readable topic label, shown to the user. */
  label: string;
  /** Model IDs (Ollama Cloud tags). Order affects who speaks first each round. */
  models: string[];
}

/**
 * DeepSeek v4 Flash — added v1.12.1 as a fourth debater across every roster.
 * The "Flash" variant is the only v4 on Ollama Cloud (the full deepseek-v4
 * is not hosted there). Listed LAST in each roster so the existing
 * topic-specialist openers still set the agenda; DeepSeek closes each
 * round's exchange and forces the others to defend their final stance.
 *
 * Same model already used for /organize triage (config.organize.reminders.triageModel);
 * shared dependency is fine — debates and reminder ticks don't run concurrently.
 */
const DEEPSEEK_V4 = 'deepseek-v4-flash';

const ROSTERS: Array<{
  keywords: RegExp;
  roster: DebaterRoster;
}> = [
  {
    keywords: /\b(review|security|audit|vulnerability|pentest|threat|risk|compliance)\b/i,
    roster: {
      label: 'security/audit',
      models: ['minimax-m2.7', 'glm-5.1', 'nemotron-3-super', DEEPSEEK_V4],
    },
  },
  {
    keywords: /\b(architect|architecture|design|plan|system|diagram|structure|schema)\b/i,
    roster: {
      label: 'architect/design',
      models: ['nemotron-3-super', 'glm-5.1', 'minimax-m2.7', DEEPSEEK_V4],
    },
  },
  {
    keywords: /\b(search|find|research|docs|documentation|lookup|explore|browse|discover)\b/i,
    roster: {
      label: 'search/research',
      models: ['gemma4:31b', 'glm-5.1', 'minimax-m2.7', DEEPSEEK_V4],
    },
  },
  {
    keywords: /\b(code|build|implement|fix|debug|refactor|write|create|develop|function|class|test)\b/i,
    roster: {
      label: 'code/implement',
      models: ['glm-5.1', 'minimax-m2.7', 'gemma4:31b', DEEPSEEK_V4],
    },
  },
];

const DEFAULT_ROSTER: DebaterRoster = {
  label: 'general',
  models: ['glm-5.1', 'minimax-m2.7', 'nemotron-3-super', DEEPSEEK_V4],
};

/** Pick a debater roster from the question text. First keyword match wins. */
export function pickRoster(question: string): DebaterRoster {
  for (const entry of ROSTERS) {
    if (entry.keywords.test(question)) return entry.roster;
  }
  return DEFAULT_ROSTER;
}
