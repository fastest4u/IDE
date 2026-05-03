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

export interface ObsidianChunk {
  id: string;
  notePath: string;
  title: string;
  heading: string;
  tags: string[];
  aliases: string[];
  content: string;
  excerpt: string;
  startLine: number;
  endLine: number;
  links: string[];
  category: string;
  updatedAt: string;
  tokenCount: number;
}

export interface ObsidianRAGResult {
  chunk: ObsidianChunk;
  score: number;
  reasons: string[];
  citation: {
    path: string;
    title: string;
    heading: string;
    lines: [number, number];
  };
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

export interface ObsidianRAGQuery extends ObsidianKBQuery {
  minScore?: number;
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
  private chunks: Map<string, ObsidianChunk> = new Map();
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
    this.chunks.clear();
    this.indexBuilt = false;
  }

  async buildIndex(): Promise<number> {
    this.notes.clear();
    this.chunks.clear();
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
              for (const chunk of chunkNote(note)) {
                this.chunks.set(chunk.id, chunk);
              }
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

  retrieve(query: ObsidianRAGQuery): ObsidianRAGResult[] {
    const { query: q, tags, category, limit = 8, minScore = 0.05 } = query;
    const terms = tokenize(q);
    if (!terms.length) return [];

    const queryVector = termVector(terms);
    const scored: ObsidianRAGResult[] = [];

    for (const chunk of this.chunks.values()) {
      if (tags && !tags.some((tag) => chunk.tags.includes(tag))) continue;
      if (category && chunk.category !== category) continue;

      const { score, reasons } = scoreChunk(q, terms, queryVector, chunk);
      if (score >= minScore) {
        scored.push({
          chunk,
          score,
          reasons,
          citation: {
            path: chunk.notePath,
            title: chunk.title,
            heading: chunk.heading,
            lines: [chunk.startLine, chunk.endLine],
          },
        });
      }
    }

    return scored
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
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
    const ragResults = this.retrieve({ query, limit: maxNotes });
    if (ragResults.length > 0) {
      return this.buildRagContext(query, maxNotes);
    }

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

  buildRagContext(query: string, maxChunks = 8): string {
    const results = this.retrieve({ query, limit: maxChunks });
    if (!results.length) return '';

    const parts: string[] = ['\n<knowledge-base source="obsidian-rag" retrieval="hybrid-local" trust="untrusted">'];

    for (const result of results) {
      const { chunk, citation } = result;
      const tagStr = chunk.tags.length > 0 ? ` tags="${chunk.tags.slice(0, 8).join(',')}"` : '';
      parts.push(`<chunk id="${escapeXml(chunk.id)}" score="${result.score.toFixed(3)}" path="${escapeXml(citation.path)}" lines="${citation.lines[0]}-${citation.lines[1]}" heading="${escapeXml(citation.heading)}"${tagStr}>`);
      parts.push(chunk.content);
      parts.push('</chunk>');
      parts.push('');
    }

    parts.push('</knowledge-base>');
    return parts.join('\n');
  }

  getStats(): { total: number; chunks: number; byCategory: Record<string, number>; tags: string[] } {
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
      chunks: this.chunks.size,
      byCategory,
      tags: [...tagSet].sort(),
    };
  }
}

const MAX_CHUNK_CHARS = 1200;
const CHUNK_OVERLAP_CHARS = 180;

function chunkNote(note: ObsidianNote): ObsidianChunk[] {
  const sections = splitMarkdownSections(note.content);
  const chunks: ObsidianChunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    const parts = splitSectionText(section.text, MAX_CHUNK_CHARS, CHUNK_OVERLAP_CHARS);
    for (const part of parts) {
      const content = part.text.trim();
      if (!content) continue;
      const startLine = section.startLine + part.startLineOffset;
      const endLine = Math.max(startLine, startLine + content.split('\n').length - 1);
      chunks.push({
        id: `${slugifyPath(note.path)}:${chunkIndex++}`,
        notePath: note.path,
        title: note.title,
        heading: section.heading,
        tags: note.tags,
        aliases: note.aliases,
        content,
        excerpt: content.replace(/\s+/g, ' ').slice(0, 240),
        startLine,
        endLine,
        links: note.links,
        category: note.category,
        updatedAt: note.updatedAt,
        tokenCount: tokenize(content).length,
      });
    }
  }

  return chunks;
}

function splitMarkdownSections(content: string): Array<{ heading: string; startLine: number; text: string }> {
  const lines = content.split('\n');
  const sections: Array<{ heading: string; startLine: number; lines: string[] }> = [];
  let current: { heading: string; startLine: number; lines: string[] } = {
    heading: 'Overview',
    startLine: 1,
    lines: [],
  };

  for (const [index, line] of lines.entries()) {
    const headingMatch = line.match(/^(#{1,6})\s+(.+?)\s*#*$/);
    if (headingMatch && current.lines.some((item) => item.trim())) {
      sections.push(current);
      current = {
        heading: headingMatch[2]?.trim() || 'Section',
        startLine: index + 1,
        lines: [line],
      };
      continue;
    }

    if (headingMatch && !current.lines.some((item) => item.trim())) {
      current.heading = headingMatch[2]?.trim() || 'Section';
      current.startLine = index + 1;
    }
    current.lines.push(line);
  }

  if (current.lines.some((item) => item.trim())) {
    sections.push(current);
  }

  return sections.map((section) => ({
    heading: section.heading,
    startLine: section.startLine,
    text: section.lines.join('\n'),
  }));
}

function splitSectionText(text: string, maxChars: number, overlapChars: number): Array<{ text: string; startLineOffset: number }> {
  if (text.length <= maxChars) {
    return [{ text, startLineOffset: 0 }];
  }

  const chunks: Array<{ text: string; startLineOffset: number }> = [];
  let cursor = 0;
  let startLineOffset = 0;

  while (cursor < text.length) {
    const end = Math.min(text.length, cursor + maxChars);
    const preferredEnd = end < text.length ? Math.max(
      text.lastIndexOf('\n\n', end),
      text.lastIndexOf('\n', end),
      text.lastIndexOf('. ', end),
    ) : end;
    const chunkEnd = preferredEnd > cursor + maxChars * 0.45 ? preferredEnd : end;
    const chunkText = text.slice(cursor, chunkEnd).trim();
    if (chunkText) {
      chunks.push({ text: chunkText, startLineOffset });
    }
    if (chunkEnd >= text.length) break;
    const nextCursor = Math.max(0, chunkEnd - overlapChars);
    startLineOffset = text.slice(0, nextCursor).split('\n').length - 1;
    cursor = nextCursor;
  }

  return chunks;
}

function scoreChunk(
  query: string,
  terms: string[],
  queryVector: Map<string, number>,
  chunk: ObsidianChunk,
): { score: number; reasons: string[] } {
  const reasons: string[] = [];
  const title = chunk.title.toLowerCase();
  const heading = chunk.heading.toLowerCase();
  const content = chunk.content.toLowerCase();
  const metadata = `${chunk.tags.join(' ')} ${chunk.aliases.join(' ')}`.toLowerCase();
  const normalizedQuery = query.toLowerCase().trim();
  let score = 0;

  if (normalizedQuery && content.includes(normalizedQuery)) {
    score += 12;
    reasons.push('exact phrase');
  }

  for (const term of terms) {
    if (title.includes(term)) {
      score += 6;
      reasons.push(`title:${term}`);
    }
    if (heading.includes(term)) {
      score += 5;
      reasons.push(`heading:${term}`);
    }
    if (metadata.includes(term)) {
      score += 4;
      reasons.push(`metadata:${term}`);
    }
    const hits = countOccurrences(content, term);
    if (hits > 0) {
      score += Math.min(8, hits * 1.5);
      reasons.push(`content:${term}`);
    }
  }

  const vectorScore = cosineSimilarity(queryVector, termVector(tokenize(`${chunk.title} ${chunk.heading} ${chunk.tags.join(' ')} ${chunk.content}`)));
  if (vectorScore > 0) {
    score += vectorScore * 18;
    reasons.push(`vector:${vectorScore.toFixed(2)}`);
  }

  const daysSinceUpdate = (Date.now() - new Date(chunk.updatedAt).getTime()) / (1000 * 60 * 60 * 24);
  if (daysSinceUpdate < 30) score += 0.5;
  if (daysSinceUpdate < 7) score += 0.5;

  return { score, reasons: [...new Set(reasons)].slice(0, 8) };
}

function tokenize(value: string): string[] {
  const normalized = value
    .toLowerCase()
    .replace(/\[\[([^\]|]+)(?:\|[^\]]+)?\]\]/g, '$1')
    .replace(/[`*_>#()[\]{}.,:;!?'"|\\]/g, ' ');
  const words = normalized.match(/[\p{L}\p{N}_/-]{2,}/gu) ?? [];
  const compact = normalized.replace(/\s+/g, '');
  const grams = compact.length >= 8 ? Array.from(characterNgrams(compact, 4)).slice(0, 80) : [];
  return [...words, ...grams].filter((token) => !STOP_WORDS.has(token));
}

function termVector(tokens: string[]): Map<string, number> {
  const vector = new Map<string, number>();
  for (const token of tokens) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  return vector;
}

function cosineSimilarity(a: Map<string, number>, b: Map<string, number>): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (const value of a.values()) normA += value * value;
  for (const value of b.values()) normB += value * value;
  for (const [key, value] of a.entries()) {
    dot += value * (b.get(key) ?? 0);
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function countOccurrences(value: string, term: string): number {
  if (!term) return 0;
  let count = 0;
  let index = value.indexOf(term);
  while (index !== -1 && count < 20) {
    count++;
    index = value.indexOf(term, index + term.length);
  }
  return count;
}

function* characterNgrams(value: string, size: number): Iterable<string> {
  for (let index = 0; index <= value.length - size; index++) {
    yield value.slice(index, index + size);
  }
}

function slugifyPath(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9ก-๙_-]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'note';
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const STOP_WORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'from',
  'that',
  'this',
  'are',
  'was',
  'were',
  'เป็น',
  'และ',
  'ของ',
  'ใน',
  'ที่',
  'คือ',
]);
