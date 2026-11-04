# triggerspec

**Unit tests for skill routing.** `triggerspec` checks that the right [Agent Skill](https://agentskills.io) gets picked for a prompt. It runs offline, it is deterministic, and it is fast enough for every commit. It also tells you, on every pull request, which prompts a description change moved to a different skill.

```text
$ triggerspec diff skills --base-ref origin/main
added skills: tax-helper
descriptions changed: pdf-form-filler

Routing changes (3 of 8 prompts):
  "Fill out this PDF form with my address and phone number"  pdf-form-filler → none  (test of pdf-form-filler)
  "Can you complete the tax form PDF I attached?"  pdf-form-filler → tax-helper  (test of pdf-form-filler)
  ...
Regressions (3): trigger tests that passed on base and fail now
  ✖ pdf-form-filler: should trigger "Can you complete the tax form PDF I attached?" ranked #2; "tax-helper" ranks first
  ...
3 regressions                                                       (exit code 1)
```

An agent picks a skill only from its `name` and `description`. Rewording one description, or adding a new skill, can quietly take prompts away from another skill. triggerspec makes that visible:

| Command | What it does |
|---|---|
| `triggerspec test <dir>` | Runs `should_trigger` / `should_not_trigger` prompts from `triggers.yaml` against **every skill in the folder**. It uses an offline BM25 scorer, with an opt-in LLM judge. |
| `triggerspec diff <dir> --base-ref <ref>` | Routing regression diff against a git ref (or `--base <dir>`). It shows which prompts change winner and which tests regress. |
| `triggerspec collisions <dir>` | Lists pairs of skills whose descriptions compete. It reports TF-IDF similarity, the terms both share, the terms only one has, and tests that are "stolen" by another skill. |
| `triggerspec route <dir> "<prompt>"` | Shows the ranking for one prompt: score, coverage and matched terms. |
| `triggerspec lint <path...>` | Deep lint of `SKILL.md`. It checks the spec fields, links, anchors, mentioned files, orphans, scripts and budgets. |
| `triggerspec check <dir>` | Runs lint, collisions and test together. |

There is one runtime dependency (`yaml`). It needs Node ≥ 18, no API key and no network.

## Install

```bash
npm install --save-dev triggerspec     # or: npx triggerspec lint .
```

> The package has not been published yet. To try it from a checkout, run `npm install && npm run build && node dist/cli.js --help`, or `npm pack` and install the tarball.

## Usage

`<path>` can be a `SKILL.md`, a skill folder, or any folder that contains skill folders. Folders are searched recursively, and `node_modules`/`.git` are skipped. Symlinks and Windows junctions are followed. Each folder is visited once, recognised by its real path or its device and inode numbers, so link loops end. Real folders are searched before linked ones. Depth and folder count are capped, and an unreadable entry (`ELOOP`, `EACCES`, `EPERM`, `ENAMETOOLONG`, …) is skipped with a `path-skipped` info. A leading `~` in a path is expanded to your home folder, so `~/.claude/skills` also works in cmd and PowerShell, which pass `~` through literally.

```bash
triggerspec lint skills/                      # every skill below skills/
triggerspec lint skills/pdf/SKILL.md          # a single skill
triggerspec test skills/                      # trigger tests, offline
triggerspec test skills/ --catalog ~/.claude/skills   # also compete against your installed skills
triggerspec test skills/ --llm                # also ask an LLM judge (needs a key, see below)
triggerspec collisions skills/ --warn-at 0.35
triggerspec route skills/ "fill out this tax form"
triggerspec diff skills/ --base-ref origin/main --prompts extra-prompts.txt
triggerspec check skills/ --json
```

| Option | Meaning |
|---|---|
| `--json` | Writes machine-readable output to stdout. |
| `--fail-on error\|warning` | Severity that makes the exit code 1. The default is `error`. |
| `--verbose` | Also shows `info` findings and passing test cases. |
| `--disable a,b` | Ignores lint rule codes. |
| `--no-exec` | Skips the syntax checks that spawn `python3` / `bash` / `node` / `git`, so lint starts no other program at all. |
| `--spec-only` | Treats Claude Code extension fields as unknown fields. |
| `--max-body-lines` / `--max-body-tokens` | Body budgets. The defaults are 500 and 5000. |
| `--catalog <dir>` | Adds competitor skills. Repeatable. Pairs where both skills come from `--catalog` are never reported. |
| `--threshold 0..1` | Minimum prompt coverage the top skill needs to count as triggered. The default is 0.2. |
| `--only <name>` | Runs one skill's tests. Repeatable. |
| `--warn-at` / `--error-at` | Collision similarity thresholds. The defaults are 0.4 and 0.7. |
| `--base <dir>` / `--base-ref <ref>` / `--prompts <file>` | Inputs for `diff`. `--prompts` takes one prompt per line; lines starting with `#` are comments. |

**Exit codes:** `0` means ok. `1` means lint errors (or warnings with `--fail-on warning`), failed tests, error-level collisions or routing regressions. `2` means a usage or I/O error. `test` also exits 1 when it finds no test file at all, so CI cannot pass by accident.

### In CI

```yaml
- run: npx triggerspec check skills/
- run: npx triggerspec diff skills/ --base-ref origin/${{ github.base_ref }}
  if: github.event_name == 'pull_request'   # needs actions/checkout with fetch-depth: 0
```

`--base-ref` reads only the `SKILL.md` and trigger files at that ref, using `git ls-tree` and `git show`. It writes them to a temp folder and never touches your working tree.

## Trigger test file format

Put `triggers.yaml` next to `SKILL.md`. The file names are looked up in this order: `triggers.yaml`, `triggers.yml`, `triggers.json`, `skill.test.yaml`, `skill.test.yml`, `evals/triggers.json`, `evals/eval_set.json`.

```yaml
threshold: 0.2            # optional; used by test, diff and check for this file unless --threshold is given
should_trigger:
  - Fill out this PDF form with my address
  - prompt: populate the application PDF fields from this JSON
    top: 2                # pass if this skill ranks in the top 2 (default 1 = must win)
should_not_trigger:
  - Merge these two Word documents          # pass if this skill is not selected
  - prompt: Write release notes for v2.3
    expect: release-notes                   # ...and this other skill must win
  - prompt: What's the weather tomorrow?
    expect: none                            # ...and no skill may trigger
```

The eval-set format from Anthropic's **skill-creator** is also accepted as is: `[{"query": "...", "should_trigger": true}, ...]`.

Every prompt is routed against **all** skills under `<path>`, plus any `--catalog` skills, and not just the skill that owns the test. A test only passes when the skill wins against its real neighbours. Failures explain why, for example `ranked #2; "database-assistant" ranks first; coverage 0.44, margin 0.50`.

### How the offline scorer works

- **Routing text.** Each skill is indexed from `name` (tokens weighted ×2), `description` and Claude Code's `when_to_use`. Skills with `disable-model-invocation: true` or without a description are left out, because agents cannot auto-select them.
- **Tokenizer.** Text is NFKC-normalized and lowercased. Stopwords and skill boilerplate are dropped ("use", "skill", "user", "when"…). A light deterministic stemmer is applied. CJK text becomes character bigrams.
- **Ranking.** Skills are ranked by BM25 (k1 = 1.2, b = 0.75). Ties are broken by name, so results are byte-for-byte reproducible.
- **Selection.** The top skill is *selected* only if its **coverage** reaches the threshold. Coverage is the IDF-weighted share of the prompt's terms that appear in the skill's routing text. Words that appear in no skill count against coverage. That is how off-topic prompts end up selecting `none`.

This is a lexical stand-in for an LLM's choice. It is meant as a fast regression signal, not a promise about the model's behaviour. See [Limitations](#limitations).

### Optional LLM judge

`--llm` also asks a model the same question: "which of these skills (or none) should be loaded?". Both verdicts are reported, and a judge failure fails the run.

| Env | Effect |
|---|---|
| `ANTHROPIC_API_KEY` | Uses the Anthropic Messages API. The default model is `claude-haiku-4-5`. `ANTHROPIC_BASE_URL` is optional. |
| `OPENAI_API_KEY` (+ `OPENAI_BASE_URL`) | Uses any OpenAI-compatible `/chat/completions` endpoint (OpenAI, Ollama, vLLM, OpenRouter…). The default model is `gpt-4o-mini`. |
| `TRIGGERSPEC_MODEL`, `--model`, `--provider` | Overrides the model or provider. |

`ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` receive your API key in the request headers, so only point them at endpoints you trust.

If no key is set, the judge is **skipped** with a notice and the exit code depends on the offline results only. Your CI keeps working without secrets.

## Lint checks

Severity is `error` (exit 1), `warning` or `info` (shown with `--verbose`).

| Area | Codes |
|---|---|
| **Frontmatter** | `frontmatter-missing`, `-not-at-start`, `-unterminated`, `-empty`, `-invalid-yaml` (with line and a hint for unquoted `: `), `-not-mapping`, `utf8-bom` ⚠, `crlf-line-endings` ℹ (one aggregated note per run, see below), `skill-file-case` (`skill.md`) |
| **name** | `name-missing`, `-type`, `-too-long` (>64), `-format` (lowercase/digits/hyphens), `-hyphen-edge`, `-consecutive-hyphens`, `-dir-mismatch` (NFKC-compared), `name-whitespace` ⚠, `name-non-ascii` ⚠, `name-reserved-word` ℹ |
| **description** | `description-missing`, `-type`, `-too-long` (>1024 code points), `-too-short` ⚠ (<40), `-angle-brackets` ⚠ (skill-creator's validator rejects `<`/`>`), `hidden-unicode` ⚠, `-no-trigger-context` ℹ |
| **Other fields** | `unknown-field` ⚠ (spec: name, description, license, compatibility, metadata, allowed-tools), `client-extension-field` ℹ (Claude Code: `when_to_use`, `argument-hint`, `disable-model-invocation`, `user-invocable`, `model`, `effort`, `context`, `agent`, `hooks`, `paths`, `shell`, `version`…), `compatibility-type`/`-length` (1-500), `license-type` ⚠, `license-file-missing` ⚠, `metadata-type`, `metadata-value-type` ⚠, `allowed-tools-type`, `allowed-tools-list` ℹ |
| **Body** | `body-empty` ⚠, `body-too-long` ⚠ (>500 lines), `body-too-many-tokens` ⚠ (~5000, estimated; CJK is counted per character), `hidden-unicode` ⚠ (bidi/zero-width characters, with line) |
| **Links** (followed transitively through referenced markdown) | `broken-link` (with a hint when only the letter case differs), `broken-anchor` ⚠ (GitHub slug rules, unicode, percent-encoding), `absolute-path` ⚠, `windows-path-separator` ⚠, `reference-outside-skill` ⚠ (also when the path leaves the skill through a symlink or junction), `link-outside-skill` ℹ (a linked folder that points outside the skill is not scanned), `nested-reference` ℹ (deeper than one level) |
| **Mentioned files** (`python scripts/fill.py`, `references\api.md`, `see FORMS.md`) | `missing-file` ⚠ (suggests `x.py` when the extension was dropped), `path-case-mismatch` ⚠ (`REFERENCE.md` vs `reference.md` works on macOS but breaks on Linux) |
| **Orphans** | `orphan-file` ⚠: a bundled file that nothing reachable from SKILL.md mentions. This understands directory mentions, Python dotted imports, JS relative imports and package folders. LICENSE, manifests, `evals/` and trigger files are exempt. |
| **Scripts** (never executed) | `script-syntax-error` (`python3 -c ast.parse`, `bash -n`, `node --check`; a CRLF script is checked on an LF copy), `script-crlf-committed` ⚠ (the script is stored in git with CRLF, according to `git ls-files --eol`; a CRLF working tree alone is never a warning), `script-not-executable` ℹ, `script-missing-shebang` ℹ, `script-check-skipped` ℹ |
| **Catalog** | `duplicate-name`, `trigger-file-invalid`, `path-skipped` ℹ (link loops, unreadable entries, depth or size limits) |

**CRLF line endings are not a lint problem.** Git for Windows defaults to `core.autocrlf=true`, which writes CRLF into the working tree even though the repo stores LF. triggerspec therefore never warns per file: all CRLF files (SKILL.md, references, scripts) are collapsed into **one** `crlf-line-endings` info that lists them. Scripts only break on Linux/macOS if they are *committed* with CRLF; check that with `git ls-files --eol`.

Links and mentions inside fenced code in *reference* files do not produce `missing-file`, because they usually show the user's project. The same goes for tree drawings and lines like "if `x.mjs` exists". Placeholder links such as `[Title](URL)` or `path/to/file.md` are ignored.

### Field test on `anthropics/skills`

On [anthropics/skills](https://github.com/anthropics/skills) at commit `ca45fc4` (20 skills), `triggerspec lint .` on Linux reports **2 errors, 8 warnings and 20 info**. Every error and warning was checked by hand and is a real issue:

- `claude-api`: the description is 1068 characters (max 1024). The body is 608 lines and about 26k tokens.
- `template`: `name: template-skill` does not match the folder name `template`.
- `pdf`: SKILL.md says `REFERENCE.md` / `FORMS.md`, but the files are `reference.md` / `forms.md`. That breaks on case-sensitive filesystems.
- `pdf/forms.md`: it runs `python scripts/check_fillable_fields`, which has no `.py`. `scripts/create_validation_image.py` is never mentioned anywhere.
- `pptx` (~5013 tokens) and `skill-creator` (~8225 tokens): the bodies are over the 5000-token budget.

The info findings break down as 14 `nested-reference`, 5 `script-not-executable` and 1 `name-reserved-word`. A simulated Windows checkout gives **2 errors, 8 warnings and 17 info**. For that run the tree was converted to CRLF as `core.autocrlf=true` would do, and the run used a case-insensitive filesystem, `platform: win32` and no native bash. The errors and warnings are the same as on Linux. The info findings differ in three ways: the 5 file-mode infos do not appear, one aggregated `crlf-line-endings` info covers all 37 files, and one `script-check-skipped` info is added.

`triggerspec collisions` finds **no** colliding pairs at the default threshold. The closest pair is `algorithmic-art` ↔ `canvas-design` at 0.36.

## How it compares

Several good tools already exist. triggerspec does not try to replace the linters. Its focus is **routing**: offline should/should-not tests across the whole catalog, plus a **routing regression diff between git revisions**. As of 2026-11, none of the tools reviewed below offered that diff.

| Tool | Lint | Trigger tests | Offline / deterministic triggers | Collisions | Routing diff vs git ref |
|---|---|---|---|---|---|
| **triggerspec** | deep (links, anchors, mentions, orphans, scripts) | should / should-not / expect / top-k, judged across the whole folder | ✅ BM25 (+ opt-in LLM) | ✅ similarity + stolen tests | ✅ `diff --base-ref` |
| [skilltest](https://www.npmjs.com/package/skilltest) | ✅ | ✅ LLM-driven trigger precision/recall (`--compare` with similar skills) | seeded, but needs a model | via `--compare` | ❌ |
| [skill-tools](https://www.npmjs.com/package/skill-tools) | ✅ + quality score | ❌ (no test-file runner) | ✅ BM25 `route` | ✅ `route --conflicts` | ❌ (index snapshots only) |
| [@supersuit/superskill](https://www.npmjs.com/package/@supersuit/superskill) | ✅ + maturity levels | ✅ `evals/triggers.json`, run through an agent harness | ❌ | ✅ `collection --overlap` | level regression (`doctor --changed --base`), not routing |
| [@sagargupta1610/skillcheck](https://github.com/Sagargupta16/skillcheck) | ✅ 36 rules, skills-ref parity | scaffold only; runtime execution is on the roadmap | ❌ | ❌ | ❌ |
| [skill-check](https://www.npmjs.com/package/skill-check) | ✅ + security scan | ❌ | ❌ | duplicate name/description | lint baseline / dir diff |
| [agentskills-validate](https://www.npmjs.com/package/agentskills-validate), skills-ref, agnix, agentskills-lint, Swival/skillscheck | ✅ spec / multi-tool lint (skillscheck also does orphans, links, anchors, budgets) | ❌ | ❌ | ❌ | ❌ |

If you only need spec validation, `agentskills-validate` / `skills-ref` is the reference. If you want live model evals, use skilltest or superskill. triggerspec fills the gap in between: it is cheap enough to run on every PR, and it answers the question "did this description change steal or drop prompts?".

## Programmatic API

```ts
import { loadCatalog, runTriggerTests, findCollisions, diffCatalogs, lintSkill, loadSkill, discoverSkills } from 'triggerspec';

const catalog = loadCatalog('skills');
const run = await runTriggerTests(catalog, { threshold: 0.25 });
console.log(run.failed, findCollisions(catalog).pairs);
```

## Limitations

- **The offline scorer is lexical.** It knows nothing about synonyms or paraphrases. "make a PowerPoint deck" does **not** match a description that only says "slides" and "presentation". A passing offline test does not prove that a real model will choose the skill. Use `--llm` for a semantic second opinion, and treat the BM25 result as a regression signal: if a prompt that used to win stops winning, something in the wording changed. The stemmer and stopword list are tuned for English. Other Latin-script languages work at the word level, and CJK works through bigrams.
- **Real agents see more than descriptions.** They also see the conversation, system prompts and the ordering of the skills list. triggerspec only models name, description and `when_to_use`.
- **The LLM judge is a single, temperature-0 classification call per prompt.** It does not run an agent, and results can change between model versions.
- **Mention detection is heuristic.** `missing-file` and `orphan-file` are warnings for that reason. Silence individual rules with `--disable`.
- **Linting untrusted repositories.** Scripts are never run. Python files are parsed by `python3 -I -c ast.parse` (isolated mode, so modules planted next to the scripts are not imported), shell scripts with `bash -n`, and JavaScript with `node --check`. `bash`, `python3`/`python` and `git` are looked up only in trusted places and started by absolute path, without a shell, from a neutral working folder:
  - Only absolute `PATH` entries are searched. Empty, `.` and relative entries are ignored.
  - Entries inside the current folder or a linted folder are ignored, and so is any candidate whose real path lies there.
  - On Windows, the Git for Windows install folders are also searched. The current folder is never searched, which on Windows `where` and CreateProcess would otherwise do.

  As a result, an interpreter installed inside the folder you run from (for example `~/.local/bin` when you lint from `~`) is not used, and the check reports `script-check-skipped`. Use `--no-exec` to start no other program at all.
- **Script checks need the interpreter.** Syntax checks need `python3` / `bash` on PATH; otherwise they report `script-check-skipped`. They only parse scripts and never run them. File-mode checks are skipped on Windows. On Windows the WSL launcher (`C:\Windows\System32\bash.exe`) cannot read Windows paths, so triggerspec prefers a native bash such as Git Bash and skips the shell check when only WSL is available.
- **Windows and macOS letter case.** NTFS and APFS are case-insensitive, so `REFERENCE.md` opens `reference.md` there and breaks only on Linux. triggerspec compares each path segment *below the skill folder* with the real directory listing, so `broken-link` hints, `path-case-mismatch` and `orphan-file` behave the same on every OS. The case you type for the skill path itself is never checked. Names that differ only in Unicode normalization (NFC vs NFD, as on macOS) count as equal.
- **How the Windows and macOS behaviour is tested.** Tests simulate a case-insensitive filesystem and inject the platform, and the CI matrix includes `windows-latest` and `macos-latest`. None of it has been checked by hand on a real NTFS or APFS volume.
- **Token counts are estimates** (about 4 characters per token for ASCII), not a real tokenizer.
- **`diff --base-ref` needs a git checkout** that has the base ref available (`fetch-depth: 0` in GitHub Actions).

## Development

```bash
npm install
npm run typecheck && npm run lint && npm test && npm run build
node dist/cli.js check examples/good
```

`examples/good` contains two clean skills with passing trigger tests. `examples/broken` shows most lint rules at once. `examples/colliding` holds two skills that fight over the same prompts.

## License

MIT © acus9345. The full text is in the `LICENSE` file shipped with the package.
