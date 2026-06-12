import { resolveAgentModel } from './model-resolver.ts';
import fs from 'node:fs';
import path from 'node:path';

const AGENTS_DIR = fs.existsSync(path.join(process.cwd(), 'agents'))
  ? path.join(process.cwd(), 'agents')
  : path.join(process.env.HOME || '', '.pi', 'agent', 'agents');
const activeAgents = ['scout', 'planner', 'builder', 'critic', 'operator'];

const mockModels = [
  { provider: 'alibaba-cloud', id: 'qwen-flash', name: 'Qwen Flash', cost: { input: 0, output: 0 } },
  { provider: 'alibaba-cloud', id: 'qwen-max', name: 'Qwen Max', cost: { input: 0, output: 0 } },
  { provider: 'alibaba-cloud', id: 'deepseek-v4-pro', name: 'DeepSeek v4 pro', cost: { input: 0, output: 0 } },
  { provider: 'google', id: 'gemini-3.1-pro-preview', name: 'Gemini 3.1 Pro', cost: { input: 0.000002, output: 0.000012 } },
  { provider: 'openai-codex', id: 'gpt-5.5', name: 'GPT 5.5', cost: { input: 0.000005, output: 0.00003 } },
];
const mockRegistry = {
  getAvailable: () => mockModels,
  getAll: () => mockModels,
  hasConfiguredAuth: () => true,
};
const dispatchingModel = mockModels.find((m) => m.provider === 'openai-codex');

console.log('Testing subagent model associations against Pi-style registered providers...');

let hasClaude = false;
for (const agent of activeAgents) {
  const file = path.join(AGENTS_DIR, `${agent}.md`);
  const content = fs.readFileSync(file, 'utf8');
  const model = content.match(/^model:\s*(.+)$/m)?.[1]?.trim() || '(dispatch/default)';
  const tools = content.match(/^tools:\s*(.+)$/m)?.[1]?.trim() || '(unrestricted/default tools)';
  if (/claude|anthropic/i.test(model)) hasClaude = true;
  const resolved = model.startsWith('(') ? resolveAgentModel(undefined, mockRegistry, dispatchingModel) : resolveAgentModel(model, mockRegistry, dispatchingModel);
  console.log(`${agent.padEnd(9)} model=${model} resolved=${resolved?.modelKey || '(none)'} provider=${resolved?.provider || 'default'} tools=${tools}`);
}

const fallback = resolveAgentModel('definitely-not-registered', mockRegistry, dispatchingModel);
if (fallback?.modelKey !== 'openai-codex/gpt-5.5') {
  console.error(`ERROR: unregistered model did not inherit dispatching model, got ${fallback?.modelKey}`);
  process.exit(1);
}

const qwenMax = resolveAgentModel('qwen-max', mockRegistry, dispatchingModel);
if (qwenMax?.modelKey !== 'alibaba-cloud/qwen-max') {
  console.error(`ERROR: qwen-max alias did not resolve to alibaba-cloud/qwen-max, got ${qwenMax?.modelKey}`);
  process.exit(1);
}

if (hasClaude) {
  console.error('ERROR: active agent is linked to Claude/Anthropic');
  process.exit(1);
}

console.log('OK: qwen-max alias resolves, fallback inherits dispatching model, no active Claude/Anthropic agents.');
