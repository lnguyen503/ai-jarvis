#!/usr/bin/env node
// Probe Ollama Cloud models for tool-calling capability + latency.
// One-shot diagnostic; call: node scripts/probe-ollama-models.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(__dirname, '..', '.env');
if (fs.existsSync(envPath)) {
  for (const line of fs.readFileSync(envPath, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^OLLAMA_API_KEY=(.+)$/);
    if (m) process.env.OLLAMA_API_KEY = m[1];
  }
}
if (!process.env.OLLAMA_API_KEY) {
  console.error('OLLAMA_API_KEY not set');
  process.exit(1);
}

const URL = 'https://ollama.com/v1/chat/completions';
const TOOLS = [{
  type: 'function',
  function: {
    name: 'reverse_string',
    description: 'Reverse a string',
    parameters: {
      type: 'object',
      properties: { input: { type: 'string' } },
      required: ['input'],
    },
  },
}];

async function probe(model) {
  const body = {
    model,
    messages: [
      { role: 'system', content: 'You are a function-calling assistant. Use the provided tool when asked.' },
      { role: 'user', content: 'Reverse the string "hello". Use the reverse_string tool.' },
    ],
    tools: TOOLS,
    max_tokens: 200,
  };
  const start = Date.now();
  let resp, data, err;
  try {
    resp = await fetch(URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.OLLAMA_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    data = await resp.json();
  } catch (e) {
    err = e;
  }
  const ms = Date.now() - start;
  const padded = model.padEnd(28);
  if (err) {
    console.log(`${padded}  ERROR  ${ms}ms  ${err.name}: ${err.message}`);
    return;
  }
  if (!resp.ok) {
    console.log(`${padded}  HTTP ${resp.status}  ${ms}ms  ${(data?.error?.message ?? JSON.stringify(data)).slice(0, 80)}`);
    return;
  }
  const msg = data?.choices?.[0]?.message ?? {};
  const hasTool = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
  const reply = (msg.content ?? '').replace(/\s+/g, ' ').slice(0, 60);
  console.log(`${padded}  OK   ${String(ms).padStart(6)}ms  tool=${hasTool ? 'YES' : 'no '}  reply='${reply}'`);
}

const MODELS = [
  'minimax-m2.7',         // baseline (orchestrator)
  'qwen3-coder-next',     // ai-tony candidate
  'devstral-small-2:24b', // ai-tony fallback
  'deepseek-v4-flash',    // ai-natasha candidate
  'gpt-oss:120b',         // ai-natasha alt
  'nemotron-3-super',     // ai-bruce candidate
  'qwen3-next:80b',       // ai-bruce alt
];

for (const m of MODELS) {
  await probe(m);
}
