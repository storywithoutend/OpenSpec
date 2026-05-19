# OpenSpec Model Eval — Operator Instructions

This repo dogfoods OpenSpec to manage its own changes. We use that archived
trajectory as a dataset for evaluating how well different LLMs can follow a
spec proposal and implement it.

The pipeline:

```
dataset.json  ──►  setup-eval-run.sh ──►  worktree at before_sha
                                           │
                                           ▼
                                       model implements change
                                           │
                                           ▼
                              model.diff   +   golden_patch.py ──► golden.diff
                                           │
                                           ▼
                                   judge (rubric.md) ──► scores
```

## One-time setup

### 1. Clean Claude profile

OpenSpec installs slash commands and agent files into the Claude config dir. We
want those isolated from your main profile so eval runs don't pollute (and
aren't polluted by) your everyday Claude.

Add to `~/.zshrc`:

```bash
alias cc-open-spec='CLAUDE_CONFIG_DIR="$HOME/.claude-openspec" claude --dangerously-skip-permissions'
```

First time `cc-open-spec` runs, it creates `~/.claude-openspec/` fresh — empty
memory, no agents, no MCP servers — and prompts you to authenticate. To wipe
the profile, `rm -rf ~/.claude-openspec`.

### 2. OpenSpec CLI

`setup-eval-run.sh` will install (or upgrade) `@fission-ai/openspec` globally on
first run, so you can skip this — but if you want to do it manually:

```bash
npm install -g @fission-ai/openspec@latest
```

### 3. Dataset

`dataset.json` is already built and committed. To regenerate from the current
git history (useful when new archived changes land):

```bash
python3 scripts/build_eval_dataset.py
```

This writes `dataset.json` (clean entries) and `skipped.json` (entries that
couldn't be cleanly split into proposal vs. implementation commits). Each clean
entry contains `before_sha`, `after_sha`, the list of `implementation_commits`,
the `prompt_paths` for the proposal, and the `golden_code_paths` touched.

## Running an eval

### 1. Start a run

```bash
./scripts/setup-eval-run.sh <slug> <model>
```

`<slug>` is from `dataset.json` (e.g. `add-multi-agent-init`). `<model>` is your
identifier for the model under test (e.g. `claude-opus-4-7`, `gpt-5-mini`).
Model names are normalized to lowercase with `-` separators.

The script:

1. Creates branch `eval/<slug>--<model>` at the entry's `before_sha`.
2. Checks it out as a worktree at `../eval-runs/<slug>--<model>/`.
3. Runs `npm ci` (falling back to `npm install` if the old lockfile drifts).
4. Ensures the latest `@fission-ai/openspec` is on `PATH`.
5. Adds `.claude/` and `.pi/` to the worktree's local git exclude so the
   installed slash commands don't show up in `model.diff` at scoring time.
6. Runs `openspec init --tools claude,pi --force` to install the slash commands
   and skills for both tools in the worktree.

Re-running the same `(slug, model)` pair errors out with cleanup commands.
Re-running the same slug with a different model is fine — different branch.

### 2. Let the model work

```bash
cd ../eval-runs/<slug>--<model>
cc-open-spec
```

In the Claude session, drive the model through OpenSpec's own `apply` workflow:

> /opsx:apply <slug>

That slash command (installed by `openspec init` in step 6 of setup) invokes
`openspec instructions apply --change <slug>` under the hood, which emits the
canonical instructions for implementing the change — the same instructions a
human contributor would follow. This is what we're actually evaluating: how
well the model executes OpenSpec's documented apply procedure.

If you prefer to drive it without the slash command (e.g., for a model that
doesn't have OpenSpec skills installed), the CLI equivalent is:

```bash
openspec instructions apply --change <slug>
```

Pipe that into the model's context and let it work.

While implementing, the model can call `openspec validate <slug>` to self-check,
`openspec show <slug>` to inspect, `openspec status --change <slug>` to see
which tasks remain, etc.

### 3. Capture and score

After the model finishes:

```bash
# Model patch — whatever the model produced from before_sha:
LABEL=<slug>--<model>
git -C ../eval-runs/$LABEL add -A
git -C ../eval-runs/$LABEL diff --staged <before_sha> > /tmp/$LABEL.model.diff

# Golden patch — what actually shipped, code only:
python3 scripts/golden_patch.py <slug> --code-only -o /tmp/<slug>.golden.diff
```

The setup script prints the exact commands for the current run, so you can copy
them straight from its output.

### 4. Run the judge

Feed three things to the judge model:

1. The proposal artifacts at `before_sha` (`openspec/changes/<slug>/`).
2. The golden patch.
3. The model's patch.

Use the prompt in `rubric.md`. The judge returns five 0–4 scores
(`spec_compliance`, `task_coverage`, `scope_discipline`, `convention_fit`,
`correctness`) plus structured notes (missing requirements, missed tasks,
out-of-scope changes, etc.).

Aggregate across runs per the suggestions in `rubric.md` — mean per dimension,
pass rate (`min(scores) >= 3`), and a spec-compliance histogram.

## Files in this eval

| Path | Purpose |
|---|---|
| `dataset.json` | Eval inputs: 28 clean `(slug, before_sha, after_sha, impl_commits)` entries. |
| `skipped.json` | Archived changes that didn't fit the clean pattern, with reason. |
| `rubric.md` | LLM-as-judge prompt template + scoring rubric. |
| `scripts/build_eval_dataset.py` | Regenerates `dataset.json` from git history. |
| `scripts/setup-eval-run.sh` | Worktree + deps + OpenSpec setup for one eval run. |
| `scripts/golden_patch.py` | Emit the golden patch for a slug. |
| `instructions.md` | This file. |

## Known caveats

- **Latest CLI vs. old commit.** The script installs the latest `openspec` CLI,
  but `before_sha` may predate features it exposes. Validators may complain on
  pre-2025-09 entries; pin a contemporary version (`@fission-ai/openspec@x.y.z`)
  if this matters. The 17 entries with `archive_date >= 2025-09-01` are safe.
- **Lockfile drift.** `npm ci` may fail on older commits if `package-lock.json`
  doesn't resolve cleanly under current npm; the script falls back to
  `npm install`, which can produce slightly different `node_modules` than what
  the original developer had. Usually fine for the eval; rerun if tests fail
  for spurious reasons.
- **Multi-commit goldens.** A few dataset entries have 2–4 implementation
  commits (the original PR landed in multiple steps). `golden_patch.py`
  concatenates them in chronological order. The judge sees the full sequence —
  no need to apply them; you're only diffing for scoring.
- **Skipped entries.** 54 of 82 archived changes were skipped because proposal
  and implementation landed in the same commit (no clean "before apply"
  snapshot), or the implementation commits didn't touch the change folder at
  all. See `skipped.json` for the reason on each.

## Cleanup

To remove all eval state:

```bash
# All eval/* worktrees + branches:
git worktree list | awk '/eval\// {print $1}' | xargs -n1 git worktree remove --force
git branch --list 'eval/*' | xargs -n1 git branch -D
rm -rf ../eval-runs

# Clean Claude profile:
rm -rf ~/.claude-openspec
```
