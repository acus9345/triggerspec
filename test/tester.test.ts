import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import type { Judge } from '../src/judge.js';
import { runTriggerTests } from '../src/tester.js';
import { skillMd, tmp, writeTree } from './helpers.js';

function catalog(files: Record<string, string>, extra: Record<string, string> = {}) {
  const root = writeTree(tmp(), files);
  const extraRoot = Object.keys(extra).length ? writeTree(tmp(), extra) : undefined;
  return loadCatalog(root, extraRoot ? [extraRoot] : []);
}

const pdf = skillMd({ name: 'pdf-forms', description: 'Fill in PDF forms and extract form fields. Use when the user asks to fill out a PDF form.' });
const csv = skillMd({ name: 'csv-charts', description: 'Turn CSV data into charts and spreadsheets. Use for plotting CSV files.' });

describe('runTriggerTests', () => {
  it('passes and fails cases with reasons', async () => {
    const c = catalog({
      'pdf-forms/SKILL.md': pdf,
      'pdf-forms/triggers.yaml': [
        'should_trigger:',
        '  - fill out my PDF form', // pass
        '  - plot CSV charts from my PDF', // fail: csv wins
        '  - book a flight', // fail: no overlap
        'should_not_trigger:',
        '  - plot this CSV file as charts', // pass (csv selected)
        '  - fill PDF form fields', // fail: triggers
        '  - prompt: chart the CSV',
        '    expect: csv-charts', // pass
        '  - prompt: hello there',
        '    expect: none', // pass
        '  - prompt: PDF form',
        '    expect: csv-charts', // fail: selected this skill
      ].join('\n'),
      'csv-charts/SKILL.md': csv,
    });
    const r = await runTriggerTests(c);
    expect(r.catalogSize).toBe(2);
    const cases = r.skills[0]!.cases;
    expect(cases.map((x) => x.pass)).toEqual([true, false, false, true, false, true, true, false]);
    expect(cases[1]!.reason).toMatch(/ranked #2; "csv-charts" ranks first/);
    expect(cases[1]!.runnerUp).toBe('csv-charts');
    expect(cases[2]!.reason).toMatch(/no overlap/);
    expect(cases[4]!.reason).toMatch(/would trigger/);
    expect(cases[7]!.reason).toMatch(/selected this skill/);
    expect(r.passed).toBe(4);
    expect(r.failed).toBe(4);
  });

  it('supports top-k, file thresholds and --only', async () => {
    const c = catalog({
      'pdf-forms/SKILL.md': pdf,
      'pdf-forms/triggers.yaml': 'threshold: 0.9\nshould_trigger:\n  - prompt: plot CSV charts from a PDF\n    top: 2\n  - fill the PDF form for my taxes and insurance\n',
      'csv-charts/SKILL.md': csv,
      'csv-charts/triggers.yaml': 'should_trigger: [plot csv]\n',
    });
    const r = await runTriggerTests(c, { only: ['pdf-forms'] });
    expect(r.skills.map((s) => s.skill)).toEqual(['pdf-forms']);
    expect(r.skills[0]!.cases[0]!.pass).toBe(true);
    expect(r.skills[0]!.cases[1]!.reason).toMatch(/below the threshold/);
    const lowered = await runTriggerTests(c, { only: ['pdf-forms'], threshold: 0.1 });
    expect(lowered.skills[0]!.cases[1]!.pass).toBe(true);
  });

  it('competes against --catalog skills and ignores disable-model-invocation skills', async () => {
    const c = catalog(
      { 'pdf-forms/SKILL.md': pdf, 'pdf-forms/triggers.yaml': 'should_trigger: [fill out the PDF form]\n', 'manual/SKILL.md': skillMd({ name: 'manual', description: 'Fill PDF form PDF form fill.', 'disable-model-invocation': 'true' }) },
      { 'pdf-pro/SKILL.md': skillMd({ name: 'pdf-pro', description: 'Fill out PDF forms. Fill out any PDF form. PDF form filling.' }) },
    );
    const r = await runTriggerTests(c);
    expect(r.catalogSize).toBe(2);
    expect(r.skills[0]!.cases[0]!.ranking.map((x) => x.skill)).toContain('pdf-pro');
  });

  it('reports invalid test files as failures', async () => {
    const r = await runTriggerTests(catalog({ 'pdf-forms/SKILL.md': pdf, 'pdf-forms/triggers.yaml': 'nope: 1\n' }));
    expect(r.failed).toBe(1);
    expect(r.skills[0]!.error).toMatch(/unknown top-level key/);
  });

  it('runs an injected LLM judge and records its verdicts and errors', async () => {
    let calls = 0;
    const judge: Judge = {
      name: 'fake',
      async select(prompt) {
        calls++;
        if (prompt.includes('boom')) throw new Error('rate limited');
        return prompt.includes('PDF') ? 'pdf-forms' : null;
      },
    };
    const c = catalog({ 'pdf-forms/SKILL.md': pdf, 'pdf-forms/triggers.yaml': 'should_trigger: [fill my PDF form, boom PDF]\nshould_not_trigger: [chart csv]\n', 'csv-charts/SKILL.md': csv });
    const r = await runTriggerTests(c, { judge });
    expect(calls).toBe(3);
    expect(r.judge).toEqual({ name: 'fake', passed: 2, failed: 0, errors: 1 });
    expect(r.skills[0]!.cases[1]!.judge?.error).toBe('rate limited');
  });

  it('records why the judge was skipped', async () => {
    const r = await runTriggerTests(catalog({ 'pdf-forms/SKILL.md': pdf, 'pdf-forms/triggers.yaml': 'should_trigger: [fill pdf form]\n' }), { judgeSkippedReason: 'no key' });
    expect(r.judge?.skippedReason).toBe('no key');
  });
});
