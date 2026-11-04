import type { RoutableSkill } from './scorer.js';

/** Optional LLM judge: asks a model which skill (if any) it would load for a prompt. */
export interface Judge {
  name: string;
  select(prompt: string, skills: RoutableSkill[]): Promise<string | null>;
}

export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

export interface JudgeConfig {
  provider?: 'anthropic' | 'openai';
  model?: string;
  env?: Record<string, string | undefined>;
  fetch?: FetchLike;
}

const SYSTEM = [
  'You are the skill router of an AI agent. You are given the list of available skills (name and description)',
  'and one user message. Decide which single skill the agent should load to handle the message, or "none" if',
  'no skill is clearly appropriate. Answer with JSON only: {"skill": "<name>"} or {"skill": null}.',
].join(' ');

export function buildJudgePrompt(prompt: string, skills: RoutableSkill[]): string {
  const list = skills.map((s) => `- ${s.name}: ${s.description.replace(/\s+/g, ' ').trim()}${s.extra ? ` (${s.extra.replace(/\s+/g, ' ').trim()})` : ''}`).join('\n');
  return `<available_skills>\n${list}\n</available_skills>\n\n<user_message>\n${prompt}\n</user_message>\n\nWhich skill should be loaded? Reply with JSON only.`;
}

/** Parse the model's answer into a skill name (validated against the catalog) or null. */
export function parseJudgeAnswer(text: string, skills: RoutableSkill[]): string | null {
  const names = new Set(skills.map((s) => s.name));
  const m = /\{[\s\S]*?\}/.exec(text);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as { skill?: unknown };
      if (obj.skill === null || obj.skill === undefined || obj.skill === 'none') return null;
      if (typeof obj.skill === 'string' && names.has(obj.skill.trim())) return obj.skill.trim();
    } catch {
      /* fall through */
    }
  }
  const t = text.trim().replace(/^["'`]|["'`]$/g, '');
  if (names.has(t)) return t;
  if (/^none$/i.test(t)) return null;
  throw new Error(`could not parse judge answer: ${text.slice(0, 120)}`);
}

/**
 * Create a judge from environment variables. Returns null (with a reason) when no key is set,
 * so offline mode stays the default and CI without secrets keeps working.
 *   ANTHROPIC_API_KEY                         -> Anthropic Messages API
 *   OPENAI_API_KEY [+ OPENAI_BASE_URL]        -> any OpenAI-compatible /chat/completions
 *   TRIGGERSPEC_MODEL                         -> model override
 */
export function createJudge(cfg: JudgeConfig = {}): { judge: Judge | null; reason?: string } {
  const env = cfg.env ?? process.env;
  const doFetch: FetchLike = cfg.fetch ?? ((url, init) => fetch(url, init));
  const provider = cfg.provider ?? (env.ANTHROPIC_API_KEY ? 'anthropic' : env.OPENAI_API_KEY ? 'openai' : undefined);
  if (!provider) return { judge: null, reason: 'no ANTHROPIC_API_KEY or OPENAI_API_KEY set (offline results only)' };
  const model = cfg.model ?? env.TRIGGERSPEC_MODEL;
  if (provider === 'anthropic') {
    const key = env.ANTHROPIC_API_KEY;
    if (!key) return { judge: null, reason: 'ANTHROPIC_API_KEY not set' };
    const base = (env.ANTHROPIC_BASE_URL ?? 'https://api.anthropic.com').replace(/\/$/, '');
    const m = model ?? 'claude-haiku-4-5';
    return {
      judge: {
        name: `anthropic:${m}`,
        async select(prompt, skills) {
          const res = await doFetch(`${base}/v1/messages`, {
            method: 'POST',
            headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
            body: JSON.stringify({ model: m, max_tokens: 64, temperature: 0, system: SYSTEM, messages: [{ role: 'user', content: buildJudgePrompt(prompt, skills) }] }),
          });
          const body = await res.text();
          if (!res.ok) throw new Error(`Anthropic API ${res.status}: ${body.slice(0, 200)}`);
          const data = JSON.parse(body) as { content?: { type: string; text?: string }[] };
          const text = (data.content ?? []).filter((c) => c.type === 'text').map((c) => c.text ?? '').join('');
          return parseJudgeAnswer(text, skills);
        },
      },
    };
  }
  const key = env.OPENAI_API_KEY;
  if (!key) return { judge: null, reason: 'OPENAI_API_KEY not set' };
  const base = (env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  const m = model ?? 'gpt-4o-mini';
  return {
    judge: {
      name: `openai:${m}`,
      async select(prompt, skills) {
        const res = await doFetch(`${base}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
          body: JSON.stringify({ model: m, temperature: 0, max_tokens: 64, messages: [{ role: 'system', content: SYSTEM }, { role: 'user', content: buildJudgePrompt(prompt, skills) }] }),
        });
        const body = await res.text();
        if (!res.ok) throw new Error(`OpenAI-compatible API ${res.status}: ${body.slice(0, 200)}`);
        const data = JSON.parse(body) as { choices?: { message?: { content?: string } }[] };
        return parseJudgeAnswer(data.choices?.[0]?.message?.content ?? '', skills);
      },
    },
  };
}
