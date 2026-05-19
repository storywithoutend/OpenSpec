#!/usr/bin/env python3
"""
Emit the golden patch for a dataset entry.

The golden patch is the concatenation of `git show` for each
`implementation_commits[*].sha` in the entry, in chronological order.
This is the trajectory that actually shipped, suitable for feeding to the
LLM-as-judge alongside the model's candidate patch.

usage:
    golden_patch.py <slug>                          # full patch (all paths)
    golden_patch.py <slug> --code-only              # exclude proposal-folder diffs
    golden_patch.py <slug> -o golden.diff           # write to file instead of stdout
"""
from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DATASET = REPO / "dataset.json"


def git_show(sha: str) -> str:
    """Full diff a single commit introduced against its first parent."""
    out = subprocess.run(
        [
            "git",
            "-C", str(REPO),
            "show",
            "--no-renames",
            "--first-parent",
            "-m",
            sha,
        ],
        capture_output=True, text=True, check=True,
    )
    return out.stdout


# A `git show` output has a commit header followed by one or more "diff --git"
# sections, one per file. We split on the section boundary so we can drop
# unwanted paths cleanly.
DIFF_HEADER_RE = re.compile(r"^diff --git a/(\S+) b/(\S+)$", re.MULTILINE)


def filter_paths(diff_text: str, exclude_prefix: str) -> str:
    """Drop diff sections whose `a/` or `b/` path starts with exclude_prefix."""
    # Find every diff section start; keep the preamble (commit header, etc).
    sections: list[tuple[int, str, str]] = []
    for m in DIFF_HEADER_RE.finditer(diff_text):
        sections.append((m.start(), m.group(1), m.group(2)))
    if not sections:
        return diff_text  # nothing to filter
    preamble = diff_text[: sections[0][0]]
    kept = [preamble]
    for i, (start, path_a, path_b) in enumerate(sections):
        end = sections[i + 1][0] if i + 1 < len(sections) else len(diff_text)
        if path_a.startswith(exclude_prefix) and path_b.startswith(exclude_prefix):
            continue
        kept.append(diff_text[start:end])
    return "".join(kept)


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("slug")
    p.add_argument(
        "--code-only",
        action="store_true",
        help="exclude diffs under openspec/changes/<slug>/ (the proposal folder)",
    )
    p.add_argument(
        "-o", "--output",
        help="write to file instead of stdout",
    )
    args = p.parse_args()

    data = json.loads(DATASET.read_text())
    entry = next((e for e in data if e["slug"] == args.slug), None)
    if not entry:
        print(f"error: no dataset entry for slug '{args.slug}'", file=sys.stderr)
        return 1

    exclude_prefix = f"openspec/changes/{args.slug}/" if args.code_only else None

    parts: list[str] = []
    for commit in entry["implementation_commits"]:
        sha = commit["sha"]
        try:
            section = git_show(sha)
        except subprocess.CalledProcessError as e:
            print(f"error: git show {sha} failed: {e.stderr}", file=sys.stderr)
            return 2
        if exclude_prefix:
            section = filter_paths(section, exclude_prefix)
        parts.append(section)

    output = "".join(parts)
    if not output.endswith("\n"):
        output += "\n"

    if args.output:
        Path(args.output).write_text(output)
        print(
            f"wrote {len(output)} bytes to {args.output} "
            f"({len(entry['implementation_commits'])} commit(s))",
            file=sys.stderr,
        )
    else:
        sys.stdout.write(output)

    return 0


if __name__ == "__main__":
    sys.exit(main())
