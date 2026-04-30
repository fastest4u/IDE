export interface ShellSection {
  title: string;
  description: string;
}

export const shellSections: ShellSection[] = [
  { title: 'Explorer', description: 'Project tree, search, and workspace navigation' },
  { title: 'Editor', description: 'Monaco code surface, tabs, diagnostics, and diff review' },
  { title: 'AI', description: 'Chat, tasks, model routing status, and edit actions' },
  { title: 'Terminal', description: 'Command output, tests, builds, and logs' },
];
