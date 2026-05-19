---
name: eval-judge
description: Score an OpenSpec eval run for a (slug, model) pair. Runs the worktree's test suite (deterministic eval), then invokes the eval-rubric-judge sub-agent for LLM-as-judge scoring against the rubric, and appends results to eval_results.md at the repo root. Supports an optional repeats count for variance analysis across N independent judge runs. Use when the user wants to score, judge, or evaluate a completed eval run.
---

Run the eval judge for a single (slug, model) pair, optionally repeated N times for variance analysis.

**Prerequisites**
- The eval worktree at `../eval-runs/<slug>--<model>/` exists (created by `./scripts/setup-eval-run.sh <slug> <model>`).
- The model under evaluation has implemented the change in that worktree.
- The `eval-rubric-judge` sub-agent is available at `.claude/agents/eval-rubric-judge.md`.

**Inputs from the user**
- `<slug>` — a `dataset.json` entry, e.g. `add-multi-agent-init`.
- `<model>` — the model identifier passed to `setup-eval-run.sh`, e.g. `claude-opus-4-7`.
- `[repeats]` — optional integer (default `1`). Number of independent judge passes to run. Use `3` or `5` when you want variance bounds on the score.

**Procedure**

Execute these steps in order. Do not skip the sub-agent — its rubric system prompt is what makes scoring rigorous.

1. **Prepare phase.** Run once, regardless of `repeats`:

   ```bash
   python3 .claude/skills/eval-judge/run_judge.py prepare <slug> <model>
   ```

   Prints the path to a `judge_prompt.md` file under a per-(slug, model) tempdir. The deterministic vitest results are stashed in the same tempdir.

2. **Read the judge prompt** with the Read tool. It contains the proposal, the golden patch, and the candidate patch.

3. **Invoke the sub-agent.**
   - If `repeats <= 1`: invoke the `eval-rubric-judge` sub-agent **once** via the Agent tool. Pass the full prompt-file contents as the prompt.
   - If `repeats >= 2`: invoke the sub-agent **N times in parallel** — send all N Agent tool calls in a single message so they execute concurrently. Use the same prompt for each invocation; the variance comes from the model's stochasticity, not from differing inputs.

   The sub-agent returns one JSON object per call.

4. **Save each response to its own temp file.** Use stable filenames like `/tmp/judge-<slug>--<model>-run<i>.json` so the next step can reference them.

5. **Record phase.** Pass every run's JSON to the recorder. Use a separate `--judge-json` flag for each file:

   ```bash
   python3 .claude/skills/eval-judge/run_judge.py record <slug> <model> \
     --judge-json /tmp/judge-<slug>--<model>-run1.json \
     --judge-json /tmp/judge-<slug>--<model>-run2.json \
     --judge-json /tmp/judge-<slug>--<model>-run3.json
   ```

   When `N == 1`, output is the original single-run table. When `N >= 2`, output is an aggregate table with per-run columns, per-dimension Mean and Range, a Total row, each run's `overall_notes`, and a union of issues tagged by run number.

6. **Confirm.** Read the tail of `eval_results.md` and summarize for the user. For multi-run output, lead with the mean total and range; flag any dimension where Range >= 2 (that's where judge variance dominates over model differences).

**On error**

- If `prepare` reports `vitest not found`, the worktree's deps weren't installed — re-run `./scripts/setup-eval-run.sh` for that pair.
- If a sub-agent returns prose instead of JSON, pass the raw response anyway — `record` will store it under `error: parse failed` so that run isn't lost, and other parallel runs will still contribute to the aggregate.
- If the worktree is missing entirely, abort and tell the user to run `setup-eval-run.sh` first.

**Why repeats matter**

Judges are stochastic. A single judge call can drift by 1–2 points on individual dimensions and 2–3 points on the total. With `repeats >= 3` you can distinguish real model differences from judge noise: when Range stays within 1 on a dimension, the score is stable; when Range >= 2, that dimension's score is judge-variance-dominated and needs more samples or rubric tightening.
