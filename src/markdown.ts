/** Small, dependency-free Markdown scanning for links, headings and path mentions. */

export interface MdLink {
  /** Raw target as written, e.g. `references/api.md#auth`. */
  target: string;
  line: number;
  kind: 'inline' | 'image' | 'reference-definition';
}

export interface PathMention {
  path: string;
  line: number;
  inCode: boolean;
}

interface ScannedLine {
  text: string;
  line: number;
  inCode: boolean;
}

/** Split markdown into lines, flagging those inside fenced code blocks (``` or ~~~). */
export function scanLines(md: string, firstLine = 1): ScannedLine[] {
  const out: ScannedLine[] = [];
  const lines = md.split('\n');
  let fence: { ch: string; len: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] ?? '';
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(text);
    if (fence) {
      if (m && m[1]![0] === fence.ch && m[1]!.length >= fence.len && text.trim() === m[1]) {
        out.push({ text, line: firstLine + i, inCode: true });
        fence = null;
        continue;
      }
      out.push({ text, line: firstLine + i, inCode: true });
      continue;
    }
    if (m) {
      fence = { ch: m[1]![0]!, len: m[1]!.length };
      out.push({ text, line: firstLine + i, inCode: true });
      continue;
    }
    out.push({ text, line: firstLine + i, inCode: false });
  }
  return out;
}

/** Remove inline code spans so links shown as code are not treated as links. */
export function stripInlineCode(line: string): string {
  return line.replace(/(`+)(?:(?!\1)[\s\S])*?\1/g, (s) => ' '.repeat(s.length));
}

/** Inline code span contents (used to find path mentions like `scripts/run.py`). */
function inlineCodeSpans(line: string): string[] {
  const spans: string[] = [];
  const re = /(`+)((?:(?!\1)[\s\S])*?)\1/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(line))) spans.push(m[2] ?? '');
  return spans;
}

function cleanTarget(raw: string): string {
  let t = raw.trim();
  if (t.startsWith('<')) {
    const end = t.indexOf('>');
    t = end > 0 ? t.slice(1, end) : t.slice(1);
  } else {
    // Drop an optional title: (path "title") / (path 'title').
    const sp = t.search(/\s+["'(]/);
    if (sp > 0) t = t.slice(0, sp);
  }
  return t.trim();
}

/** Extract markdown links (inline, image, reference definitions) outside code. */
export function extractLinks(md: string, firstLine = 1): MdLink[] {
  const out: MdLink[] = [];
  for (const l of scanLines(md, firstLine)) {
    if (l.inCode) continue;
    const text = stripInlineCode(l.text);
    const def = /^ {0,3}\[([^\]]+)\]:\s*(\S+)/.exec(text);
    if (def && !/^\^/.test(def[1] ?? '')) {
      out.push({ target: cleanTarget(def[2] ?? ''), line: l.line, kind: 'reference-definition' });
      continue;
    }
    // [text](target) and ![alt](target); allows one level of nested brackets in text.
    // Bounded and without overlapping alternatives so long runs of "[" stay linear.
    const re = /(!?)\[(?:[^[\]]|\[[^[\]]*\]){0,1000}\]\(\s*(<[^>]*>|(?:[^()\s]|\([^()]*\))+)(?:\s+(?:"[^"]*"|'[^']*'|\([^)]*\)))?\s*\)/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      out.push({ target: cleanTarget(m[2] ?? ''), line: l.line, kind: m[1] ? 'image' : 'inline' });
    }
  }
  return out;
}

/** Directories whose bare mentions (e.g. `python scripts/fill.py`) are treated as file references. */
export const RESOURCE_DIRS = ['scripts', 'references', 'reference', 'assets', 'templates', 'resources', 'examples', 'docs', 'lib'];

/**
 * Find bare path mentions such as `scripts/extract.py` or `references\api.md` in prose,
 * inline code and fenced code. Only paths whose first segment is in `firstSegments` are returned.
 */
export function extractPathMentions(md: string, firstSegments: Iterable<string>, firstLine = 1, opts: { caseInsensitive?: boolean } = {}): PathMention[] {
  const segs = [...new Set(firstSegments)].filter((s) => s.length > 0).map(escapeRe);
  if (segs.length === 0) return [];
  const re = new RegExp(
    String.raw`(?<![\w./\\$%{-])(?:\.[\\/])?((?:${segs.join('|')})(?:[\\/][\p{L}\p{N}_.@+-]+)+[\\/]?)`,
    opts.caseInsensitive ? 'giu' : 'gu',
  );
  const out: PathMention[] = [];
  for (const l of scanLines(md, firstLine)) {
    const chunks = l.inCode ? [l.text] : [l.text, ...inlineCodeSpans(l.text)];
    const seen = new Set<string>();
    for (const chunk of chunks) {
      let m: RegExpExecArray | null;
      re.lastIndex = 0;
      while ((m = re.exec(chunk))) {
        let p = m[1] ?? '';
        p = p.replace(/[.,;:]+$/, ''); // trailing sentence punctuation
        if (!p || seen.has(p)) continue;
        // Placeholders / globs are not concrete paths.
        const after = chunk[m.index + m[0].length] ?? '';
        if (after === '*' || after === '{' || after === '<' || after === '$') continue;
        seen.add(p);
        out.push({ path: p, line: l.line, inCode: l.inCode });
      }
    }
  }
  return out;
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** GitHub-style heading slugs (with -1, -2 suffixes for duplicates). */
export function headingSlugs(md: string): Set<string> {
  const slugs = new Set<string>();
  const counts = new Map<string, number>();
  const add = (title: string): void => {
    const base = slugify(title);
    const n = counts.get(base) ?? 0;
    counts.set(base, n + 1);
    slugs.add(n === 0 ? base : `${base}-${n}`);
  };
  const lines = scanLines(md);
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (l.inCode) continue;
    const m = /^ {0,3}#{1,6}[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/.exec(l.text);
    if (m) {
      add(m[1] ?? '');
      continue;
    }
    // Setext headings.
    const next = lines[i + 1];
    if (next && !next.inCode && l.text.trim() !== '' && /^ {0,3}(=+|-+)[ \t]*$/.test(next.text) && !/^ {0,3}[-*+>]/.test(l.text)) {
      add(l.text.trim());
    }
  }
  // Explicit HTML anchors: <a id="x"> / <a name="x">
  for (const m of md.matchAll(/<a\s+(?:[^>]*\s)?(?:id|name)=["']([^"']+)["']/gi)) slugs.add(m[1]!);
  return slugs;
}

export function slugify(title: string): string {
  return title
    .replace(/<[^>]+>/g, '')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_~]/g, (c) => (c === '_' ? '_' : ''))
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\p{M} _-]/gu, '')
    .replace(/ /g, '-');
}
