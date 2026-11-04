import * as path from 'node:path';
import type { CollisionReport } from './collisions.js';
import type { DiffReport } from './diff.js';
import type { RouteResult } from './scorer.js';
import type { TestRun } from './tester.js';
import type { Finding, Severity } from './types.js';
import { displayPath, plural } from './util.js';

export interface Style {
  red(s: string): string;
  yellow(s: string): string;
  green(s: string): string;
  dim(s: string): string;
  bold(s: string): string;
  cyan(s: string): string;
}

export function makeStyle(color: boolean): Style {
  const w = (open: number, close: number) => (s: string) => (color ? `\u001b[${open}m${s}\u001b[${close}m` : s);
  return { red: w(31, 39), yellow: w(33, 39), green: w(32, 39), dim: w(2, 22), bold: w(1, 22), cyan: w(36, 39) };
}

const ORDER: Record<Severity, number> = { error: 0, warning: 1, info: 2 };

export function countBySeverity(findings: Finding[]): Record<Severity, number> {
  const c = { error: 0, warning: 0, info: 0 };
  for (const f of findings) c[f.severity]++;
  return c;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

export function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort(
    (a, b) =>
      cmp(a.skillDir ?? '', b.skillDir ?? '') ||
      ORDER[a.severity] - ORDER[b.severity] ||
      cmp(a.file ?? '', b.file ?? '') ||
      (a.line ?? 0) - (b.line ?? 0) ||
      cmp(a.code, b.code),
  );
}

export function findingToJson(f: Finding, cwd: string) {
  return {
    code: f.code,
    severity: f.severity,
    message: f.message,
    file: f.file ? displayPath(f.file, cwd) : undefined,
    line: f.line,
    skill: f.skillDir ? displayPath(f.skillDir, cwd) : undefined,
    files: f.files?.map((x) => displayPath(x, cwd)),
  };
}

export function formatLint(findings: Finding[], skillDirs: string[], st: Style, cwd: string, showInfo: boolean): string {
  const lines: string[] = [];
  const sorted = sortFindings(findings).filter((f) => showInfo || f.severity !== 'info');
  const byDir = new Map<string, Finding[]>();
  for (const f of sorted) {
    const k = f.skillDir ?? '';
    const l = byDir.get(k) ?? [];
    l.push(f);
    byDir.set(k, l);
  }
  for (const dir of skillDirs) {
    const list = byDir.get(dir) ?? [];
    const c = countBySeverity(list);
    const badge = c.error ? st.red('✖') : c.warning ? st.yellow('⚠') : st.green('✔');
    lines.push(`${badge} ${st.bold(displayPath(dir, cwd))}${list.length ? '' : st.dim('  ok')}`);
    for (const f of list) {
      const sev = f.severity === 'error' ? st.red('error  ') : f.severity === 'warning' ? st.yellow('warning') : st.cyan('info   ');
      const loc = f.file ? `${displayPath(f.file, cwd)}${f.line ? `:${f.line}` : ''}` : '';
      lines.push(`    ${sev} ${f.message} ${st.dim(`[${f.code}]`)}${loc ? st.dim(`  ${loc}`) : ''}`);
    }
  }
  // Run-wide notes (e.g. the aggregated CRLF info) and paths that are not skills.
  const known = new Set(skillDirs);
  const general = sorted.filter((f) => !f.skillDir || !known.has(f.skillDir));
  if (general.length) {
    lines.push(st.bold('All paths'));
    for (const f of general) {
      const sev = f.severity === 'error' ? st.red('error  ') : f.severity === 'warning' ? st.yellow('warning') : st.cyan('info   ');
      const loc = f.file ? `${displayPath(f.file, cwd)}${f.line ? `:${f.line}` : ''}` : f.skillDir ? displayPath(f.skillDir, cwd) : '';
      lines.push(`    ${sev} ${f.message} ${st.dim(`[${f.code}]`)}${loc ? st.dim(`  ${loc}`) : ''}`);
    }
  }
  const c = countBySeverity(findings);
  const missing = new Set(findings.filter((f) => f.code === 'no-skills-found').map((f) => f.skillDir));
  lines.push('');
  lines.push(
    `${plural(skillDirs.filter((d) => !missing.has(d)).length, 'skill')} checked: ${c.error ? st.red(plural(c.error, 'error')) : plural(0, 'error')}, ${c.warning ? st.yellow(plural(c.warning, 'warning')) : plural(0, 'warning')}, ${plural(c.info, 'info', 'info')}${!showInfo && c.info ? st.dim(' (use --verbose to show)') : ''}`,
  );
  return lines.join('\n');
}

const q = (s: string, n = 70) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return `"${one.length > n ? one.slice(0, n - 1) + '…' : one}"`;
};

export function formatTest(run: TestRun, st: Style, cwd: string, verbose: boolean): string {
  const lines: string[] = [];
  if (run.skills.length === 0) {
    lines.push(st.yellow('No trigger test files found.') + ' Add triggers.yaml next to a SKILL.md (see README).');
    return lines.join('\n');
  }
  for (const s of run.skills) {
    const failed = s.error ? 1 : s.cases.filter((c) => !c.pass).length;
    const badge = failed ? st.red('✖') : st.green('✔');
    lines.push(`${badge} ${st.bold(s.skill)} ${st.dim(s.file ? displayPath(s.file, cwd) : '')}`);
    if (s.error) {
      lines.push(`    ${st.red('error')} ${s.error}`);
      continue;
    }
    for (const c of s.cases) {
      if (c.pass && !verbose) continue;
      const mark = c.pass ? st.green('pass') : st.red('FAIL');
      const kind = c.shouldTrigger ? 'should trigger    ' : 'should not trigger';
      lines.push(`    ${mark} ${st.dim(kind)} ${q(c.prompt)}`);
      lines.push(`         ${st.dim(c.reason + `; coverage ${c.coverage.toFixed(2)}, margin ${c.margin.toFixed(2)}`)}`);
      if (c.judge) {
        const jm = c.judge.error ? st.yellow('judge error: ' + c.judge.error) : `${c.judge.pass ? st.green('judge pass') : st.red('judge FAIL')} ${st.dim(`(${c.judge.name} chose ${c.judge.selected ?? 'none'})`)}`;
        lines.push(`         ${jm}`);
      }
    }
    const p = s.cases.filter((c) => c.pass).length;
    lines.push(`    ${st.dim(`${p}/${s.cases.length} passed`)}`);
  }
  lines.push('');
  const own = Object.entries(run.fileThresholds ?? {}).map(([k, v]) => `${k} ${v}`);
  lines.push(`Offline scorer (BM25, threshold ${run.threshold}${own.length ? ` (from trigger files: ${own.join(', ')})` : ''}, ${plural(run.catalogSize, 'skill')} in catalog): ${run.failed ? st.red(`${run.failed} failed`) : st.green('0 failed')}, ${run.passed} passed`);
  if (run.judge) {
    if (run.judge.skippedReason) lines.push(st.dim(`LLM judge: skipped — ${run.judge.skippedReason}`));
    else lines.push(`LLM judge (${run.judge.name}): ${run.judge.failed ? st.red(`${run.judge.failed} failed`) : st.green('0 failed')}, ${run.judge.passed} passed${run.judge.errors ? st.yellow(`, ${run.judge.errors} errors`) : ''}`);
  }
  return lines.join('\n');
}

export function formatCollisions(rep: CollisionReport, st: Style): string {
  const lines: string[] = [];
  if (rep.pairs.length === 0) {
    lines.push(st.green('✔') + ` No colliding descriptions among ${plural(rep.skills, 'skill')} (warn at similarity ≥ ${rep.warnAt}).`);
    return lines.join('\n');
  }
  for (const p of rep.pairs) {
    const sev = p.severity === 'error' ? st.red('error  ') : st.yellow('warning');
    lines.push(`${sev} ${st.bold(p.a)} ↔ ${st.bold(p.b)}  similarity ${p.similarity.toFixed(2)}`);
    if (p.shared.length) lines.push(`    shared terms: ${p.shared.join(', ')}`);
    lines.push(st.dim(`    only ${p.a}: ${p.onlyA.join(', ') || '—'}`));
    lines.push(st.dim(`    only ${p.b}: ${p.onlyB.join(', ') || '—'}`));
    for (const s of p.stolen.slice(0, 5)) lines.push(`    ${st.red('routed to ' + s.winner)}: ${q(s.prompt)} ${st.dim(`(test of ${s.owner})`)}`);
    if (p.stolen.length > 5) lines.push(st.dim(`    … ${p.stolen.length - 5} more misrouted prompts`));
  }
  const e = rep.pairs.filter((p) => p.severity === 'error').length;
  lines.push('');
  lines.push(`${plural(rep.skills, 'skill')}, ${plural(rep.pairs.length, 'colliding pair')} (${e} ≥ ${rep.errorAt}, ${rep.pairs.length - e} ≥ ${rep.warnAt} or misrouting tests)`);
  return lines.join('\n');
}

export function formatRoute(r: RouteResult, st: Style, top: number): string {
  const lines: string[] = [];
  lines.push(`${st.bold('prompt')} ${q(r.prompt, 100)}`);
  lines.push(st.dim(`terms: ${r.terms.join(' ') || '(none)'}`));
  const rows = r.ranking.filter((x) => x.score > 0).slice(0, top);
  if (rows.length === 0) lines.push(st.yellow('no skill matches any term'));
  rows.forEach((x, i) => {
    const sel = r.selected === x.skill ? st.green(' ← selected') : '';
    lines.push(`${String(i + 1).padStart(3)}. ${x.skill.padEnd(28)} bm25 ${x.score.toFixed(3).padStart(7)}  coverage ${x.coverage.toFixed(2)}  ${st.dim(x.matched.join(' '))}${sel}`);
  });
  if (!r.selected && rows.length) lines.push(st.yellow('no skill clears the trigger threshold'));
  return lines.join('\n');
}

export function formatDiff(d: DiffReport, st: Style): string {
  const lines: string[] = [];
  if (d.added.length) lines.push(`added skills: ${d.added.join(', ')}`);
  if (d.removed.length) lines.push(`removed skills: ${d.removed.join(', ')}`);
  if (d.descriptionChanged.length) lines.push(`descriptions changed: ${d.descriptionChanged.join(', ')}`);
  if (d.changes.length) {
    lines.push('');
    lines.push(st.bold(`Routing changes (${d.changes.length} of ${d.prompts} prompts):`));
    for (const c of d.changes) lines.push(`  ${q(c.prompt)}  ${c.before ?? 'none'} → ${c.after ?? 'none'}${c.owner ? st.dim(`  (test of ${c.owner})`) : ''}`);
  }
  if (d.regressions.length) {
    lines.push('');
    lines.push(st.red(st.bold(`Regressions (${d.regressions.length}): trigger tests that passed on base and fail now`)));
    for (const r of d.regressions) lines.push(`  ${st.red('✖')} ${r.skill}: ${r.shouldTrigger ? 'should trigger' : 'should not trigger'} ${q(r.prompt)} ${st.dim(r.reason)}`);
  }
  if (d.fixes.length) {
    lines.push('');
    lines.push(st.green(`Fixed (${d.fixes.length}): tests that failed on base and pass now`));
    for (const r of d.fixes) lines.push(`  ${st.green('✔')} ${r.skill}: ${q(r.prompt)}`);
  }
  lines.push('');
  lines.push(d.regressions.length ? st.red(`${plural(d.regressions.length, 'regression')}`) : st.green('No routing regressions') + `; ${plural(d.changes.length, 'prompt')} changed winner.`);
  return lines.join('\n');
}

export function rel(p: string, cwd: string): string {
  return displayPath(path.resolve(p), cwd);
}
