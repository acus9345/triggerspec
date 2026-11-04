import { describe, expect, it } from 'vitest';
import { loadCatalog } from '../src/catalog.js';
import { cosine, findCollisions } from '../src/collisions.js';
import { skillMd, tmp, writeTree } from './helpers.js';

const sql = skillMd({ name: 'sql-helper', description: 'Write, explain and optimize SQL queries for PostgreSQL and MySQL databases, including joins, indexes and query plans.' });
const db = skillMd({ name: 'db-assistant', description: '"Help with database questions: write SQL queries, explain query plans and optimize slow PostgreSQL or MySQL queries with indexes."' });
const art = skillMd({ name: 'pixel-art', description: 'Draw retro pixel art sprites and tile sets for games.' });

describe('cosine', () => {
  it('is 1 for identical, 0 for disjoint and empty vectors', () => {
    const a = new Map([['x', 1], ['y', 2]]);
    expect(cosine(a, a)).toBeCloseTo(1);
    expect(cosine(a, new Map([['z', 1]]))).toBe(0);
    expect(cosine(new Map(), a)).toBe(0);
  });
});

describe('findCollisions', () => {
  it('reports near-duplicate descriptions as errors with shared/unique terms in readable form', () => {
    const rep = findCollisions(loadCatalog(writeTree(tmp(), { 'sql-helper/SKILL.md': sql, 'db-assistant/SKILL.md': db, 'pixel-art/SKILL.md': art })));
    expect(rep.skills).toBe(3);
    expect(rep.pairs).toHaveLength(1);
    const p = rep.pairs[0]!;
    expect([p.a, p.b].sort()).toEqual(['db-assistant', 'sql-helper']);
    expect(p.severity).toBe('error');
    expect(p.similarity).toBeGreaterThanOrEqual(0.7);
    expect(p.shared).toContain('queries');
    expect(p.shared).toContain('postgresql');
  });

  it('respects thresholds', () => {
    const c = loadCatalog(writeTree(tmp(), { 'sql-helper/SKILL.md': sql, 'db-assistant/SKILL.md': db }));
    expect(findCollisions(c, { warnAt: 0.95, errorAt: 0.99 }).pairs).toEqual([]);
    expect(findCollisions(c, { warnAt: 0.1, errorAt: 0.99 }).pairs[0]!.severity).toBe('warning');
  });

  it('reports misrouted should-trigger tests as evidence even below the similarity threshold', () => {
    const c = loadCatalog(
      writeTree(tmp(), {
        'sql-helper/SKILL.md': sql,
        'sql-helper/triggers.yaml': 'should_trigger: [draw pixel art sprites for my game]\n',
        'pixel-art/SKILL.md': art,
      }),
    );
    const rep = findCollisions(c);
    expect(rep.pairs).toHaveLength(1);
    expect(rep.pairs[0]!.stolen).toEqual([{ prompt: 'draw pixel art sprites for my game', owner: 'sql-helper', winner: 'pixel-art' }]);
    expect(rep.pairs[0]!.severity).toBe('warning');
  });

  it('includes --catalog competitors but never reports pairs among them only', () => {
    const c = loadCatalog(writeTree(tmp(), { 'pixel-art/SKILL.md': art }), [writeTree(tmp(), { 'sql-helper/SKILL.md': sql, 'db-assistant/SKILL.md': db })]);
    expect(findCollisions(c).pairs).toEqual([]);
    const c2 = loadCatalog(writeTree(tmp(), { 'sql-helper/SKILL.md': sql }), [writeTree(tmp(), { 'db-assistant/SKILL.md': db })]);
    expect(findCollisions(c2).pairs).toHaveLength(1);
  });
});
