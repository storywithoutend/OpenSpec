#!/usr/bin/env python3
"""
Eval judge runner — two-phase, designed to be driven by Claude Code's Skill +
Agent tools rather than by direct API calls.

Phase 1 — `prepare`:
    Runs the deterministic eval (vitest in the worktree) and writes the judge
    prompt (proposal + golden patch + candidate patch) plus stashed
    deterministic stats to a tempdir. Prints the path to the judge prompt
    file so the orchestrator (Claude) can feed it to the eval-rubric-judge
    sub-agent via the Agent tool.

Phase 2 — `record`:
    Reads the sub-agent's JSON response from --judge-json (a file path or a
    literal JSON string), pulls deterministic stats from the stash, and
    appends a results section to eval_results.md at the repo root.

usage:
    python3 .claude/skills/eval-judge/run_judge.py prepare <slug> <model>
    python3 .claude/skills/eval-judge/run_judge.py record  <slug> <model> --judge-json <path-or-json>
"""
from __future__ import annotations

import argparse
import datetime
import json
import os
import re
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any, Dict, Tuple

REPO = Path(__file__).resolve().parents[3]
DATASET = REPO / "dataset.json"
RESULTS = REPO / "eval_results.md"
EVAL_RUNS_PARENT = REPO.parent / "eval-runs"

JUDGE_DIMENSIONS = (
    ("spec_compliance", "missing_requirements"),
    ("task_coverage", "missed_tasks"),
    ("scope_discipline", "out_of_scope_changes"),
    ("convention_fit", "examples"),
    ("correctness", "likely_bugs"),
)


def log(msg: str) -> None:
    print(msg, file=sys.stderr)


def normalize_model(m: str) -> str:
    out = re.sub(r"[^a-z0-9._-]", "-", m.lower())
    out = re.sub(r"-+", "-", out).strip("-")
    return out


def stash_dir(slug: str, model_norm: str) -> Path:
    d = Path(tempfile.gettempdir()) / f"eval-judge-{slug}--{model_norm}"
    d.mkdir(parents=True, exist_ok=True)
    return d


def load_entry(slug: str) -> Dict[str, Any]:
    data = json.loads(DATASET.read_text())
    entry = next((e for e in data if e["slug"] == slug), None)
    if not entry:
        sys.exit(f"error: no dataset entry for slug '{slug}'")
    return entry


def get_baseline_sha(worktree: Path, fallback_sha: str) -> str:
    out = subprocess.run(
        ["git", "-C", str(worktree), "log", "--format=%H%x09%s", "-30"],
        capture_output=True, text=True, check=True,
    ).stdout
    for line in out.strip().split("\n"):
        if "\t" not in line:
            continue
        sha, subj = line.split("\t", 1)
        if subj.strip() == "eval: openspec init baseline":
            return sha
    log("    no baseline commit found — falling back to dataset before_sha")
    return fallback_sha


def run_deterministic_eval(worktree: Path) -> Tuple[Dict[str, Any], str]:
    """Run vitest directly (skipping pnpm's deps preflight). Parse summary."""
    start = time.time()
    vitest = worktree / "node_modules" / ".bin" / "vitest"
    if not vitest.exists():
        return {"error": f"vitest not found at {vitest}"}, ""
    proc = subprocess.run(
        [str(vitest), "run"],
        cwd=str(worktree),
        capture_output=True, text=True,
    )
    duration = time.time() - start
    output = proc.stdout + "\n" + proc.stderr

    summary: Dict[str, Any] = {"exit_code": proc.returncode, "duration_s": round(duration, 1)}
    m = re.search(r"Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed.*?\((\d+)\)", output)
    if m:
        summary["tests_failed"] = int(m.group(1) or 0)
        summary["tests_passed"] = int(m.group(2))
        summary["tests_total"] = int(m.group(3))
    m = re.search(r"Test Files\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed.*?\((\d+)\)", output)
    if m:
        summary["files_failed"] = int(m.group(1) or 0)
        summary["files_passed"] = int(m.group(2))
        summary["files_total"] = int(m.group(3))
    return summary, output


def capture_model_diff(worktree: Path, baseline: str) -> str:
    subprocess.run(["git", "-C", str(worktree), "add", "-A"], check=True)
    return subprocess.run(
        ["git", "-C", str(worktree), "diff", "--staged", baseline],
        capture_output=True, text=True, check=True,
    ).stdout


def generate_golden_diff(slug: str) -> str:
    return subprocess.run(
        ["python3", str(REPO / "scripts" / "golden_patch.py"), slug, "--code-only"],
        capture_output=True, text=True, check=True,
    ).stdout


def read_proposal(worktree: Path, slug: str) -> str:
    folder = worktree / "openspec" / "changes" / slug
    parts = []
    for name in ("proposal.md", "tasks.md"):
        p = folder / name
        if p.exists():
            parts.append(f"=== {name} ===\n{p.read_text()}\n")
    specs = folder / "specs"
    if specs.exists():
        for spec_md in sorted(specs.rglob("spec.md")):
            rel = spec_md.relative_to(folder)
            parts.append(f"=== {rel} ===\n{spec_md.read_text()}\n")
    return "\n".join(parts)


JUDGE_PROMPT_TEMPLATE = """Score the candidate model's implementation against the proposal and the golden patch.

Follow the rubric in your system prompt exactly. Return only the JSON object.

=== PROPOSAL ===
{proposal}

=== GOLDEN PATCH ===
{golden_diff}

=== CANDIDATE PATCH ===
{model_diff}
"""


def cmd_prepare(args: argparse.Namespace) -> int:
    entry = load_entry(args.slug)
    model_norm = normalize_model(args.model)
    worktree = EVAL_RUNS_PARENT / f"{args.slug}--{model_norm}"
    if not worktree.exists():
        sys.exit(f"error: worktree not found at {worktree}. Run setup-eval-run.sh first.")

    stash = stash_dir(args.slug, model_norm)
    log(f"==> Prepare: {args.slug} / {model_norm}")
    log(f"    worktree: {worktree}")
    log(f"    stash:    {stash}")

    log("==> Deterministic eval (vitest run)")
    det, _full = run_deterministic_eval(worktree)
    log(f"    {json.dumps(det)}")
    (stash / "deterministic.json").write_text(json.dumps(det, indent=2))

    baseline = get_baseline_sha(worktree, entry["before_sha"])
    log("==> Capturing diffs")
    model_diff = capture_model_diff(worktree, baseline)
    golden_diff = generate_golden_diff(args.slug)
    proposal = read_proposal(worktree, args.slug)
    prompt = JUDGE_PROMPT_TEMPLATE.format(
        proposal=proposal,
        golden_diff=golden_diff,
        model_diff=model_diff,
    )

    prompt_file = stash / "judge_prompt.md"
    prompt_file.write_text(prompt)

    meta = {
        "slug": args.slug,
        "model_raw": args.model,
        "model_norm": model_norm,
        "worktree": str(worktree),
        "baseline": baseline,
        "before_sha": entry["before_sha"],
        "after_sha": entry["after_sha"],
        "prompt_chars": len(prompt),
    }
    (stash / "meta.json").write_text(json.dumps(meta, indent=2))

    log(f"==> Judge prompt: {prompt_file} ({len(prompt):,} chars)")
    log("==> Next: invoke the eval-rubric-judge sub-agent with the prompt file's contents,")
    log("         capture its JSON reply, then run `record` with --judge-json.")
    print(prompt_file)  # stdout: the prompt file path (for scripting)
    return 0


def parse_judge_json(raw: str) -> Dict[str, Any]:
    """Try to parse JSON, tolerating prose around it or a code fence."""
    # Strip markdown code fences if present.
    fenced = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", raw, re.DOTALL)
    if fenced:
        return json.loads(fenced.group(1))
    # Greedy outermost JSON object.
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        raise ValueError(f"no JSON object found in: {raw[:200]}")
    return json.loads(m.group(0))


def _render_single_judge(judge: Dict[str, Any]) -> list:
    """Render the original single-run table; used when only 1 judge run is recorded."""
    lines = []
    if judge.get("skipped"):
        lines.append("_skipped_\n\n")
        return lines
    if judge.get("error"):
        lines.append(f"_error: {judge['error']}_\n\n")
        return lines
    lines.append("| Dimension | Score | Reasoning |\n")
    lines.append("|---|---|---|\n")
    for dim, _key in JUDGE_DIMENSIONS:
        s = judge.get(dim, {}) or {}
        score = s.get("score", "?")
        reasoning = str(s.get("reasoning", "") or "").replace("\n", " ").replace("|", "\\|")
        lines.append(f"| {dim} | {score} | {reasoning} |\n")
    if judge.get("overall_notes"):
        lines.append(f"\n**Overall**: {judge['overall_notes']}\n")
    issue_blocks = []
    for dim, key in JUDGE_DIMENSIONS:
        items = (judge.get(dim, {}) or {}).get(key) or []
        if items:
            issue_blocks.append(f"- **{dim}.{key}**:\n" + "\n".join(f"  - {i}" for i in items))
    if issue_blocks:
        lines.append("\n#### Issues\n\n" + "\n".join(issue_blocks) + "\n")
    return lines


def _render_multi_judge(judges: list) -> list:
    """Render an N-run section with per-dimension means and ranges across runs."""
    n = len(judges)
    lines = []
    valid = [j for j in judges if not (j.get("skipped") or j.get("error"))]
    if not valid:
        lines.append(f"_all {n} runs skipped or errored_\n\n")
        for i, j in enumerate(judges, 1):
            if j.get("error"):
                lines.append(f"- Run {i}: error — {j['error']}\n")
        lines.append("\n")
        return lines

    # Scores table: rows = dimensions, columns = Run 1..N, Mean, Range
    headers = ["Dimension"] + [f"Run {i}" for i in range(1, n + 1)] + ["Mean", "Range"]
    lines.append("| " + " | ".join(headers) + " |\n")
    lines.append("|" + "|".join(["---"] * len(headers)) + "|\n")

    totals = [0.0] * n
    valid_counts = [0] * n

    for dim, _key in JUDGE_DIMENSIONS:
        row_scores: list = []
        numeric: list = []
        for j in judges:
            s = (j.get(dim, {}) or {}).get("score")
            if isinstance(s, (int, float)):
                row_scores.append(str(s))
                numeric.append(float(s))
            else:
                row_scores.append("?")
        if numeric:
            mean = sum(numeric) / len(numeric)
            mean_str = f"{mean:.2f}"
            lo, hi = min(numeric), max(numeric)
            range_str = f"{int(lo) if lo.is_integer() else lo}–{int(hi) if hi.is_integer() else hi}"
        else:
            mean_str = "—"
            range_str = "—"
        lines.append("| " + " | ".join([dim] + row_scores + [mean_str, range_str]) + " |\n")

        # Accumulate totals per run for the bottom row
        for i, j in enumerate(judges):
            s = (j.get(dim, {}) or {}).get("score")
            if isinstance(s, (int, float)):
                totals[i] += float(s)
                valid_counts[i] += 1

    # Totals row (per-run sum across the 5 dimensions)
    total_strs = []
    total_numeric = []
    for i in range(n):
        if valid_counts[i] == len(JUDGE_DIMENSIONS):
            total_strs.append(f"{int(totals[i])}/{len(JUDGE_DIMENSIONS) * 4}")
            total_numeric.append(totals[i])
        else:
            total_strs.append("—")
    if total_numeric:
        mean_total = sum(total_numeric) / len(total_numeric)
        lo, hi = min(total_numeric), max(total_numeric)
        mean_total_str = f"{mean_total:.2f}"
        total_range_str = f"{int(lo) if lo.is_integer() else lo}–{int(hi) if hi.is_integer() else hi}"
    else:
        mean_total_str = "—"
        total_range_str = "—"
    lines.append("| **Total** | " + " | ".join(total_strs) + f" | **{mean_total_str}** | {total_range_str} |\n")

    # Per-run overall_notes
    notes_blocks = []
    for i, j in enumerate(judges, 1):
        notes = (j.get("overall_notes") or "").strip()
        if notes:
            notes_blocks.append(f"**Run {i}**: {notes}")
    if notes_blocks:
        lines.append("\n" + "\n\n".join(notes_blocks) + "\n")

    # Union of all issues across runs, tagged by run
    issue_blocks = []
    for dim, key in JUDGE_DIMENSIONS:
        per_run_items = []
        for i, j in enumerate(judges, 1):
            items = (j.get(dim, {}) or {}).get(key) or []
            for it in items:
                per_run_items.append(f"  - (run {i}) {it}")
        if per_run_items:
            issue_blocks.append(f"- **{dim}.{key}**:\n" + "\n".join(per_run_items))
    if issue_blocks:
        lines.append("\n#### Issues (union across runs)\n\n" + "\n".join(issue_blocks) + "\n")

    return lines


def append_results(slug: str, model_raw: str, det: Dict[str, Any], judges, meta: Dict[str, Any]) -> None:
    """Append a results section to eval_results.md.

    `judges` may be either a single dict (single-run mode) or a list of dicts
    (multi-run mode). Multi-run mode renders an aggregate table with mean/range
    across runs.
    """
    if isinstance(judges, dict):
        judges_list = [judges]
    else:
        judges_list = list(judges)
    n = len(judges_list)

    now = datetime.datetime.now().isoformat(timespec="seconds")
    title_suffix = f" ({n} runs)" if n > 1 else ""
    lines: list = []
    lines.append(f"\n## {now} — {slug} / {model_raw}{title_suffix}\n\n")
    lines.append(f"- worktree: `{meta.get('worktree','')}`\n")
    lines.append(f"- baseline: `{meta.get('baseline','')}`\n")
    lines.append(f"- before_sha: `{meta.get('before_sha','')}` | after_sha: `{meta.get('after_sha','')}`\n")
    lines.append(f"- judge: eval-rubric-judge sub-agent\n\n")

    lines.append("### Deterministic eval\n\n")
    if det.get("skipped"):
        lines.append("_skipped_\n\n")
    elif det.get("error"):
        lines.append(f"_error: {det['error']}_\n\n")
    else:
        for k in ("exit_code", "duration_s", "tests_passed", "tests_failed", "tests_total",
                  "files_passed", "files_failed", "files_total"):
            if k in det:
                lines.append(f"- {k}: {det[k]}\n")
        lines.append("\n")

    header_suffix = f" — {n} runs" if n > 1 else ""
    lines.append(f"### LLM-as-judge{header_suffix}\n\n")
    if n == 1:
        lines.extend(_render_single_judge(judges_list[0]))
    else:
        lines.extend(_render_multi_judge(judges_list))

    if RESULTS.exists():
        existing = RESULTS.read_text()
    else:
        existing = (
            "# Eval Results\n\n"
            "Appended chronologically by the `eval-judge` skill.\n"
            "See `instructions.md` for the eval pipeline and `rubric.md` for the scoring criteria.\n"
        )
    RESULTS.write_text(existing + "".join(lines))


def cmd_record(args: argparse.Namespace) -> int:
    model_norm = normalize_model(args.model)
    stash = stash_dir(args.slug, model_norm)
    if not (stash / "meta.json").exists():
        sys.exit(f"error: no stashed run at {stash}. Run `prepare` first.")
    meta = json.loads((stash / "meta.json").read_text())
    det = json.loads((stash / "deterministic.json").read_text()) if (stash / "deterministic.json").exists() else {"error": "no deterministic.json in stash"}

    raw_list = args.judge_json
    if not raw_list:
        sys.exit("error: --judge-json required (path to file or literal JSON); pass multiple for an N-run aggregate")

    judges: list = []
    for raw in raw_list:
        if os.path.isfile(raw):
            raw_text = Path(raw).read_text()
        else:
            raw_text = raw
        try:
            judges.append(parse_judge_json(raw_text))
        except (ValueError, json.JSONDecodeError) as e:
            log(f"warning: could not parse judge JSON from {raw[:80]} ({e}); storing raw")
            judges.append({"error": f"parse failed: {e}", "raw": raw_text[:1000]})

    append_results(args.slug, args.model, det, judges, meta)
    log(f"==> Appended {len(judges)} run(s) to {RESULTS}")
    return 0


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)

    pp = sub.add_parser("prepare", help="run deterministic eval and emit judge prompt")
    pp.add_argument("slug")
    pp.add_argument("model")
    pp.set_defaults(func=cmd_prepare)

    pr = sub.add_parser("record", help="record sub-agent's judge JSON(s) into eval_results.md")
    pr.add_argument("slug")
    pr.add_argument("model")
    pr.add_argument(
        "--judge-json",
        required=True,
        action="append",
        help="path to JSON file or literal JSON string. Pass multiple times (one per --judge-json flag) to record an N-run aggregate with mean/range.",
    )
    pr.set_defaults(func=cmd_record)

    args = p.parse_args()
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
