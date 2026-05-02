import fs from 'node:fs';
import path from 'node:path';

export interface ObsidianNote {
  /** Relative path from workspace root */
  path: string;
  /** File name without extension */
  title: string;
  /** Frontmatter tags */
  tags: string[];
  /** Frontmatter aliases */
  aliases: string[];
  /** First 500 chars as preview */
  excerpt: string;
  /** Full content (trimmed) */
  content: string;
  /** Last modified timestamp */
  updatedAt: string;
  /** Links to other notes ([[wikilinks]]) */
  links: string[];
  /** Category from directory structure */
  category: string;
}

export interface ObsidianKBQuery {
  /** Search terms */
  query: string;
  /** Filter by tags */
  tags?: string[];
  /** Filter by category (directory) */
  category?: string;
  /** Max results */
  limit?: number;
}

export interface ObsidianKBOptions {
  workspaceRoot: string;
  /** Directories to exclude from scanning */
  excludeDirs?: string[];
  /** File patterns to include */
  includePatterns?: string[];
}

export class ObsidianKnowledgeBase {
  private workspaceRoot: string;
  private notes: Map<string, ObsidianNote> = new Map();
  private indexBuilt = false;
  private readonly excludeDirs: string[];
  private readonly includePatterns: string[];

  constructor(options: ObsidianKBOptions) {
    this.workspaceRoot = options.workspaceRoot;
    this.excludeDirs = options.excludeDirs ?? [
      '.obsidian', '.git', 'node_modules', '.turbo', 'dist', 'build',
      '.next', 'coverage', '__pycache__', '.DS_Store',
    ];
    this.includePatterns = options.includePatterns ?? ['.md', '.mdx'];
  }

  setWorkspaceRoot(root: string): void {
    this.workspaceRoot = root;
    this.notes.clear();
    this.indexBuilt = false;
  }

  async buildIndex(): Promise<number> {
    this.notes.clear();
    await this.scanDirectory(this.workspaceRoot);
    this.indexBuilt = true;
    return this.notes.size;
  }

  private async scanDirectory(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (!this.shouldIncludeEntry(entry)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await this.scanDirectory(fullPath);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (this.includePatterns.includes(ext)) {
          try {
            const note = this.parseNote(fullPath);
            if (note) {
              this.notes.set(note.path, note);
            }
          } catch {
            // skip unreadable files
          }
        }
      }
    }
  }

  private shouldIncludeEntry(entry: fs.Dirent): boolean {
    if (entry.name.startsWith('.')) {
      // Allow .md files that start with dot, but exclude known dirs
      return entry.isFile() && this.includePatterns.some((p) => entry.name.endsWith(p));
    }
    if (entry.isDirectory() && this.excludeDirs.includes(entry.name)) return false;
    return true;
  }

  private parseNote(fullPath: string): ObsidianNote | null {
    const raw = fs.readFileSync(fullPath, 'utf-8');
    const relativePath = path.relative(this.workspaceRoot, fullPath);
    const name = path.basename(fullPath, path.extname(fullPath));
    const category = path.dirname(relativePath) || 'root';

    const { frontmatter, content } = this.parseFrontmatter(raw);
    const tags = frontmatter.tags ?? [];
    const aliases = frontmatter.aliases ?? [];
    const title = (frontmatter.title as string) || name;

    // Extract excerpt (first 500 chars after frontmatter, skip headings)
    const excerpt = content
      .replace(/^#.*$/gm, '') // remove headings
      .replace(/\n{3,}/g, '\n\n') // collapse whitespace
      .trim()
      .slice(0, 500);

    // Extract wikilinks: [[link]] or [[link|alias]]
    const linkRegex = /\[\[([^\]|#]+)(?:[|#][^\]]+)?\]\]/g;
    const links: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = linkRegex.exec(content)) !== null) {
      links.push(match[1].trim());
    }

    let stat: fs.Stats;
    try {
      stat = fs.statSync(fullPath);
    } catch {
      stat = { mtime: new Date() } as fs.Stats;
    }

    return {
      path: relativePath,
      title: String(title),
      tags: Array.isArray(tags) ? tags.map(String) : [String(tags)],
      aliases: Array.isArray(aliases) ? aliases.map(String) : [],
      excerpt,
      content: content.slice(0, 10000), // cap at 10K chars
      updatedAt: stat.mtime.toISOString(),
      links,
      category,
    };
  }

  private parseFrontmatter(raw: string): { frontmatter: Record<string, unknown>; content: string } {
    const trimmed = raw.trimStart();
    if (!trimmed.startsWith('---')) {
      return { frontmatter: {}, content: raw };
    }

    const endIdx = trimmed.indexOf('---', 3);
    if (endIdx === -1) {
      return { frontmatter: {}, content: raw };
    }

    const yamlBlock = trimmed.slice(3, endIdx).trim();
    const content = trimmed.slice(endIdx + 3).trim();
    const frontmatter: Record<string, unknown> = {};

    // Simple YAML-like parser for frontmatter
    for (const line of yamlBlock.split('\n')) {
      const colonIdx = line.indexOf(':');
      if (colonIdx === -1) continue;
      const key = line.slice(0, colonIdx).trim();
      let value = line.slice(colonIdx + 1).trim();

      // Parse arrays: [a, b, c]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1);
        frontmatter[key] = value.split(',').map((v) => v.trim().replace(/^["']|["']$/g, ''));
      }
      // Parse quoted strings
      else if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        frontmatter[key] = value.slice(1, -1);
      }
      // Parse lists (lines starting with -)
      else if (value === '') {
        frontmatter[key] = [];
      }
      else {
        frontmatter[key] = value;
      }
    }

    // Handle YAML list items (lines starting with -)
    const listItems: Record<string, string[]> = {};
    let currentListKey = '';
    for (const line of yamlBlock.split('\n')) {
      const trimmed = line.trim();
      if (trimmed.startsWith('- ')) {
        if (currentListKey) {
          if (!listItems[currentListKey]) listItems[currentListKey] = [];
          listItems[currentListKey].push(trimmed.slice(2).trim().replace(/^["']|["']$/g, ''));
        }
      } else {
        const colonIdx = line.indexOf(':');
        if (colonIdx !== -1) {
          currentListKey = line.slice(0, colonIdx).trim();
        }
      }
    }

    for (const [key, items] of Object.entries(listItems)) {
      if (items.length > 0) {
        frontmatter[key] = items;
      }
    }

    return { frontmatter, content };
  }

  search(query: ObsidianKBQuery): ObsidianNote[] {
    const { query: q, tags, category, limit = 10 } = query;
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    const scored: Array<{ note: ObsidianNote; score: number }> = [];

    for (const note of this.notes.values()) {
      if (tags && !tags.some((t) => note.tags.includes(t))) continue;
      if (category && note.category !== category) continue;

      let score = 0;
      const searchText = `${note.title} ${note.tags.join(' ')} ${note.aliases.join(' ')} ${note.excerpt}`.toLowerCase();

      for (const term of terms) {
        if (note.title.toLowerCase().includes(term)) score += 10;
        if (note.tags.some((t) => t.toLowerCase().includes(term))) score += 8;
        if (note.aliases.some((a) => a.toLowerCase().includes(term))) score += 5;
        if (note.excerpt.toLowerCase().includes(term)) score += 3;
        if (note.content.toLowerCase().includes(term)) score += 1;
      }

      // Boost recently modified notes
      const daysSinceUpdate = (Date.now() - new Date(note.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
      if (daysSinceUpdate < 7) score += 2;
      if (daysSinceUpdate < 1) score += 3;

      if (score > 0) {
        scored.push({ note, score });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => s.note);
  }

  getNote(relativePath: string): ObsidianNote | null {
    return this.notes.get(relativePath) ?? null;
  }

  getNotesByTag(tag: string): ObsidianNote[] {
    return [...this.notes.values()].filter((n) => n.tags.includes(tag));
  }

  getNotesByCategory(category: string): ObsidianNote[] {
    return [...this.notes.values()].filter((n) => n.category === category);
  }

  getLinkedNotes(notePath: string): ObsidianNote[] {
    const note = this.notes.get(notePath);
    if (!note) return [];

    return note.links
      .map((link) => {
        // Try exact match, then try with .md extension, then fuzzy
        const found = this.notes.get(link) ?? this.notes.get(`${link}.md`);
        if (found) return found;

        // Fuzzy: search by title
        for (const n of this.notes.values()) {
          if (n.title === link || n.aliases.includes(link)) return n;
        }
        return null;
      })
      .filter((n): n is ObsidianNote => n !== null);
  }

  buildKnowledgeContext(query: string, maxNotes = 5): string {
    const results = this.search({ query, limit: maxNotes });
    if (results.length === 0) return '';

    const parts: string[] = ['\n<knowledge-base source="obsidian-vault">'];

    for (const note of results) {
      const tagStr = note.tags.length > 0 ? ` [${note.tags.join(', ')}]` : '';
      parts.push(`## ${note.title}${tagStr}`);
      parts.push(`  Path: ${note.path} | Category: ${note.category}`);
      if (note.links.length > 0) {
        parts.push(`  Links: ${note.links.slice(0, 5).join(', ')}`);
      }
      parts.push(`  ${note.excerpt}`);
      parts.push('');
    }

    parts.push('</knowledge-base>');
    return parts.join('\n');
  }

  getStats(): { total: number; byCategory: Record<string, number>; tags: string[] } {
    const byCategory: Record<string, number> = {};
    const tagSet = new Set<string>();

    for (const note of this.notes.values()) {
      byCategory[note.category] = (byCategory[note.category] ?? 0) + 1;
      for (const tag of note.tags) {
        tagSet.add(tag);
      }
    }

    return {
      total: this.notes.size,
      byCategory,
      tags: [...tagSet].sort(),
    };
  }
}
