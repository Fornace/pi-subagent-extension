import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { resolveAgentModel } from './model-resolver.ts';
import fs from 'node:fs';
import path from 'node:path';

const AGENTS_DIR = fs.existsSync(path.join(process.cwd(), 'agents'))
  ? path.join(process.cwd(), 'agents')
  : path.join(process.env.HOME || '', '.pi', 'agent', 'agents');
const expected = {
  quick: ['mantice/fornace-flash', 'low'],
  scout: ['mantice/fornace-fast', 'low'],
  planner: ['mantice/fornace-reasoning', 'high'],
  researcher: ['mantice/fornace-reasoning', 'high'],
  builder: ['mantice/fornace-max', 'high'],
  critic: ['mantice/fornace-max', 'high'],
  operator: ['mantice/fornace-max', 'high'],
  'astra-debugger': ['mantice/fornace-astra', 'max'],
};
const mockModels = [...new Set(Object.values(expected).map(([model]) => model))].map((key) => {
  const [provider, id] = key.split('/');
  return { provider, id, name: id, cost: { input: 0, output: 0 } };
});
mockModels.push({ provider: 'openai-codex', id: 'dispatch-fixture', cost: { input: 0, output: 0 } });
const mockRegistry = { getAvailable: () => mockModels, getAll: () => mockModels, hasConfiguredAuth: () => true };
const dispatchingModel = mockModels.at(-1);

console.log('Testing Fornace agent routes against Pi-style registered providers...');
for (const [agent, [expectedModel, expectedThinking]] of Object.entries(expected)) {
  const content = fs.readFileSync(path.join(AGENTS_DIR, `${agent}.md`), 'utf8');
  const model = content.match(/^model:\s*(.+)$/m)?.[1]?.trim();
  const thinking = content.match(/^thinking:\s*(.+)$/m)?.[1]?.trim();
  const resolved = resolveAgentModel(model, mockRegistry, dispatchingModel);
  if (resolved?.modelKey !== expectedModel || thinking !== expectedThinking) {
    console.error(`ERROR: ${agent} expected ${expectedModel}:${expectedThinking}, got ${resolved?.modelKey}:${thinking}`);
    process.exit(1);
  }
  console.log(`${agent.padEnd(16)} ${resolved.modelKey}:${thinking}`);
}
for (const alias of ['fornace-flash', 'fornace-fast', 'fornace-reasoning', 'fornace-max', 'fornace-astra']) {
  const resolved = resolveAgentModel(alias, { getAvailable: () => [], getAll: () => [] }, dispatchingModel);
  if (resolved?.modelKey !== `mantice/${alias}`) {
    console.error(`ERROR: direct alias ${alias} resolved to ${resolved?.modelKey}`);
    process.exit(1);
  }
}
const inherited = resolveAgentModel(undefined, mockRegistry, dispatchingModel);
if (inherited?.modelKey !== 'openai-codex/dispatch-fixture' || inherited.frontierKey !== 'dispatching-agent') {
  console.error('ERROR: absent model did not inherit the dispatching model');
  process.exit(1);
}
if (resolveAgentModel('definitely-not-registered', mockRegistry, dispatchingModel) !== null) {
  console.error('ERROR: unknown explicit model inherited instead of failing closed');
  process.exit(1);
}
const skill = fs.readFileSync(path.join(process.cwd(), 'skills/fornace-model-routing/SKILL.md'), 'utf8');
for (const phrase of ['fornace-flash', 'fornace-fast', 'fornace-reasoning', 'fornace-max', 'fornace-astra', 'exact reproducer']) {
  if (!skill.includes(phrase)) {
    console.error(`ERROR: routing skill omits ${phrase}`);
    process.exit(1);
  }
}
const registeredTools = new Map();
const registeredCommands = new Map();
const listeners = new Map();
const extension = (await import('./index.ts')).default;
extension({
  events: new EventEmitter(),
  registerTool(tool) { registeredTools.set(tool.name, tool); },
  registerCommand(name, command) { registeredCommands.set(name, command); },
  on(name, handler) { listeners.set(name, handler); },
});
for (const name of ['subagent', 'agent_spawn', 'agent_steer', 'agent_interrupt', 'agent_status', 'agent_list', 'agent_wait', 'workspace_read']) {
  if (!registeredTools.has(name)) throw new Error(`Missing registered tool: ${name}`);
}
for (const name of ['subagent', 'agent_spawn']) {
  const joined = (registeredTools.get(name).promptGuidelines || []).join('\n');
  for (const phrase of ['fornace-flash', 'fornace-reasoning', 'fornace-max', 'fornace-astra', 'exact objective']) {
    if (!joined.includes(phrase)) throw new Error(`${name} guidance omits ${phrase}`);
  }
}
const thinkingEnum = registeredTools.get('agent_spawn').parameters.properties.thinkingLevel.anyOf
  || registeredTools.get('agent_spawn').parameters.properties.thinkingLevel.enum;
if (!JSON.stringify(thinkingEnum).includes('max')) throw new Error('Managed spawn omits max thinking');
if (!registeredCommands.has('agents') || !listeners.has('session_shutdown')) throw new Error('Extension lifecycle registration incomplete');
await assert.rejects(() => registeredTools.get('agent_spawn').execute(
  'fixture-call',
  { model: 'definitely-not-registered', task: 'must not spawn' },
  undefined,
  undefined,
  { cwd: process.cwd(), modelRegistry: mockRegistry, model: dispatchingModel },
), /No agent was spawned/);
console.log('OK: extension tools expose routing guidance, managed max-thinking selection, and pre-spawn failure.');
