# LLM-as-Judge Rubric for OpenSpec Trajectory Eval

## Setup

Each entry in `dataset.json` corresponds to one archived OpenSpec change. For each
entry, the eval harness runs:

1. **Prepare workspace.** Check out the repo at `before_sha`. The proposal already
   lives in the working tree under `change_folder/` (`proposal.md`, `tasks.md`,
   delta specs under `specs/<capability>/spec.md`).
2. **Run the model.** Give the model the proposal artifacts as the task and the
   repo at `before_sha` as the workspace. The model produces a patch
   (`model_patch`).
3. **Compute the golden patch.** Concatenate `git show <sha>` for every SHA in
   `implementation_commits`. This is `golden_patch`. (Single-commit entries: this
   is exactly `git diff before_sha after_sha`.)
4. **Run the judge.** Pass the proposal artifacts, `golden_patch`, and
   `model_patch` to a judge model with the prompt below. Record the structured
   score.

## Scoring dimensions

The judge returns scores in five dimensions, each on a 0–4 scale. Scores are not
averaged — they are reported per-dimension and aggregated downstream. This avoids
a single overall score that hides which axis a model failed on.

| Dimension | What it measures |
|---|---|
| `spec_compliance` | Does the model's patch satisfy every `ADDED Requirement` and every WHEN/THEN scenario in the delta spec? Missing one scenario costs more than missing a stylistic detail. |
| `task_coverage` | Does the model's patch visibly address each item in `tasks.md`? Ticking off the task list isn't required, but the underlying work must be done. |
| `scope_discipline` | Does the model stay inside the change's intended surface? Out-of-scope refactors, unrelated dependency bumps, and speculative abstractions cost points. |
| `convention_fit` | Does the model's code match neighboring code's conventions — naming, error handling, file layout, test style? Judged against the repo as it exists at `before_sha`, not against the golden. |
| `correctness` | Independent of the golden, is the model's code likely to work? Type errors, obvious logic bugs, missing imports, broken API surface. Tests are scored here if the model wrote any. |

### Scale anchors (apply to every dimension)

- **4 — Meets or exceeds golden.** All requirements satisfied. A reviewer would
  approve without comment.
- **3 — Acceptable with quibbles.** Minor gaps the reviewer would flag in
  comments but not block on (rename a variable, add a missing test case).
- **2 — Partial.** Material work is missing or wrong. The PR is salvageable but
  needs another pass.
- **1 — Wrong shape.** Patch attempts the right thing but misses the spec's
  intent or breaks something important.
- **0 — No real attempt.** Empty patch, placeholder code, or wholly off-task.

### Scoring guardrails

- **Do not penalize for differing from the golden if the model's choice is
  equivalent.** The golden is *a* correct trajectory, not *the* correct one.
  Different filenames, helper function placement, or test phrasing are all OK as
  long as the spec is satisfied.
- **Do penalize when the model omits a requirement the golden implements.** The
  golden is a lower bound on functional completeness — if the spec demands X and
  the model didn't do X, that's a deduction even if its other choices are fine.
- **`correctness` is judged on the model's patch alone**, not by diffing against
  the golden. A patch that ignores the spec but compiles and runs gets a high
  `correctness` and a low `spec_compliance`.

## Judge prompt template

```
You are a senior software engineer reviewing a code change for an open source
TypeScript CLI project called OpenSpec.

You will be given:
  1. The change proposal (`proposal.md`, `tasks.md`, and delta specs under
     `specs/<capability>/spec.md`). These describe the intended behavior.
  2. A "golden" patch — the actual change that was merged and shipped.
  3. A "candidate" patch — produced by a model under evaluation, starting from
     the same repo state and the same proposal.

Score the candidate patch on five 0–4 dimensions. The golden is one valid
solution, not the only one. Reward equivalent-but-different choices; penalize
missing requirements regardless of style.

Return JSON with this exact shape:

{
  "spec_compliance":  {"score": 0-4, "reasoning": "<2-4 sentences>", "missing_requirements": ["<requirement id or title>", ...]},
  "task_coverage":    {"score": 0-4, "reasoning": "<2-4 sentences>", "missed_tasks": ["<task text>", ...]},
  "scope_discipline": {"score": 0-4, "reasoning": "<2-4 sentences>", "out_of_scope_changes": ["<file or change>", ...]},
  "convention_fit":   {"score": 0-4, "reasoning": "<2-4 sentences>", "examples": ["<concrete issue>", ...]},
  "correctness":      {"score": 0-4, "reasoning": "<2-4 sentences>", "likely_bugs": ["<bug description>", ...]},
  "overall_notes":    "<one paragraph: what did the candidate do well, what did it miss>"
}

Scoring anchors:
  4 = meets or exceeds golden
  3 = acceptable, minor PR comments only
  2 = partial; material gaps
  1 = wrong shape; misses spec intent
  0 = no real attempt

=== PROPOSAL ===
<<proposal.md contents>>

=== TASKS ===
<<tasks.md contents>>

=== DELTA SPECS ===
<<each spec.md under change_folder/specs/, concatenated with file headers>>

=== GOLDEN PATCH ===
<<unified diff>>

=== CANDIDATE PATCH ===
<<unified diff>>
```

## Aggregation suggestions

Per-model, per-entry: store the five scores plus the structured fields
(`missing_requirements`, `missed_tasks`, etc.). Per-model overall:

- **Mean per dimension** across all entries.
- **Pass rate** = fraction of entries where `min(scores) >= 3`. This catches
  models that ace four dimensions but bomb one.
- **Spec-compliance histogram** — most important single signal. A model that
  scores 4 on `convention_fit` but 1 on `spec_compliance` is producing
  good-looking wrong code.

## Recommended judge guardrails

- **Two-judge agreement.** Run the judge twice with different models (e.g. one
  Sonnet, one GPT-class) and report per-dimension correlation. If they disagree
  by >1 on a dimension, flag for manual review.
- **Length normalization.** Long candidate patches can fool the judge into
  scoring `task_coverage` higher just from volume. Include in the prompt:
  *"longer patches are not better; reward the smallest patch that satisfies the
  spec"*.
- **No golden leakage into `correctness`.** Make sure the judge's correctness
  reasoning never says "differs from golden" — that's `spec_compliance`'s job.
  Worth spot-checking 20 judgments by hand to validate.
- **Blind ordering.** Sometimes show golden first, sometimes second, to control
  for any ordering bias. (Or relabel them anonymously and shuffle.)

## Variants worth running

- **Behavioral oracle.** When the change includes a test file in
  `golden_code_paths`, you can run those tests against the candidate's patch as
  a fully deterministic check. Use this to calibrate the judge — if 90% of
  candidates that pass tests get `spec_compliance >= 3`, the judge is well
  calibrated.
- **Spec-only prompt vs. spec+repo prompt.** Compare model performance when
  given only the proposal vs. proposal + neighboring code. Tells you how much
  of the gap is "can't read specs" vs. "can't navigate the codebase".
- **Strip the delta specs from the prompt.** A useful ablation: how much worse
  is the model when given only `proposal.md` and no formal spec? Measures
  whether OpenSpec's structured deltas are actually helping.
