export interface ShellSection {
  id: string;
  title: string;
  description: string;
}

export const shellSections: ShellSection[] = [
  {
    id: 'workspace',
    title: 'Workspace',
    description: 'Project files, symbols, search, and git context.',
  },
  {
    id: 'editor',
    title: 'Editor',
    description: 'Monaco editor surface with diagnostics, tabs, and diffs.',
  },
  {
    id: 'ai',
    title: 'AI',
    description: 'Provider-agnostic chat, patch generation, and tool execution.',
  },
  {
    id: 'terminal',
    title: 'Terminal',
    description: 'Streaming command output, tests, builds, and logs.',
  },
];
