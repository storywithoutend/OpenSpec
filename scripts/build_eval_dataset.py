#!/usr/bin/env python3
"""
Extract eval (before_sha, after_sha) pairs from OpenSpec's own archived changes.

A clean entry requires:
  - The archive folder openspec/changes/archive/<date>-<slug>/ exists.
  - The change folder openspec/changes/<slug>/ has at least one "proposal-only"
    commit (only touches openspec/changes/<slug>/**) chronologically followed by
    at least one "implementation" commit (also touches paths outside that folder).
  - All implementation commits are contiguous in linear history (no unrelated
    commits interleaved between them on the first-parent chain).

For each clean entry we record:
  before_sha            = last proposal-only commit before first implementation
  after_sha             = last implementation commit before archive
  implementation_commits = list of implementation SHAs (chronological)
  archive_sha           = commit that introduced the archive folder

Anything that doesn't fit the clean pattern goes into skipped.json with a reason.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
from pathlib import Path
from typing import List, Optional, Tuple

REPO = Path(__file__).resolve().parent.parent
ARCHIVE_ROOT = REPO / "openspec" / "changes" / "archive"


def run(args: List[str]) -> str:
    return subprocess.run(
        args, cwd=REPO, capture_output=True, text=True, check=True
    ).stdout


def list_archived_changes() -> List[Tuple[str, str, str]]:
    entries = []
    for name in sorted(os.listdir(ARCHIVE_ROOT)):
        full = ARCHIVE_ROOT / name
        if not full.is_dir():
            continue
        m = re.match(r"^(\d{4}-\d{2}-\d{2})-(.+)$", name)
        if not m:
            continue
        entries.append((m.group(1), m.group(2), name))
    return entries


def find_archive_commit(archive_subdir: str) -> Optional[str]:
    """Earliest commit that added files under the archive path."""
    path = f"openspec/changes/archive/{archive_subdir}/"
    out = run(
        [
            "git",
            "log",
            "--all",
            "--no-renames",
            "--diff-filter=A",
            "--format=%H",
            "--",
            path,
        ]
    )
    shas = [s for s in out.strip().split("\n") if s]
    if not shas:
        return None
    return shas[-1]  # `git log` is newest-first; earliest is last


def folder_history(slug: str) -> List[Tuple[str, List[str], str, int]]:
    """Chronological list of (sha, ALL_paths_in_commit, subject, author_ts) for commits that touched the pre-archive folder."""
    path = f"openspec/changes/{slug}/"
    # First: SHAs of commits that touched anything under the folder.
    out = run(
        [
            "git",
            "log",
            "--all",
            "--no-renames",
            "--format=%H%x09%at%x09%s",
            "--",
            path,
        ]
    )
    rows: List[Tuple[str, int, str]] = []
    for line in out.strip().split("\n"):
        if not line:
            continue
        parts = line.split("\t", 2)
        sha = parts[0]
        ts = int(parts[1]) if len(parts) > 1 else 0
        subj = parts[2] if len(parts) > 2 else ""
        rows.append((sha, ts, subj))

    # For each, get the full set of paths that commit touched (not filtered to the folder).
    commits: List[Tuple[str, List[str], str, int]] = []
    for sha, ts, subj in rows:
        try:
            paths_out = run(
                [
                    "git",
                    "show",
                    "--no-renames",
                    "--name-only",
                    "--pretty=format:",
                    "-m",  # for merge commits, list paths against first parent
                    "--first-parent",
                    sha,
                ]
            )
        except subprocess.CalledProcessError:
            paths_out = ""
        paths = sorted({p for p in paths_out.strip().split("\n") if p})
        commits.append((sha, paths, subj, ts))
    return list(reversed(commits))  # chronological order


def classify(paths: List[str], slug: str) -> Tuple[bool, bool]:
    """Return (proposal_only, touches_archive).

    proposal_only = every changed path is inside openspec/ (meta-only),
    which includes both the per-change folders and the canonical specs.
    Implementation commits, by contrast, touch code/tests/config outside openspec/.
    """
    archive_prefix = "openspec/changes/archive/"
    proposal_only = bool(paths) and all(p.startswith("openspec/") for p in paths)
    has_archive = any(p.startswith(archive_prefix) for p in paths)
    return proposal_only, has_archive


def parent_of(sha: str) -> str:
    return run(["git", "rev-parse", f"{sha}^"]).strip()


def diff_paths(sha_a: str, sha_b: str) -> List[str]:
    out = run(["git", "diff", "--name-only", sha_a, sha_b])
    return [p for p in out.strip().split("\n") if p]


def commits_on_first_parent_between(sha_a: str, sha_b: str) -> List[str]:
    """Commits on the first-parent chain from sha_a (exclusive) to sha_b (inclusive)."""
    out = run(["git", "rev-list", "--first-parent", f"{sha_a}..{sha_b}"])
    return [s for s in out.strip().split("\n") if s]


def main():
    dataset = []
    skipped = []
    for date, slug, archive_subdir in list_archived_changes():
        archive_sha = find_archive_commit(archive_subdir)
        if not archive_sha:
            skipped.append(
                {
                    "slug": slug,
                    "archive_dir": archive_subdir,
                    "reason": "no archive commit found",
                }
            )
            continue

        commits = folder_history(slug)
        # Drop commits that touch the archive path (those are the archive commit itself).
        commits = [c for c in commits if not classify(c[1], slug)[1]]
        if not commits:
            skipped.append(
                {
                    "slug": slug,
                    "archive_dir": archive_subdir,
                    "reason": "no pre-archive commits on change folder",
                }
            )
            continue

        # Split chronologically into proposal-only vs implementation
        first_impl_idx = None
        for i, (sha, paths, _subj, _ts) in enumerate(commits):
            only_folder, _ = classify(paths, slug)
            if not only_folder:
                first_impl_idx = i
                break

        if first_impl_idx is None:
            skipped.append(
                {
                    "slug": slug,
                    "archive_dir": archive_subdir,
                    "reason": "no implementation commit found on this folder (implementation likely landed elsewhere)",
                    "commit_count": len(commits),
                }
            )
            continue

        if first_impl_idx == 0:
            skipped.append(
                {
                    "slug": slug,
                    "archive_dir": archive_subdir,
                    "reason": "first commit is already an implementation commit (no proposal-only state)",
                }
            )
            continue

        before_sha = commits[first_impl_idx - 1][0]
        impl_commits = [
            (sha, subj, ts)
            for (sha, paths, subj, ts) in commits[first_impl_idx:]
            if not classify(paths, slug)[0]  # implementation = NOT proposal-only
        ]
        # Drop any commits that also somehow touched archive (defensive)
        impl_commits = [c for c in impl_commits if c[0] != archive_sha]
        if not impl_commits:
            skipped.append(
                {
                    "slug": slug,
                    "archive_dir": archive_subdir,
                    "reason": "no implementation commits after split",
                }
            )
            continue
        after_sha = impl_commits[-1][0]

        # Determine code paths touched by implementation commits (only those commits,
        # so we don't pick up unrelated PRs that landed concurrently between before/after).
        impl_paths = set()
        for sha, _subj, _ts in impl_commits:
            try:
                paths_out = run(
                    [
                        "git",
                        "show",
                        "--no-renames",
                        "--name-only",
                        "--pretty=format:",
                        "-m",
                        "--first-parent",
                        sha,
                    ]
                )
            except subprocess.CalledProcessError:
                paths_out = ""
            for p in paths_out.strip().split("\n"):
                if p:
                    impl_paths.add(p)
        code_paths = sorted(p for p in impl_paths if not p.startswith("openspec/"))
        change_prefix = f"openspec/changes/{slug}/"

        # Prompt paths: the proposal artifacts at before_sha (under the pre-archive folder).
        ls_tree = run(["git", "ls-tree", "-r", "--name-only", before_sha, change_prefix])
        prompt_paths = sorted(
            [p for p in ls_tree.strip().split("\n") if p and p.startswith(change_prefix)]
        )

        dataset.append(
            {
                "slug": slug,
                "archive_date": date,
                "change_folder": change_prefix.rstrip("/"),
                "archive_folder": f"openspec/changes/archive/{archive_subdir}",
                "before_sha": before_sha,
                "after_sha": after_sha,
                "archive_sha": archive_sha,
                "implementation_commits": [
                    {"sha": sha, "subject": subj} for (sha, subj, _ts) in impl_commits
                ],
                "prompt_paths": prompt_paths,
                "golden_code_paths": code_paths,
            }
        )

    dataset.sort(key=lambda e: e["archive_date"])
    out_dataset = REPO / "dataset.json"
    out_skipped = REPO / "skipped.json"
    out_dataset.write_text(json.dumps(dataset, indent=2) + "\n")
    out_skipped.write_text(json.dumps(skipped, indent=2) + "\n")
    print(f"clean entries: {len(dataset)}")
    print(f"skipped:       {len(skipped)}")
    print(f"wrote {out_dataset}")
    print(f"wrote {out_skipped}")


if __name__ == "__main__":
    main()
