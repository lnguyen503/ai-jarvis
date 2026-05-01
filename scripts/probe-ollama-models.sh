#!/usr/bin/env bash
# Probe Ollama Cloud models for tool-calling capability + latency.
# One-shot diagnostic; call directly: bash scripts/probe-ollama-models.sh
set -uo pipefail

ENV_FILE="$(dirname "$0")/../.env"
if [[ -f "$ENV_FILE" ]]; then
  export $(grep -E '^OLLAMA_API_KEY=' "$ENV_FILE" | xargs -d '\n')
fi
: "${OLLAMA_API_KEY:?OLLAMA_API_KEY not set}"

URL="https://ollama.com/v1/chat/completions"

# Same tool-call shape the agent uses internally (delegate_to_specialist
# stand-in here). The probe asks for a single delegation; success = the
# model emits a structured tool_call rather than a plain reply.
TOOLS='[{"type":"function","function":{"name":"reverse_string","description":"Reverse a string","parameters":{"type":"object","properties":{"input":{"type":"string"}},"required":["input"]}}}]'

probe() {
  local model="$1"
  local start end ms
  start=$(date +%s)
  local body
  body=$(jq -n --arg model "$model" --argjson tools "$TOOLS" '{
    model: $model,
    messages: [
      {role:"system",content:"You are a function-calling assistant. Use the provided tool when asked."},
      {role:"user",content:"Reverse the string \"hello\". Use the reverse_string tool."}
    ],
    tools: $tools,
    max_tokens: 200
  }')
  local resp
  resp=$(curl -s -m 60 -w "\n%{http_code}" -X POST "$URL" \
    -H "Authorization: Bearer $OLLAMA_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$body")
  end=$(date +%s)
  ms=$(( (end - start) * 1000 ))
  local code="${resp##*$'\n'}"
  local data="${resp%$'\n'*}"
  if [[ "$code" != "200" ]]; then
    printf "%-30s HTTP %s  (%dms) %s\n" "$model" "$code" "$ms" "$(echo "$data" | head -c 100)"
    return
  fi
  # Did the model emit a tool_call?
  local has_tool reply_preview
  has_tool=$(echo "$data" | jq -r '.choices[0].message.tool_calls != null')
  reply_preview=$(echo "$data" | jq -r '.choices[0].message.content // ""' | head -c 80 | tr '\n' ' ')
  printf "%-30s OK  %5dms  tool=%s  reply='%s'\n" "$model" "$ms" "$has_tool" "$reply_preview"
}

# Candidates ordered by per-bot recommendation:
#   ai-tony       (engineering)  → qwen3-coder-next, devstral-small-2:24b
#   ai-natasha    (research)     → deepseek-v4-flash, gpt-oss:120b
#   ai-bruce      (analysis)     → nemotron-3-super, qwen3-next:80b
#   ai-jarvis     (orchestrator) → minimax-m2.7 (baseline; verify still works)
for model in \
  minimax-m2.7 \
  qwen3-coder-next \
  devstral-small-2:24b \
  deepseek-v4-flash \
  gpt-oss:120b \
  nemotron-3-super \
  qwen3-next:80b
do
  probe "$model"
done
