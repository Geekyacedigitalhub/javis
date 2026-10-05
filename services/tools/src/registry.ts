import type { JavisToolDefinition } from "../../../packages/types/src/javis";

const tools = new Map<string, JavisToolDefinition>();

export function registerTool(tool: JavisToolDefinition) {
  if (tools.has(tool.name)) {
    throw new Error(`Tool already registered: ${tool.name}`);
  }

  tools.set(tool.name, tool);
}

export function getTool(name: string) {
  return tools.get(name);
}

export function listTools() {
  return [...tools.values()].map(({ execute: _execute, ...definition }) => definition);
}
