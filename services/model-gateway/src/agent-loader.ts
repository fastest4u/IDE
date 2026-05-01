import { promises as fs } from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { AgentConfig, AgentPermissionSettings } from '@ide/protocol';

/**
 * Parse frontmatter from markdown content (simple YAML-like parser)
 */
function parseFrontmatter(content: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = content.match(/^---\s*\n([\s\S]*?)\n---\s*\n?([\s\S]*)$/);
  if (!match) {
    return { frontmatter: {}, body: content };
  }

  const lines = match[1].split('\n');
  const frontmatter: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let currentObj: Record<string, unknown> | null = null;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    // Object continuation (indented)
    if (trimmed.startsWith('  ') && currentKey && currentObj) {
      const [key, ...valueParts] = trimmed.trim().split(':');
      const value = valueParts.join(':').trim();
      if (key && value !== undefined) {
        currentObj[key] = parseValue(value);
      }
      continue;
    }

    // New key
    const colonIndex = trimmed.indexOf(':');
    if (colonIndex > 0) {
      const key = trimmed.slice(0, colonIndex).trim();
      const value = trimmed.slice(colonIndex + 1).trim();

      if (value === '') {
        // Might be an object start
        currentKey = key;
        currentObj = {};
        frontmatter[key] = currentObj;
      } else {
        frontmatter[key] = parseValue(value);
        currentKey = null;
        currentObj = null;
      }
    }
  }

  return { frontmatter, body: match[2].trim() };
}

function parseValue(value: string): string | number | boolean {
  const trimmed = value.trim();
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (trimmed === 'null' || trimmed === '~') return null as unknown as string;
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== '') return num;
  // Remove surrounding quotes
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parsePermissionConfig(value: unknown): AgentPermissionSettings | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  return value as AgentPermissionSettings;
}

/**
 * Load a single agent config from a markdown file
 * File name becomes the agent ID (e.g., review.md -> review)
 */
async function loadAgentFromFile(filePath: string): Promise<AgentConfig | null> {
  try {
    const content = await fs.readFile(filePath, 'utf8');
    const { frontmatter, body } = parseFrontmatter(content);

    const id = path.basename(filePath, '.md');
    const mode = frontmatter.mode as string;

    if (!mode || !['primary', 'subagent', 'hidden'].includes(mode)) {
      return null;
    }

    return {
      id,
      name: (frontmatter.name as string) || id,
      description: (frontmatter.description as string) || '',
      mode: mode as 'primary' | 'subagent' | 'hidden',
      model: frontmatter.model as string | undefined,
      prompt: body || undefined,
      temperature: frontmatter.temperature as number | undefined,
      maxTokens: frontmatter.maxTokens as number | undefined,
      permissions: parsePermissionConfig(frontmatter.permission || frontmatter.permissions),
      selectable: frontmatter.selectable !== false,
    };
  } catch {
    return null;
  }
}

/**
 * Load all agent configs from a directory
 */
async function loadAgentsFromDirectory(dirPath: string): Promise<Record<string, AgentConfig>> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    const agents: Record<string, AgentConfig> = {};

    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.md')) {
        const agent = await loadAgentFromFile(path.join(dirPath, entry.name));
        if (agent) {
          agents[agent.id] = agent;
        }
      }
    }

    return agents;
  } catch {
    return {};
  }
}

/**
 * Load agent configs from both global and project directories (OpenCode-style)
 * Project configs override global configs
 *
 * Search order for project agents:
 * 1. <workspaceRoot>/.agents/*.md
 * 2. <workspaceRoot>/.opencode/agents/*.md
 */
export async function loadAgentConfigs(workspaceRoot?: string): Promise<Record<string, AgentConfig>> {
  // Global agents: ~/.config/opencode/agents/
  const globalDir = path.join(os.homedir(), '.config', 'opencode', 'agents');

  // Project agents: prefer .agents/ then fallback to .opencode/agents/
  const projectDir = workspaceRoot
    ? (await dirExists(path.join(workspaceRoot, '.agents'))
        ? path.join(workspaceRoot, '.agents')
        : path.join(workspaceRoot, '.opencode', 'agents'))
    : null;

  const globalAgents = await loadAgentsFromDirectory(globalDir);
  const projectAgents = projectDir ? await loadAgentsFromDirectory(projectDir) : {};

  // Project overrides global
  return { ...globalAgents, ...projectAgents };
}

async function dirExists(dirPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(dirPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Load a specific agent by ID from any source (JSON settings or markdown files)
 */
export async function loadAgentById(
  id: string,
  settingsAgents?: Record<string, AgentConfig>,
  workspaceRoot?: string,
): Promise<AgentConfig | null> {
  // Check JSON settings first
  if (settingsAgents?.[id]) {
    return settingsAgents[id];
  }

  // Check markdown files
  const allAgents = await loadAgentConfigs(workspaceRoot);
  return allAgents[id] || null;
}
