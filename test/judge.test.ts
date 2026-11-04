import { describe, expect, it } from 'vitest';
import { buildJudgePrompt, createJudge, parseJudgeAnswer, type FetchLike } from '../src/judge.js';

const skills = [
  { name: 'pdf-forms', description: 'Fill PDF forms.' },
  { name: 'csv-charts', description: 'Plot CSV files.', extra: 'charts' },
];

function fakeFetch(status: number, body: unknown) {
  const calls: { url: string; init: { method: string; headers: Record<string, string>; body: string } }[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push({ url, init: init as never });
    return { ok: status < 400, status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) };
  };
  return { fetch, calls };
}

describe('createJudge', () => {
  it('is skipped (null + reason) when no API key is set', () => {
    const r = createJudge({ env: {} });
    expect(r.judge).toBeNull();
    expect(r.reason).toMatch(/no ANTHROPIC_API_KEY or OPENAI_API_KEY set/);
    expect(createJudge({ env: {}, provider: 'openai' }).reason).toMatch(/OPENAI_API_KEY/);
    expect(createJudge({ env: {}, provider: 'anthropic' }).reason).toMatch(/ANTHROPIC_API_KEY/);
  });

  it('calls the Anthropic Messages API', async () => {
    const { fetch, calls } = fakeFetch(200, { content: [{ type: 'text', text: '{"skill": "pdf-forms"}' }] });
    const { judge } = createJudge({ env: { ANTHROPIC_API_KEY: 'sk-test' }, fetch });
    expect(judge!.name).toBe('anthropic:claude-haiku-4-5');
    expect(await judge!.select('fill my form', skills)).toBe('pdf-forms');
    expect(calls[0]!.url).toBe('https://api.anthropic.com/v1/messages');
    expect(calls[0]!.init.headers['x-api-key']).toBe('sk-test');
    const body = JSON.parse(calls[0]!.init.body);
    expect(body.temperature).toBe(0);
    expect(body.messages[0].content).toContain('pdf-forms: Fill PDF forms.');
  });

  it('calls any OpenAI-compatible endpoint, with model override', async () => {
    const { fetch, calls } = fakeFetch(200, { choices: [{ message: { content: '{"skill": null}' } }] });
    const { judge } = createJudge({ env: { OPENAI_API_KEY: 'k', OPENAI_BASE_URL: 'http://localhost:11434/v1/', TRIGGERSPEC_MODEL: 'llama3' }, fetch });
    expect(judge!.name).toBe('openai:llama3');
    expect(await judge!.select('hello', skills)).toBeNull();
    expect(calls[0]!.url).toBe('http://localhost:11434/v1/chat/completions');
    expect(calls[0]!.init.headers.authorization).toBe('Bearer k');
  });

  it('prefers Anthropic when both keys are set unless a provider is given', () => {
    const env = { ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o' };
    expect(createJudge({ env }).judge!.name).toMatch(/^anthropic:/);
    expect(createJudge({ env, provider: 'openai', model: 'gpt-x' }).judge!.name).toBe('openai:gpt-x');
  });

  it('surfaces HTTP errors', async () => {
    const { fetch } = fakeFetch(429, 'slow down');
    const { judge } = createJudge({ env: { ANTHROPIC_API_KEY: 'a' }, fetch });
    await expect(judge!.select('x', skills)).rejects.toThrow(/429: slow down/);
  });
});

describe('parseJudgeAnswer', () => {
  it('accepts JSON, bare names and none; rejects unknown skills', () => {
    expect(parseJudgeAnswer('Sure! {"skill": "csv-charts"}', skills)).toBe('csv-charts');
    expect(parseJudgeAnswer('{"skill": "none"}', skills)).toBeNull();
    expect(parseJudgeAnswer('"pdf-forms"', skills)).toBe('pdf-forms');
    expect(parseJudgeAnswer('none', skills)).toBeNull();
    expect(() => parseJudgeAnswer('{"skill": "made-up"}', skills)).toThrow(/could not parse/);
  });

  it('builds a prompt listing every skill', () => {
    const p = buildJudgePrompt('plot this', skills);
    expect(p).toContain('- csv-charts: Plot CSV files. (charts)');
    expect(p).toContain('<user_message>\nplot this\n</user_message>');
  });
});
