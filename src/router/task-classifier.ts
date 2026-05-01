/**
 * Keyword-based task classifier.
 * Maps input keywords to provider/model pairs.
 *
 * Routing precedence (handled in model-router.ts, not here):
 *   1. Per-session pin (/model command)
 *   2. Keyword match (this file)
 *   3. Default (gemma4:31b)
 *
 * v1.22.21 — model names dropped the `:cloud` suffix. Ollama Cloud
 * /api/tags lists models WITHOUT that suffix; the prior names returned
 * HTTP 404 on every call, silently falling back to Claude (and quietly
 * billing the Anthropic account for what the user thought was Ollama work).
 */

export interface ClassificationResult {
  provider: string;
  model: string;
  reason: string;
}

/**
 * Keyword families → model mapping.
 * Models are defaults; overridable via config routing.models (future).
 */
const ROUTING_TABLE: Array<{
  keywords: RegExp;
  provider: string;
  model: string;
  label: string;
}> = [
  {
    keywords: /\b(review|security|audit|vulnerability|pentest|threat|risk|compliance)\b/i,
    provider: 'ollama-cloud',
    model: 'minimax-m2.7',
    label: 'security/audit',
  },
  {
    keywords: /\b(architect|architecture|design|plan|system|diagram|structure|schema|model)\b/i,
    provider: 'ollama-cloud',
    model: 'nemotron-3-super',
    label: 'architect/design',
  },
  {
    keywords: /\b(search|find|research|docs|documentation|lookup|explore|browse|discover)\b/i,
    provider: 'ollama-cloud',
    model: 'gemma4:31b',
    label: 'search/research',
  },
  {
    keywords: /\b(code|build|implement|fix|debug|refactor|write|create|develop|function|class|test)\b/i,
    provider: 'ollama-cloud',
    model: 'glm-5.1',
    label: 'code/implement',
  },
];

const DEFAULT: ClassificationResult = {
  provider: 'ollama-cloud',
  model: 'gemma4:31b', // v1.7.4 — switched from glm-5.1 per user request
  reason: 'default',
};

/**
 * Classify an input string and return the recommended provider/model.
 * Checks routing table in order — first match wins.
 */
export function classifyTask(input: string): ClassificationResult {
  for (const entry of ROUTING_TABLE) {
    if (entry.keywords.test(input)) {
      return {
        provider: entry.provider,
        model: entry.model,
        reason: `keyword-match:${entry.label}`,
      };
    }
  }
  return DEFAULT;
}
