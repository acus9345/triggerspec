import { describe, expect, it } from 'vitest';
import { Bm25Index, DEFAULT_THRESHOLD } from '../src/scorer.js';
import { stem, surfaceForms, tokenize } from '../src/tokenize.js';

describe('tokenize', () => {
  it('lowercases, drops stopwords and description boilerplate, stems', () => {
    expect(tokenize('Use this skill when the user wants to Convert PDFs')).toEqual(['convert', 'pdf']);
    expect(tokenize('filling filled fills')).toEqual(['fill', 'fill', 'fill']);
  });

  it('is deterministic and stable for related word forms', () => {
    expect(stem('queries')).toBe(stem('query'));
    expect(stem('spreadsheets')).toBe(stem('spreadsheet'));
    expect(stem('analysis')).toBe('analysis');
    expect(stem('v2')).toBe('v2');
  });

  it('applies NFKC (full-width -> ASCII) and keeps accents', () => {
    expect(tokenize('ＰＤＦ résumé')).toEqual(['pdf', 'résumé']);
  });

  it('emits CJK character bigrams, including mixed runs', () => {
    expect(tokenize('请帮我翻译')).toEqual(['请帮', '帮我', '我翻', '翻译']);
    expect(tokenize('PDFを結合')).toEqual(['pdf', 'を結', '結合']);
    expect(tokenize('字')).toEqual(['字']);
  });

  it('keeps numbers and drops single letters', () => {
    expect(tokenize('a b 3 q3 x')).toEqual(['3', 'q3']);
  });

  it('maps stems back to surface words for reports', () => {
    expect(surfaceForms('Filling forms').get(stem('filling'))).toBe('filling');
  });

  it('handles empty and punctuation-only input', () => {
    expect(tokenize('')).toEqual([]);
    expect(tokenize('!!! --- ...')).toEqual([]);
  });
});

const skills = [
  { name: 'pdf-forms', description: 'Fill in PDF forms and extract form fields. Use when the user asks to fill out a PDF form.' },
  { name: 'csv-charts', description: 'Turn CSV data into charts and spreadsheets. Use for plotting CSV files.' },
  { name: 'release-notes', description: 'Write release notes and changelogs from git history.' },
];

describe('Bm25Index', () => {
  const idx = new Bm25Index(skills);

  it('ranks the right skill first, with coverage and matched terms', () => {
    const r = idx.route('please fill out this PDF form', DEFAULT_THRESHOLD);
    expect(r.selected).toBe('pdf-forms');
    expect(r.ranking[0]!.coverage).toBe(1);
    expect(r.ranking[0]!.matched).toEqual(['fill', 'pdf', 'form']);
    expect(r.margin).toBe(1); // nothing else matched
  });

  it('returns no selection when nothing matches or coverage is below threshold', () => {
    expect(idx.route('what is the weather tomorrow', DEFAULT_THRESHOLD).selected).toBeNull();
    const low = idx.route('book flights hotels rental cars insurance visa pdf', 0.5);
    expect(low.ranking[0]!.skill).toBe('pdf-forms');
    expect(low.selected).toBeNull();
    expect(idx.route('book flights hotels rental cars insurance visa pdf', 0).selected).toBe('pdf-forms');
  });

  it('weights name tokens higher than description tokens', () => {
    const i2 = new Bm25Index([
      { name: 'changelog', description: 'Write notes about software versions.' },
      { name: 'notes', description: 'Keep a changelog of personal notes about your day.' },
    ]);
    expect(i2.rank('changelog').ranking[0]!.skill).toBe('changelog');
  });

  it('is fully deterministic, ties broken by name', () => {
    const i2 = new Bm25Index([
      { name: 'b-skill', description: 'convert files' },
      { name: 'a-skill', description: 'convert files' },
    ]);
    const r = i2.route('convert files', 0.2);
    expect(r.ranking.map((x) => x.skill)).toEqual(['a-skill', 'b-skill']);
    expect(r.margin).toBe(0);
    expect(JSON.stringify(i2.route('convert files', 0.2))).toBe(JSON.stringify(r));
  });

  it('includes extra routing text (when_to_use)', () => {
    const i2 = new Bm25Index([{ name: 'a', description: 'Formats things.', extra: 'invoices receipts' }, { name: 'b', description: 'Other stuff.' }]);
    expect(i2.route('format my invoices', 0.2).selected).toBe('a');
  });

  it('routes CJK prompts', () => {
    const i2 = new Bm25Index([{ name: 'translate', description: '中文翻译成英文。Translate Chinese text.' }, { name: 'other', description: 'Write code.' }]);
    expect(i2.route('请把这段中文翻译成英文', 0.2).selected).toBe('translate');
  });

  it('handles an empty catalog', () => {
    const r = new Bm25Index([]).route('anything', 0.2);
    expect(r.selected).toBeNull();
    expect(r.ranking).toEqual([]);
  });
});
