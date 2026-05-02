import fs from 'node:fs';
import path from 'node:path';

export interface ProjectInfo {
  languages: string[];
  frontend?: { framework: string; metaFramework?: string };
  backend?: { framework: string; runtime?: string };
  database?: { type: string; orm?: string };
  packageManager?: string;
  testing?: string[];
  monorepo?: boolean;
  deployment?: string[];
}

interface DependencyMap {
  [dep: string]: { category: string; name: string };
}

const FRONTEND_MAP: DependencyMap = {
  'react': { category: 'frontend', name: 'React' },
  'vue': { category: 'frontend', name: 'Vue' },
  '@angular/core': { category: 'frontend', name: 'Angular' },
  'svelte': { category: 'frontend', name: 'Svelte' },
  'solid-js': { category: 'frontend', name: 'SolidJS' },
  'preact': { category: 'frontend', name: 'Preact' },
  'lit': { category: 'frontend', name: 'Lit' },
  'astro': { category: 'frontend', name: 'Astro' },
};

const META_FRAMEWORK_MAP: DependencyMap = {
  'next': { category: 'meta', name: 'Next.js' },
  'nuxt': { category: 'meta', name: 'Nuxt' },
  '@remix-run/react': { category: 'meta', name: 'Remix' },
  'gatsby': { category: 'meta', name: 'Gatsby' },
  '@sveltejs/kit': { category: 'meta', name: 'SvelteKit' },
  'vite': { category: 'meta', name: 'Vite' },
  'webpack': { category: 'meta', name: 'Webpack' },
  'turbo': { category: 'meta', name: 'Turbo' },
  '@nx/devkit': { category: 'meta', name: 'Nx' },
  'lerna': { category: 'meta', name: 'Lerna' },
};

const BACKEND_MAP: DependencyMap = {
  'express': { category: 'backend', name: 'Express' },
  'fastify': { category: 'backend', name: 'Fastify' },
  '@nestjs/core': { category: 'backend', name: 'NestJS' },
  'koa': { category: 'backend', name: 'Koa' },
  'hapi': { category: 'backend', name: 'Hapi' },
  'fastapi': { category: 'backend', name: 'FastAPI' },
  'django': { category: 'backend', name: 'Django' },
  'flask': { category: 'backend', name: 'Flask' },
  'gin': { category: 'backend', name: 'Gin' },
  'echo': { category: 'backend', name: 'Echo' },
  'fiber': { category: 'backend', name: 'Fiber' },
  'spring-boot': { category: 'backend', name: 'Spring Boot' },
  'rails': { category: 'backend', name: 'Ruby on Rails' },
  'actix-web': { category: 'backend', name: 'Actix Web' },
  'axum': { category: 'backend', name: 'Axum' },
  'phoenix': { category: 'backend', name: 'Phoenix' },
};

const DATABASE_MAP: DependencyMap = {
  'pg': { category: 'database', name: 'PostgreSQL' },
  'postgres': { category: 'database', name: 'PostgreSQL' },
  'mysql2': { category: 'database', name: 'MySQL' },
  'mysql': { category: 'database', name: 'MySQL' },
  'mongodb': { category: 'database', name: 'MongoDB' },
  'mongoose': { category: 'database', name: 'MongoDB' },
  'sqlite3': { category: 'database', name: 'SQLite' },
  'better-sqlite3': { category: 'database', name: 'SQLite' },
  'redis': { category: 'database', name: 'Redis' },
  'ioredis': { category: 'database', name: 'Redis' },
  'mariadb': { category: 'database', name: 'MariaDB' },
  'mssql': { category: 'database', name: 'SQL Server' },
  'oracledb': { category: 'database', name: 'Oracle' },
  'elasticsearch': { category: 'database', name: 'Elasticsearch' },
  'dynamodb': { category: 'database', name: 'DynamoDB' },
  'firebase-admin': { category: 'database', name: 'Firebase' },
  'supabase': { category: 'database', name: 'Supabase' },
  'planetscale': { category: 'database', name: 'PlanetScale' },
  'neon': { category: 'database', name: 'Neon' },
  'turso': { category: 'database', name: 'Turso/LibSQL' },
};

const ORM_MAP: DependencyMap = {
  'prisma': { category: 'orm', name: 'Prisma' },
  'typeorm': { category: 'orm', name: 'TypeORM' },
  'drizzle-orm': { category: 'orm', name: 'Drizzle' },
  'sequelize': { category: 'orm', name: 'Sequelize' },
  'knex': { category: 'orm', name: 'Knex' },
  'sqlalchemy': { category: 'orm', name: 'SQLAlchemy' },
  'mikro-orm': { category: 'orm', name: 'MikroORM' },
  'mongoose': { category: 'orm', name: 'Mongoose' },
  'activerecord': { category: 'orm', name: 'ActiveRecord' },
  'eloquent': { category: 'orm', name: 'Eloquent' },
};

const TESTING_MAP: DependencyMap = {
  'jest': { category: 'testing', name: 'Jest' },
  'vitest': { category: 'testing', name: 'Vitest' },
  'mocha': { category: 'testing', name: 'Mocha' },
  'ava': { category: 'testing', name: 'AVA' },
  'playwright': { category: 'testing', name: 'Playwright' },
  'cypress': { category: 'testing', name: 'Cypress' },
  'puppeteer': { category: 'testing', name: 'Puppeteer' },
  'pytest': { category: 'testing', name: 'Pytest' },
  'unittest': { category: 'testing', name: 'unittest' },
  'go test': { category: 'testing', name: 'Go test' },
  'rspec': { category: 'testing', name: 'RSpec' },
  'junit': { category: 'testing', name: 'JUnit' },
  'cargo test': { category: 'testing', name: 'Cargo test' },
};

const PACKAGE_MANAGER_INDICATORS: Record<string, string> = {
  'pnpm-lock.yaml': 'pnpm',
  'package-lock.json': 'npm',
  'yarn.lock': 'yarn',
  'bun.lockb': 'bun',
  'bun.lock': 'bun',
  'poetry.lock': 'poetry',
  'Pipfile.lock': 'pipenv',
  'requirements.txt': 'pip',
  'Gemfile.lock': 'bundler',
  'Cargo.lock': 'cargo',
  'go.sum': 'go modules',
};

const LANGUAGE_INDICATORS: Record<string, string> = {
  'package.json': 'TypeScript/JavaScript',
  'tsconfig.json': 'TypeScript',
  'requirements.txt': 'Python',
  'pyproject.toml': 'Python',
  'setup.py': 'Python',
  'Pipfile': 'Python',
  'go.mod': 'Go',
  'Cargo.toml': 'Rust',
  'Gemfile': 'Ruby',
  'pom.xml': 'Java',
  'build.gradle': 'Java/Kotlin',
  'build.gradle.kts': 'Kotlin',
  'CMakeLists.txt': 'C/C++',
  'Makefile': 'C/Make',
  'composer.json': 'PHP',
  'mix.exs': 'Elixir',
  'deno.json': 'Deno',
  'deno.jsonc': 'Deno',
  'sst.config.ts': 'SST',
};

const DEPLOYMENT_INDICATORS: Record<string, string> = {
  'Dockerfile': 'Docker',
  'docker-compose.yml': 'Docker Compose',
  'docker-compose.yaml': 'Docker Compose',
  'fly.toml': 'Fly.io',
  'render.yaml': 'Render',
  'vercel.json': 'Vercel',
  'netlify.toml': 'Netlify',
  'Procfile': 'Heroku',
  '.github/workflows': 'GitHub Actions',
  'sst.config.ts': 'SST/AWS',
  'terraform': 'Terraform',
};

export interface ProjectDetectorOptions {
  workspaceRoot: string;
}

export class ProjectDetector {
  private workspaceRoot: string;
  private cache: ProjectInfo | null = null;

  constructor(options: ProjectDetectorOptions) {
    this.workspaceRoot = options.workspaceRoot;
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
    this.cache = null;
  }

  detect(): ProjectInfo {
    if (this.cache) return this.cache;

    const info: ProjectInfo = {
      languages: [],
    };

    // Detect languages
    for (const [file, lang] of Object.entries(LANGUAGE_INDICATORS)) {
      if (fs.existsSync(path.join(this.workspaceRoot, file))) {
        if (!info.languages.includes(lang)) {
          info.languages.push(lang);
        }
      }
    }

    // Parse package.json for JS/TS projects
    let deps: string[] = [];
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(this.workspaceRoot, 'package.json'), 'utf-8'));
      deps = [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ];
    } catch { /* no package.json */ }

    // Parse requirements.txt for Python
    let pythonDeps: string[] = [];
    try {
      const reqTxt = fs.readFileSync(path.join(this.workspaceRoot, 'requirements.txt'), 'utf-8');
      pythonDeps = reqTxt.split('\n')
        .filter((l) => !l.startsWith('#') && l.trim())
        .map((l) => l.split('==')[0].split('>=')[0].trim().toLowerCase());
    } catch { /* no requirements.txt */ }

    // Parse go.mod for Go
    let goDeps: string[] = [];
    try {
      const goMod = fs.readFileSync(path.join(this.workspaceRoot, 'go.mod'), 'utf-8');
      goDeps = goMod.split('\n')
        .filter((l) => l.trim().startsWith('require') || !l.startsWith('module') && !l.startsWith('go '))
        .map((l) => l.trim().split(' ')[0]?.toLowerCase() ?? '')
        .filter(Boolean);
    } catch { /* no go.mod */ }

    const allDeps = [...deps, ...pythonDeps, ...goDeps];

    // Detect frontend
    for (const dep of allDeps) {
      if (FRONTEND_MAP[dep]) {
        info.frontend = { framework: FRONTEND_MAP[dep].name };
        break;
      }
    }

    // Detect meta framework
    for (const dep of allDeps) {
      if (META_FRAMEWORK_MAP[dep]) {
        if (info.frontend) {
          info.frontend.metaFramework = META_FRAMEWORK_MAP[dep].name;
        }
        break;
      }
    }

    // Detect backend
    for (const dep of allDeps) {
      if (BACKEND_MAP[dep]) {
        const backend = BACKEND_MAP[dep];
        info.backend = { framework: backend.name };

        // Detect runtime for Python
        if (backend.name === 'FastAPI' || backend.name === 'Django' || backend.name === 'Flask') {
          info.backend.runtime = 'Python';
        } else if (backend.name === 'Spring Boot') {
          info.backend.runtime = 'Java';
        } else if (backend.name === 'Ruby on Rails') {
          info.backend.runtime = 'Ruby';
        } else if (backend.name === 'Gin' || backend.name === 'Echo' || backend.name === 'Fiber') {
          info.backend.runtime = 'Go';
        } else if (backend.name === 'Actix Web' || backend.name === 'Axum') {
          info.backend.runtime = 'Rust';
        } else {
          info.backend.runtime = 'Node.js';
        }
        break;
      }
    }

    // Detect database
    for (const dep of allDeps) {
      if (DATABASE_MAP[dep]) {
        if (!info.database) {
          info.database = { type: DATABASE_MAP[dep].name };
        }
      }
    }

    // Detect ORM
    for (const dep of allDeps) {
      if (ORM_MAP[dep]) {
        if (!info.database) {
          info.database = { type: 'SQL' };
        }
        info.database.orm = ORM_MAP[dep].name;
        break;
      }
    }

    // Detect package manager
    for (const [file, manager] of Object.entries(PACKAGE_MANAGER_INDICATORS)) {
      if (fs.existsSync(path.join(this.workspaceRoot, file))) {
        info.packageManager = manager;
        break;
      }
    }

    // Detect testing frameworks
    const testing: string[] = [];
    for (const dep of allDeps) {
      if (TESTING_MAP[dep] && !testing.includes(TESTING_MAP[dep].name)) {
        testing.push(TESTING_MAP[dep].name);
      }
    }
    if (testing.length > 0) info.testing = testing;

    // Detect deployment
    const deployment: string[] = [];
    for (const [file, name] of Object.entries(DEPLOYMENT_INDICATORS)) {
      if (fs.existsSync(path.join(this.workspaceRoot, file))) {
        deployment.push(name);
      }
    }
    if (deployment.length > 0) info.deployment = deployment;

    // Detect monorepo
    try {
      const wsYaml = fs.existsSync(path.join(this.workspaceRoot, 'pnpm-workspace.yaml'));
      const wsJson = fs.existsSync(path.join(this.workspaceRoot, 'lerna.json'));
      const nxJson = fs.existsSync(path.join(this.workspaceRoot, 'nx.json'));
      const turboJson = fs.existsSync(path.join(this.workspaceRoot, 'turbo.json'));
      info.monorepo = wsYaml || wsJson || nxJson || turboJson;
    } catch { /* ignore */ }

    this.cache = info;
    return info;
  }

  buildAgentContext(): string {
    const info = this.detect();
    const parts: string[] = [];

    parts.push('\n<project-stack>');

    if (info.languages.length > 0) {
      parts.push(`- Language: ${info.languages[0]}${info.languages.length > 1 ? ` (also: ${info.languages.slice(1).join(', ')})` : ''}`);
    }

    if (info.frontend) {
      parts.push(`- Frontend: ${info.frontend.framework}${info.frontend.metaFramework ? ` with ${info.frontend.metaFramework}` : ''}`);
    }

    if (info.backend) {
      parts.push(`- Backend: ${[info.backend.runtime, info.backend.framework].filter(Boolean).join(' / ')}`);
    }

    if (info.database) {
      parts.push(`- Database: ${info.database.type}${info.database.orm ? ` with ${info.database.orm}` : ''}`);
    }

    if (info.packageManager) {
      parts.push(`- Package manager: ${info.packageManager}`);
    }

    if (info.monorepo) {
      parts.push(`- Monorepo: yes`);
    }

    if (info.testing && info.testing.length > 0) {
      parts.push(`- Testing: ${info.testing.join(', ')}`);
    }

    if (info.deployment && info.deployment.length > 0) {
      parts.push(`- Deployment: ${info.deployment.join(', ')}`);
    }

    parts.push('</project-stack>');

    return parts.join('\n');
  }

  generateAgentPrompt(): string {
    const info = this.detect();
    const parts: string[] = [];

    if (info.frontend) {
      parts.push(`- This is a ${info.frontend.framework}${info.frontend.metaFramework ? ` + ${info.frontend.metaFramework}` : ''} frontend project.`);
    }
    if (info.backend) {
      parts.push(`- Use ${info.backend.runtime} / ${info.backend.framework} conventions for the backend.`);
    }
    if (info.database) {
      parts.push(`- This project uses ${info.database.type}${info.database.orm ? ` with ${info.database.orm} as ORM` : ''}. Follow its conventions for queries and migrations.`);
    }
    if (info.packageManager) {
      parts.push(`- Use \`${info.packageManager}\` for package management.`);
    }
    if (info.testing) {
      parts.push(`- Run tests with \`${info.testing[0]}\`.`);
    }
    if (info.monorepo) {
      parts.push(`- This is a monorepo. Respect package boundaries when making changes.`);
    }

    return parts.length > 0 ? ['', '## Project-specific rules', ...parts].join('\n') : '';
  }
}
