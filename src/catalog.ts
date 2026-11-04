import { realpathSync } from 'node:fs';
import * as path from 'node:path';
import { discoverSkills } from './discover.js';
import { loadSkill } from './parse.js';
import type { RoutableSkill } from './scorer.js';
import type { ParsedSkill } from './types.js';

export interface Catalog {
  /** Skills under test (from the primary path). */
  skills: ParsedSkill[];
  /** Extra competitor skills (from --catalog paths), not tested themselves. */
  extra: ParsedSkill[];
}

export function loadCatalog(primary: string, extraPaths: string[] = []): Catalog {
  const skills = discoverSkills(primary).map(loadSkill);
  const id = (d: string) => {
    try {
      return realpathSync.native(d);
    } catch {
      return path.resolve(d);
    }
  };
  const seen = new Set(skills.map((s) => id(s.dir)));
  const extra: ParsedSkill[] = [];
  for (const p of extraPaths) {
    for (const sf of discoverSkills(p)) {
      if (seen.has(id(sf.dir))) continue;
      seen.add(id(sf.dir));
      extra.push(loadSkill(sf));
    }
  }
  return { skills, extra };
}

/** Routing view of a skill. Skills without a usable name fall back to the folder name. */
export function toRoutable(s: ParsedSkill): RoutableSkill {
  const extra = typeof s.frontmatter?.when_to_use === 'string' ? s.frontmatter.when_to_use : undefined;
  return { name: s.name || path.basename(s.dir), description: s.description, extra, id: s.dir };
}

/** Skills a router would actually see (have a description and are model-invocable). */
export function routableSkills(list: ParsedSkill[]): RoutableSkill[] {
  return list
    .filter((s) => s.description !== '' && s.frontmatter?.['disable-model-invocation'] !== true)
    .map(toRoutable);
}
