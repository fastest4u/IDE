export const desktopAppName = '@ide/desktop';

export const desktopShellBoundary = {
  reuseWebShell: true,
  webEntrypoint: 'apps/web/index.html',
  gatewayUrl: 'http://127.0.0.1:3001',
  preloadBoundary: 'service-layer-only',
} as const;
