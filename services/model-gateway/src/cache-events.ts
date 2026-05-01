export type CacheEventType =
  | 'settings.updated'
  | 'workspace.root.changed'
  | 'workspace.file.changed'
  | 'session.memory.changed'
  | 'patch.changed'
  | 'provider.status.changed';
