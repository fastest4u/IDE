import fs from 'node:fs';
import path from 'node:path';
import type { AgentDefinition, AgentDefinitionInput, AgentMode, AgentPermission } from '@ide/protocol';
import { ProjectDetector } from '@ide/workspace-core';

const FULL_BUILD_PERMISSIONS: AgentPermission = {
  read: 'allow',
  edit: 'allow',
  write: 'allow',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'allow',
  task: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  applyPatch: 'allow',
  lsp: 'allow',
};

const PLANNING_PERMISSIONS: AgentPermission = {
  read: 'allow',
  edit: 'deny',
  write: 'deny',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'ask',
  task: 'allow',
  webfetch: 'allow',
  websearch: 'allow',
  applyPatch: 'deny',
  lsp: 'allow',
};

const READ_ONLY_PERMISSIONS: AgentPermission = {
  read: 'allow',
  edit: 'deny',
  write: 'deny',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'deny',
  task: 'deny',
  webfetch: 'deny',
  websearch: 'deny',
  applyPatch: 'deny',
  lsp: 'allow',
};

const REVIEW_PERMISSIONS: AgentPermission = {
  read: 'allow',
  edit: 'deny',
  write: 'deny',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'ask',
  task: 'allow',
  webfetch: 'ask',
  websearch: 'ask',
  applyPatch: 'deny',
  lsp: 'allow',
};

const BUILTIN_AGENTS: AgentDefinition[] = [
  {
    id: 'build',
    name: 'Build',
    description: 'Full-access coding agent — read, write, edit, run commands',
    mode: 'build',
    permissions: FULL_BUILD_PERMISSIONS,
    selectable: true,
  },
  {
    id: 'plan',
    name: 'Plan',
    description: 'Read-only agent — analyze code, plan changes, no edits',
    mode: 'plan',
    permissions: PLANNING_PERMISSIONS,
    selectable: true,
  },
  {
    id: 'explore',
    name: 'Explore',
    description: 'Fast codebase explorer — search, read, no changes',
    mode: 'explore',
    permissions: READ_ONLY_PERMISSIONS,
    selectable: true,
  },
  {
    id: 'product-manager',
    name: 'Product Manager',
    description: 'Turns requests into scope, requirements, user stories, and acceptance criteria',
    mode: 'plan',
    permissions: PLANNING_PERMISSIONS,
    temperature: 0.25,
    selectable: true,
  },
  {
    id: 'ui-designer',
    name: 'UI Designer',
    description: 'Designs user flows, layouts, component behavior, responsive states, and accessibility',
    mode: 'plan',
    permissions: PLANNING_PERMISSIONS,
    temperature: 0.35,
    selectable: true,
  },
  {
    id: 'frontend-developer',
    name: 'Frontend Developer',
    description: 'Builds React/Next/Vue UI, client state, forms, routing, and interaction details',
    mode: 'build',
    permissions: FULL_BUILD_PERMISSIONS,
    temperature: 0.2,
    selectable: true,
  },
  {
    id: 'backend-developer',
    name: 'Backend Developer',
    description: 'Builds API routes, auth/session flows, streaming, queues, and service integrations',
    mode: 'build',
    permissions: FULL_BUILD_PERMISSIONS,
    temperature: 0.2,
    selectable: true,
  },
  {
    id: 'database-engineer',
    name: 'Database Engineer',
    description: 'Designs schema, migrations, indexes, query plans, seed data, and data boundaries',
    mode: 'build',
    permissions: {
      ...FULL_BUILD_PERMISSIONS,
      bash: 'ask',
      applyPatch: 'ask',
    },
    temperature: 0.15,
    selectable: true,
  },
  {
    id: 'integration-engineer',
    name: 'Integration Engineer',
    description: 'Connects external APIs, files, browser automation, email, GitHub, Slack, and MCP tools',
    mode: 'build',
    permissions: {
      ...FULL_BUILD_PERMISSIONS,
      bash: 'ask',
      webfetch: 'ask',
      websearch: 'ask',
    },
    temperature: 0.2,
    selectable: true,
  },
  {
    id: 'reviewer',
    name: 'Reviewer',
    description: 'Reviews changes for bugs, regressions, security gaps, and missing validation',
    mode: 'plan',
    permissions: REVIEW_PERMISSIONS,
    temperature: 0.15,
    selectable: true,
  },
  {
    id: 'tester',
    name: 'Tester',
    description: 'Plans and runs unit, integration, e2e, acceptance, and regression validation',
    mode: 'build',
    permissions: {
      ...FULL_BUILD_PERMISSIONS,
      edit: 'ask',
      write: 'ask',
      applyPatch: 'ask',
    },
    temperature: 0.1,
    selectable: true,
  },
  {
    id: 'devops-engineer',
    name: 'DevOps Engineer',
    description: 'Handles Docker, env, CI/CD, deployment, monitoring, rate limits, and scaling checks',
    mode: 'build',
    permissions: {
      ...FULL_BUILD_PERMISSIONS,
      bash: 'ask',
      applyPatch: 'ask',
    },
    temperature: 0.15,
    selectable: true,
  },
  {
    id: 'security-engineer',
    name: 'Security Engineer',
    description: 'Audits auth, permissions, secrets, injection risks, data access, and dangerous actions',
    mode: 'plan',
    permissions: REVIEW_PERMISSIONS,
    temperature: 0.1,
    selectable: true,
  },
];

const DEFAULT_CUSTOM_AGENT_PERMISSIONS: AgentPermission = {
  read: 'allow',
  edit: 'ask',
  write: 'ask',
  glob: 'allow',
  grep: 'allow',
  list: 'allow',
  bash: 'ask',
  task: 'allow',
  webfetch: 'ask',
  websearch: 'ask',
  applyPatch: 'ask',
  lsp: 'allow',
};

export interface AgentLoaderOptions {
  workspaceRoot: string;
}

export class AgentLoader {
  private workspaceRoot: string;
  private detector: ProjectDetector;
  private cache: Map<string, string | null> = new Map();

  constructor(options: AgentLoaderOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.detector = new ProjectDetector({ workspaceRoot: options.workspaceRoot });
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
    this.detector.setWorkspaceRoot(root);
    this.cache.clear();
  }

  listAgents(): AgentDefinition[] {
    return [...BUILTIN_AGENTS, ...this.loadCustomAgents()];
  }

  getAgent(agentId: string): AgentDefinition | null {
    return this.listAgents().find((a) => a.id === agentId) ?? null;
  }

  getDefaultAgent(): AgentDefinition {
    return BUILTIN_AGENTS[0]; // build
  }

  getAgentPrompt(agent: AgentDefinition): string {
    const baseRules = [
      '# Agent rules',
      '- You have access to file, bash, grep, glob, and patch tools.',
      '- Batch independent tool calls together for speed.',
      '- When making changes, look at surrounding code to follow existing patterns.',
      '- After changes, run typecheck/lint to verify correctness.',
      '- Use the patch system — create patches that users can review before applying.',
    ].join('\n');

    const agentPrompts: Record<string, string> = {
      build: [
        'You are a Build agent — the primary coding agent with full access.',
        '',
        '## Capabilities',
        '- Read, write, and edit any file in the workspace',
        '- Run shell commands (build, test, lint)',
        '- Search code with glob and grep',
        '- Create and apply patches with user review',
        '- Spawn subagents (plan, explore) for complex multi-step work',
        '',
        '## Workflow',
        '1. Understand the request — read relevant files first',
        '2. Plan the change — what files need editing?',
        '3. Make edits — use Edit tool for targeted changes, Write for new files',
        '4. Verify — run typecheck/tests',
        '5. Report — summarize what was done and why',
        '',
        baseRules,
      ].join('\n'),
      plan: [
        'You are a Plan agent — analyze, design, and propose solutions.',
        'You can READ files, SEARCH code, and EXPLORE the codebase.',
        'You CANNOT edit, write, or run commands.',
        '',
        '## Capabilities',
        '- Read any file in the workspace',
        '- Search code with glob and grep',
        '- Propose detailed implementation plans',
        '- Identify potential issues, edge cases, and risks',
        '',
        '## When to use',
        '- User asks "how should I implement X?"',
        '- User wants to understand a complex codebase',
        '- Before making major changes, plan first',
        '- Code review and analysis',
        '',
        '## Output format',
        'Provide plans with:',
        '- Files to create/modify (with paths)',
        '- Functions/classes to add or change',
        '- Edge cases to handle',
        '- Risks and mitigations',
        '',
        baseRules,
      ].join('\n'),
      explore: [
        'You are an Explore agent — fast, read-only codebase search.',
        'You can READ and SEARCH, but CANNOT edit, write, or run commands.',
        '',
        '## Capabilities',
        '- Find files by glob pattern',
        '- Search code with regex patterns',
        '- Read file contents',
        '- Answer questions about codebase structure',
        '',
        '## When to use',
        '- Finding where a function/class is defined',
        '- Understanding project structure',
        '- Searching for patterns across the codebase',
        '- Quickly answering "what/where/how" questions',
        baseRules,
      ].join('\n'),
      'product-manager': [
        'You are a Product Manager agent for full-stack web applications.',
        'Convert ambiguous user requests into clear product scope, user stories, acceptance criteria, rollout risks, and explicit non-goals.',
        'Prefer small deliverable increments that can be implemented and verified in the current repository.',
        '',
        'Return concise sections: Requirements, User Flow, Acceptance Criteria, Risks, Next Build Slice.',
        '',
        baseRules,
      ].join('\n'),
      'ui-designer': [
        'You are a UI Designer agent for production web apps.',
        'Design dense, usable application screens with responsive behavior, accessibility states, interaction details, and component boundaries.',
        'Respect existing design language and avoid marketing-page patterns for operational tools.',
        '',
        'Return concise sections: Screen Structure, Components, States, Responsive Rules, Accessibility Checks.',
        '',
        baseRules,
      ].join('\n'),
      'frontend-developer': [
        'You are a Frontend Developer agent.',
        'Implement React, Next.js, Vue, or vanilla UI using the stack already present in the repository.',
        'Focus on component structure, state, forms, data fetching, routing, styling, accessibility, and stable responsive layouts.',
        '',
        'When editing, keep changes scoped and verify with the project typecheck or build command.',
        '',
        baseRules,
      ].join('\n'),
      'backend-developer': [
        'You are a Backend Developer agent.',
        'Implement API routes, validation, auth/session behavior, SSE/WebSocket streaming, background work, and service boundaries.',
        'Follow existing framework patterns and keep provider-specific logic out of shared packages.',
        '',
        'When editing, keep contracts explicit and verify with service typecheck or tests.',
        '',
        baseRules,
      ].join('\n'),
      'database-engineer': [
        'You are a Database Engineer agent.',
        'Design database schema, migrations, indexes, query access patterns, seed data, and data ownership boundaries.',
        'Call out transaction, locking, permission, and rollback risks before proposing writes.',
        '',
        'Return concise sections: Schema, Access Patterns, Migration Plan, Indexes, Data Risks.',
        '',
        baseRules,
      ].join('\n'),
      'integration-engineer': [
        'You are an Integration Engineer agent.',
        'Connect external APIs, filesystem tools, browser automation, email, GitHub, Slack, Google Drive, Notion, and MCP-style tool surfaces.',
        'Separate read-only tools from dangerous write actions and require approval for destructive or externally visible operations.',
        '',
        baseRules,
      ].join('\n'),
      reviewer: [
        'You are a Reviewer agent.',
        'Prioritize concrete bugs, regressions, security issues, missing validation, broken contracts, and unsafe assumptions.',
        'Lead with findings ordered by severity and include file references when available.',
        '',
        baseRules,
      ].join('\n'),
      tester: [
        'You are a Tester agent.',
        'Create and run focused validation for the current change: unit, integration, e2e, acceptance, and regression checks.',
        'Report exact commands, results, residual risks, and missing test coverage.',
        '',
        baseRules,
      ].join('\n'),
      'devops-engineer': [
        'You are a DevOps Engineer agent.',
        'Handle Docker, environment variables, CI/CD, deployment readiness, monitoring, logging, rate limits, caching, and scaling concerns.',
        'Treat secrets, destructive commands, deploys, and production-impacting actions as approval-gated.',
        '',
        baseRules,
      ].join('\n'),
      'security-engineer': [
        'You are a Security Engineer agent.',
        'Audit authentication, authorization, secrets, prompt/tool injection, data access, dependency risk, and dangerous actions.',
        'Separate confirmed issues from assumptions and recommend narrow mitigations.',
        '',
        baseRules,
      ].join('\n'),
    };

    const prompt = agent.prompt?.trim() || agentPrompts[agent.id] || agentPrompts.build;
    const stackCtx = this.detector.buildAgentContext();
    const projectRules = this.detector.generateAgentPrompt();

    return [prompt, stackCtx, projectRules].filter(Boolean).join('\n');
  }

  saveAgent(input: AgentDefinitionInput): AgentDefinition {
    if (!this.workspaceRoot) {
      throw new Error('Workspace root is required before saving agents');
    }

    const agent = this.normalizeAgentInput(input);
    if (BUILTIN_AGENTS.some((candidate) => candidate.id === agent.id)) {
      throw new Error(`Cannot overwrite built-in agent '${agent.id}'`);
    }

    const customAgents = this.loadCustomAgents();
    const nextAgents = [
      ...customAgents.filter((candidate) => candidate.id !== agent.id),
      agent,
    ].sort((left, right) => left.name.localeCompare(right.name));
    this.writeCustomAgents(nextAgents);
    this.cache.clear();
    return agent;
  }

  loadInstructions(agentId: string, relativePath?: string): string | null {
    const cacheKey = `instructions:${agentId}:${relativePath ?? 'root'}`;
    if (this.cache.has(cacheKey)) {
      return this.cache.get(cacheKey) ?? null;
    }

    // First check workspace root, then walk up from relativePath
    const searchRoots = relativePath
      ? [path.join(this.workspaceRoot, relativePath)]
      : [this.workspaceRoot];

    const allParts: string[] = [];
    for (const root of searchRoots) {
      let current = root;
      while (current.startsWith(this.workspaceRoot)) {
        for (const file of ['AGENTS.md', 'CLAUDE.md']) {
          const filePath = path.join(current, file);
          if (allParts.some((p) => p.includes(filePath))) continue; // dedupe
          try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const label = path.relative(this.workspaceRoot, current) || 'root';
            allParts.push(`\n<project-context source="${label}/${file}">\n${content.trim()}\n</project-context>`);
          } catch { /* file not found, continue walking up */ }
        }
        const parent = path.dirname(current);
        if (parent === current) break;
        current = parent;
      }
    }

    const result = allParts.length > 0 ? allParts.join('\n') : null;
    this.cache.set(cacheKey, result);
    return result;
  }

  ensureBootstrapInstructions(): string {
    const agentMdPath = path.join(this.workspaceRoot, 'AGENTS.md');
    try {
      fs.accessSync(agentMdPath);
      return agentMdPath;
    } catch {
      const content = this.generateSmartAGENTS();
      fs.writeFileSync(agentMdPath, content, 'utf-8');
      return agentMdPath;
    }
  }

  private normalizeAgentInput(input: AgentDefinitionInput): AgentDefinition {
    const name = input.name.trim();
    if (!name) {
      throw new Error('Agent name is required');
    }

    const id = (input.id?.trim() || slugifyAgentId(name)).toLowerCase();
    if (!/^[a-z0-9][a-z0-9-_]{1,63}$/.test(id)) {
      throw new Error('Agent id must use lowercase letters, numbers, dashes, or underscores');
    }

    const description = input.description.trim();
    if (!description) {
      throw new Error('Agent description is required');
    }

    return {
      id,
      name,
      description,
      mode: isAgentMode(input.mode) ? input.mode : 'plan',
      permissions: {
        ...DEFAULT_CUSTOM_AGENT_PERMISSIONS,
        ...(input.permissions ?? {}),
      },
      prompt: input.prompt?.trim() || undefined,
      temperature: typeof input.temperature === 'number' ? input.temperature : undefined,
      selectable: input.selectable ?? true,
    };
  }

  private loadCustomAgents(): AgentDefinition[] {
    try {
      const raw = fs.readFileSync(this.customAgentsPath(), 'utf-8');
      const parsed = JSON.parse(raw) as { agents?: AgentDefinition[] };
      return (parsed.agents ?? []).filter(isAgentDefinition);
    } catch {
      return [];
    }
  }

  private writeCustomAgents(agents: AgentDefinition[]): void {
    const filePath = this.customAgentsPath();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `${JSON.stringify({ agents }, null, 2)}\n`, 'utf-8');
  }

  private customAgentsPath(): string {
    return path.join(this.workspaceRoot, '.ide', 'agents.json');
  }

  private generateSmartAGENTS(): string {
    const parts: string[] = [`# Repository Instructions`];
    
    // Read package.json for commands
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf-8'));
      const scripts = pkg.scripts ?? {};
      const buildCmd = scripts.build ?? 'not found';
      const testCmd = scripts.test ?? 'not found';
      const lintCmd = scripts.lint ?? 'not found';
      const typecheckCmd = scripts.typecheck ?? (scripts['type-check'] ?? 'not found');
      const devCmd = scripts.dev ?? 'not found';
      
      // Find the actual command run
      const findDevCommand = (script: string): string => {
        if (!script) return script;
        // If it's a turbo command, extract the relevant part
        if (script.includes('turbo')) return script;
        return script;
      };
      
      parts.push('');
      parts.push('## Commands');
      parts.push(`- Install dependencies: \`${pkg.packageManager ?? 'npm'} install\``);
      parts.push(`- Dev server: \`${devCmd}\` → \`${findDevCommand(devCmd)}\``);
      parts.push(`- Build: \`${buildCmd}\``);
      parts.push(`- Test: \`${testCmd}\``);
      parts.push(`- Lint: \`${lintCmd}\``);
      parts.push(`- Typecheck: \`${typecheckCmd}\``);
      
      if (pkg.packageManager) {
        parts.push(`- Package manager: ${pkg.packageManager}`);
      }
      if (pkg.engines?.node) {
        parts.push(`- Node version: ${pkg.engines.node}`);
      }
    } catch {
      parts.push('', '## Commands', '- Check package.json for available scripts');
    }
    
    // Scan directory structure
    try {
      const rootDirs = fs.readdirSync(this.workspaceRoot, { withFileTypes: true })
        .filter((d) => d.isDirectory() && !d.name.startsWith('.') && d.name !== 'node_modules');
      
      const topDirs = rootDirs.map((d) => d.name);
      
      if (topDirs.includes('apps') || topDirs.includes('packages') || topDirs.includes('services')) {
        parts.push('');
        parts.push('## Architecture');
        
        for (const dir of ['apps', 'packages', 'services']) {
          if (topDirs.includes(dir)) {
            try {
              const subs = fs.readdirSync(path.join(this.workspaceRoot, dir), { withFileTypes: true })
                .filter((d) => d.isDirectory() && !d.name.startsWith('.'));
              const names = subs.map((d) => `${dir}/${d.name}`);
              parts.push(`- \`${dir}/\` — ${names.slice(0, 5).join(', ')}${names.length > 5 ? ` (+${names.length - 5} more)` : ''}`);
            } catch {
              parts.push(`- \`${dir}/\` — present`);
            }
          }
        }
        
        // Check for workspaces config
        try {
          const wsYaml = path.join(this.workspaceRoot, 'pnpm-workspace.yaml');
          if (fs.existsSync(wsYaml)) {
            const yaml = fs.readFileSync(wsYaml, 'utf-8');
            const globs = yaml.split('\n').filter((l) => l.includes('- ')).map((l) => l.trim());
            if (globs.length > 0) {
              parts.push(`- Workspace globs: ${globs.join(', ')}`);
            }
          }
        } catch { /* ignore */ }
      }
    } catch { /* ignore */ }
    
    // Check for existing instruction files
    const instructionFiles = ['CLAUDE.md', 'CONTRIBUTING.md', '.cursor/rules'];
    const found = instructionFiles.filter((f) => {
      try { fs.accessSync(path.join(this.workspaceRoot, f)); return true; } catch { return false; }
    });
    if (found.length > 0) {
      parts.push('');
      parts.push('## Existing Instructions');
      parts.push(`- Reference files: ${found.join(', ')}`);
    }
    
    parts.push('');
    parts.push('## Conventions');
    parts.push('- Follow existing patterns in the codebase when making changes');
    parts.push('- Keep changes focused and minimal');
    parts.push('- Run typecheck after changes before committing');
    parts.push('- Do not commit secrets, .env files, or generated files');
    
    return parts.join('\n');
  }
}

function slugifyAgentId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64) || `agent-${Date.now()}`;
}

function isAgentMode(value: unknown): value is AgentMode {
  return value === 'build' || value === 'plan' || value === 'explore';
}

function isAgentDefinition(value: unknown): value is AgentDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<AgentDefinition>;
  return (
    typeof candidate.id === 'string' &&
    typeof candidate.name === 'string' &&
    typeof candidate.description === 'string' &&
    isAgentMode(candidate.mode) &&
    !!candidate.permissions &&
    typeof candidate.permissions === 'object' &&
    !Array.isArray(candidate.permissions)
  );
}
