import type * as Monaco from 'monaco-editor';

export type MonacoWorkspaceDocuments = Record<string, string>;

type MonacoInstance = typeof Monaco;
type MonacoCompilerOptions = Monaco.languages.typescript.CompilerOptions;

const MONACO_TEXT_FILE_PATTERN = /\.(?:[cm]?[jt]sx?|json|css|html?|mdx?|ya?ml|bash|zsh|sh)$/i;
const MONACO_SPECIAL_FILE_NAMES = new Set([
  '.gitignore',
  '.npmrc',
  'package.json',
  'tsconfig.json',
  'tsconfig.base.json',
]);

interface ParsedTsConfig {
  compilerOptions?: Record<string, unknown>;
  extends?: string;
}

function normalizeWorkspacePath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const segments = normalized.split('/');
  const resolved: string[] = [];

  for (const segment of segments) {
    if (!segment || segment === '.') continue;
    if (segment === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(segment);
  }

  return resolved.join('/');
}

function dirname(filePath: string): string {
  const normalized = normalizeWorkspacePath(filePath);
  const index = normalized.lastIndexOf('/');
  return index === -1 ? '' : normalized.slice(0, index);
}

function joinWorkspacePath(basePath: string, relativePath: string): string {
  const prefix = basePath ? `${basePath}/${relativePath}` : relativePath;
  return normalizeWorkspacePath(prefix);
}

function joinAbsoluteWorkspacePath(workspaceRoot: string, relativePath: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = normalizeWorkspacePath(relativePath);
  return normalizedPath ? `${normalizedRoot}/${normalizedPath}` : normalizedRoot;
}

function resolveExtendedConfigPath(configPath: string, extendsValue: string): string | null {
  if (!extendsValue.startsWith('.')) {
    return null;
  }

  const baseDir = dirname(configPath);
  const candidate = joinWorkspacePath(baseDir, extendsValue.endsWith('.json') ? extendsValue : `${extendsValue}.json`);
  return candidate || null;
}

function parseTsConfigDocument(content: string): ParsedTsConfig | null {
  try {
    return JSON.parse(content) as ParsedTsConfig;
  } catch {
    return null;
  }
}

function findNearestTsConfigPath(activeFile: string, documents: MonacoWorkspaceDocuments): string | null {
  if (!activeFile) {
    return documents['tsconfig.json'] ? 'tsconfig.json' : documents['tsconfig.base.json'] ? 'tsconfig.base.json' : null;
  }

  const segments = normalizeWorkspacePath(activeFile).split('/').filter(Boolean);
  for (let depth = segments.length - 1; depth >= 0; depth -= 1) {
    const directory = segments.slice(0, depth).join('/');
    const candidate = directory ? `${directory}/tsconfig.json` : 'tsconfig.json';
    if (documents[candidate]) {
      return candidate;
    }
  }

  return documents['tsconfig.json'] ? 'tsconfig.json' : documents['tsconfig.base.json'] ? 'tsconfig.base.json' : null;
}

function buildTsConfigChain(entryConfigPath: string | null, documents: MonacoWorkspaceDocuments): Array<{ path: string; config: ParsedTsConfig }> {
  if (!entryConfigPath) {
    return [];
  }

  const chain: Array<{ path: string; config: ParsedTsConfig }> = [];
  const seen = new Set<string>();
  let currentPath: string | null = entryConfigPath;

  while (currentPath && !seen.has(currentPath)) {
    seen.add(currentPath);
    const content = documents[currentPath];
    if (!content) {
      break;
    }

    const parsed = parseTsConfigDocument(content);
    if (!parsed) {
      break;
    }

    chain.unshift({ path: currentPath, config: parsed });
    currentPath = typeof parsed.extends === 'string' ? resolveExtendedConfigPath(currentPath, parsed.extends) : null;
  }

  return chain;
}

function mergeCompilerOptions(chain: Array<{ path: string; config: ParsedTsConfig }>): { path: string | null; options: Record<string, unknown> } {
  let resolvedPath: string | null = null;
  let merged: Record<string, unknown> = {};
  let mergedPaths: Record<string, unknown> = {};

  for (const entry of chain) {
    const compilerOptions = entry.config.compilerOptions ?? {};
    resolvedPath = entry.path;
    merged = { ...merged, ...compilerOptions };

    if (compilerOptions.paths && typeof compilerOptions.paths === 'object' && !Array.isArray(compilerOptions.paths)) {
      mergedPaths = { ...mergedPaths, ...(compilerOptions.paths as Record<string, unknown>) };
    }
  }

  if (Object.keys(mergedPaths).length > 0) {
    merged.paths = mergedPaths;
  }

  return { path: resolvedPath, options: merged };
}

function resolveConfigBaseUrl(configPath: string | null, baseUrl: unknown): string | null {
  if (typeof baseUrl !== 'string') {
    return null;
  }

  const configDirectory = configPath ? dirname(configPath) : '';
  return joinWorkspacePath(configDirectory, baseUrl);
}

function mapScriptTarget(monaco: MonacoInstance, target: unknown): Monaco.languages.typescript.ScriptTarget {
  if (typeof target !== 'string') {
    return monaco.languages.typescript.ScriptTarget.Latest;
  }

  switch (target.toLowerCase()) {
    case 'es3':
      return monaco.languages.typescript.ScriptTarget.ES3;
    case 'es5':
      return monaco.languages.typescript.ScriptTarget.ES5;
    case 'es2015':
    case 'es6':
      return monaco.languages.typescript.ScriptTarget.ES2015;
    case 'es2016':
      return monaco.languages.typescript.ScriptTarget.ES2016;
    case 'es2017':
      return monaco.languages.typescript.ScriptTarget.ES2017;
    case 'es2018':
      return monaco.languages.typescript.ScriptTarget.ES2018;
    case 'es2019':
      return monaco.languages.typescript.ScriptTarget.ES2019;
    case 'es2020':
      return monaco.languages.typescript.ScriptTarget.ES2020;
    case 'es2021':
    case 'es2022':
    case 'esnext':
    default:
      return monaco.languages.typescript.ScriptTarget.Latest;
  }
}

function mapModuleKind(monaco: MonacoInstance, moduleKind: unknown): Monaco.languages.typescript.ModuleKind {
  if (typeof moduleKind !== 'string') {
    return monaco.languages.typescript.ModuleKind.ESNext;
  }

  switch (moduleKind.toLowerCase()) {
    case 'commonjs':
      return monaco.languages.typescript.ModuleKind.CommonJS;
    case 'amd':
      return monaco.languages.typescript.ModuleKind.AMD;
    case 'umd':
      return monaco.languages.typescript.ModuleKind.UMD;
    case 'system':
      return monaco.languages.typescript.ModuleKind.System;
    case 'esnext':
    default:
      return monaco.languages.typescript.ModuleKind.ESNext;
  }
}

function mapModuleResolution(monaco: MonacoInstance, resolution: unknown): Monaco.languages.typescript.ModuleResolutionKind {
  if (typeof resolution !== 'string') {
    return monaco.languages.typescript.ModuleResolutionKind.NodeJs;
  }

  switch (resolution.toLowerCase()) {
    case 'classic':
      return monaco.languages.typescript.ModuleResolutionKind.Classic;
    case 'node':
    case 'node10':
    case 'node16':
    case 'nodenext':
    case 'bundler':
    default:
      return monaco.languages.typescript.ModuleResolutionKind.NodeJs;
  }
}

function mapJsxEmit(monaco: MonacoInstance, jsx: unknown): Monaco.languages.typescript.JsxEmit {
  if (typeof jsx !== 'string') {
    return monaco.languages.typescript.JsxEmit.ReactJSX;
  }

  switch (jsx.toLowerCase()) {
    case 'preserve':
      return monaco.languages.typescript.JsxEmit.Preserve;
    case 'react':
      return monaco.languages.typescript.JsxEmit.React;
    case 'react-native':
      return monaco.languages.typescript.JsxEmit.ReactNative;
    case 'react-jsxdev':
      return monaco.languages.typescript.JsxEmit.ReactJSXDev;
    case 'react-jsx':
    default:
      return monaco.languages.typescript.JsxEmit.ReactJSX;
  }
}

function toPathsRecord(value: unknown): Record<string, string[]> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  const paths: Record<string, string[]> = {};
  for (const [key, entryValue] of Object.entries(value)) {
    if (!Array.isArray(entryValue)) {
      continue;
    }

    const entries = entryValue.filter((item): item is string => typeof item === 'string');
    if (entries.length > 0) {
      paths[key] = entries;
    }
  }

  return Object.keys(paths).length > 0 ? paths : undefined;
}

function getWorkspaceUriPrefix(workspaceRoot: string): string {
  return getMonacoModelPath(workspaceRoot, '');
}

export function isMonacoWorkspaceFile(filePath: string): boolean {
  const basename = filePath.split('/').pop() ?? filePath;
  return MONACO_SPECIAL_FILE_NAMES.has(basename) || MONACO_TEXT_FILE_PATTERN.test(filePath);
}

export function getMonacoModelPath(workspaceRoot: string, filePath: string): string {
  const normalizedRoot = workspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '');
  const normalizedPath = normalizeWorkspacePath(filePath);
  const joinedPath = normalizedPath ? `${normalizedRoot}/${normalizedPath}` : normalizedRoot;
  const uriPath = /^[A-Za-z]:/.test(joinedPath) ? `/${joinedPath}` : joinedPath;
  const encodedPath = uriPath
    .split('/')
    .map((segment, index) => {
      if (index === 0 && segment === '') return '';
      if (index === 1 && /^[A-Za-z]:$/.test(segment)) return segment;
      return encodeURIComponent(segment);
    })
    .join('/');
  return `file://${encodedPath}`;
}

export function getMonacoLanguage(filePath: string): string {
  if (filePath.endsWith('.tsx') || filePath.endsWith('.ts')) return 'typescript';
  if (filePath.endsWith('.jsx') || filePath.endsWith('.js') || filePath.endsWith('.mjs') || filePath.endsWith('.cjs')) return 'javascript';
  if (filePath.endsWith('.json')) return 'json';
  if (filePath.endsWith('.css')) return 'css';
  if (filePath.endsWith('.md') || filePath.endsWith('.mdx')) return 'markdown';
  if (filePath.endsWith('.html')) return 'html';
  if (filePath.endsWith('.yaml') || filePath.endsWith('.yml')) return 'yaml';
  return 'plaintext';
}

export function getMonacoCompilerOptions(
  monaco: MonacoInstance,
  workspaceRoot: string,
  activeFile: string,
  documents: MonacoWorkspaceDocuments,
): MonacoCompilerOptions {
  const entryConfigPath = findNearestTsConfigPath(activeFile, documents);
  const configChain = buildTsConfigChain(entryConfigPath, documents);
  const { path: resolvedConfigPath, options } = mergeCompilerOptions(configChain);
  const baseUrl = resolveConfigBaseUrl(resolvedConfigPath, options.baseUrl) ?? '';
  const resolvedBaseUrl = baseUrl ? joinAbsoluteWorkspacePath(workspaceRoot, baseUrl) : workspaceRoot;

  return {
    allowJs: true,
    allowNonTsExtensions: true,
    allowSyntheticDefaultImports: true,
    baseUrl: resolvedBaseUrl,
    esModuleInterop: options.esModuleInterop === undefined ? true : Boolean(options.esModuleInterop),
    forceConsistentCasingInFileNames: options.forceConsistentCasingInFileNames === undefined ? true : Boolean(options.forceConsistentCasingInFileNames),
    isolatedModules: options.isolatedModules === undefined ? true : Boolean(options.isolatedModules),
    jsx: mapJsxEmit(monaco, options.jsx),
    lib: Array.isArray(options.lib) ? options.lib.filter((item): item is string => typeof item === 'string') : ['es2022', 'dom'],
    module: mapModuleKind(monaco, options.module),
    moduleResolution: mapModuleResolution(monaco, options.moduleResolution),
    noEmit: true,
    paths: toPathsRecord(options.paths),
    resolveJsonModule: options.resolveJsonModule === undefined ? true : Boolean(options.resolveJsonModule),
    strict: options.strict === undefined ? true : Boolean(options.strict),
    target: mapScriptTarget(monaco, options.target),
  };
}

export function syncMonacoWorkspace(
  monaco: MonacoInstance,
  workspaceRoot: string,
  activeFile: string,
  documents: MonacoWorkspaceDocuments,
  preserveActiveContent: boolean,
): void {
  const compilerOptions = getMonacoCompilerOptions(monaco, workspaceRoot, activeFile, documents);

  monaco.languages.typescript.typescriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.javascriptDefaults.setEagerModelSync(true);
  monaco.languages.typescript.typescriptDefaults.setCompilerOptions(compilerOptions);
  monaco.languages.typescript.javascriptDefaults.setCompilerOptions(compilerOptions);

  const expectedModelPaths = new Set<string>();
  for (const [filePath, content] of Object.entries(documents)) {
    const modelPath = getMonacoModelPath(workspaceRoot, filePath);
    expectedModelPaths.add(modelPath);

    const uri = monaco.Uri.parse(modelPath);
    const language = getMonacoLanguage(filePath);
    const existingModel = monaco.editor.getModel(uri);

    if (!existingModel) {
      monaco.editor.createModel(content, language, uri);
      continue;
    }

    if (existingModel.getLanguageId() !== language) {
      monaco.editor.setModelLanguage(existingModel, language);
    }

    if (preserveActiveContent && filePath === activeFile) {
      continue;
    }

    if (existingModel.getValue() !== content) {
      existingModel.setValue(content);
    }
  }

  const workspaceUriPrefix = getWorkspaceUriPrefix(workspaceRoot);
  for (const model of monaco.editor.getModels()) {
    const modelPath = model.uri.toString();
    if (!modelPath.startsWith(workspaceUriPrefix)) {
      continue;
    }

    if (!expectedModelPaths.has(modelPath) && modelPath !== getMonacoModelPath(workspaceRoot, activeFile)) {
      model.dispose();
    }
  }
}
