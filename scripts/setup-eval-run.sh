#!/usr/bin/env bash
#
# setup-eval-run.sh <slug> <model>
#
# Prepare an eval run for one (dataset entry, model) pair.
#   1. Branch eval/<slug>--<model> at the entry's before_sha
#   2. Worktree at ../eval-runs/<slug>--<model>/
#   3. npm dependencies installed
#   4. Latest @fission-ai/openspec on PATH (global)
#
# The combined (slug, model) key makes each run unique — re-using the same
# slug for a different model is fine; re-using both will refuse to clobber.
#
# After this you can:
#   cd ../eval-runs/<slug>--<model>
#   cc-open-spec
#   # in Claude: implement the change in openspec/changes/<slug>/
#
set -euo pipefail

usage() {
    echo "usage: $(basename "$0") <slug> <model>" >&2
    echo "  <slug>   one of the slugs in dataset.json (e.g. add-multi-agent-init)" >&2
    echo "  <model>  identifier for the model under eval (e.g. claude-opus-4-7)" >&2
    exit 1
}

[[ $# -eq 2 ]] || usage
SLUG="$1"
MODEL_RAW="$2"

# Normalize model: lowercase, swap any non-[a-z0-9._-] to '-'.
MODEL="$(printf '%s' "$MODEL_RAW" \
    | tr '[:upper:]' '[:lower:]' \
    | sed 's/[^a-z0-9._-]/-/g' \
    | sed 's/--*/-/g' \
    | sed 's/^-//; s/-$//')"
if [[ -z "$MODEL" ]]; then
    echo "error: model name is empty after normalization" >&2
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(git -C "$SCRIPT_DIR" rev-parse --show-toplevel)"
DATASET="$REPO_ROOT/dataset.json"

if [[ ! -f "$DATASET" ]]; then
    echo "error: $DATASET not found. Run scripts/build_eval_dataset.py first." >&2
    exit 1
fi

# Look up before_sha and after_sha.
read -r BEFORE_SHA AFTER_SHA <<<"$(
    SLUG="$SLUG" DATASET="$DATASET" python3 - <<'PY'
import json, os, sys
slug = os.environ['SLUG']
data = json.load(open(os.environ['DATASET']))
entry = next((e for e in data if e['slug'] == slug), None)
if not entry:
    sys.stderr.write(f"error: no dataset entry for slug '{slug}'\n")
    sample = ', '.join(sorted(e['slug'] for e in data)[:5])
    sys.stderr.write(f"first few available: {sample}, ...\n")
    sys.exit(1)
print(entry['before_sha'], entry['after_sha'])
PY
)"

LABEL="$SLUG--$MODEL"
BRANCH="eval/$LABEL"
WORKTREE_PARENT="$(cd "$REPO_ROOT/.." && pwd)/eval-runs"
WORKTREE="$WORKTREE_PARENT/$LABEL"

if git -C "$REPO_ROOT" show-ref --verify --quiet "refs/heads/$BRANCH"; then
    cat >&2 <<EOF
error: branch '$BRANCH' already exists.
To re-create from scratch:
  git -C $REPO_ROOT worktree remove --force $WORKTREE 2>/dev/null || true
  git -C $REPO_ROOT branch -D $BRANCH
  rm -rf $WORKTREE
EOF
    exit 1
fi

mkdir -p "$WORKTREE_PARENT"

echo "==> Creating worktree"
echo "    slug:       $SLUG"
echo "    model:      $MODEL"
echo "    branch:     $BRANCH"
echo "    before_sha: $BEFORE_SHA"
echo "    worktree:   $WORKTREE"
git -C "$REPO_ROOT" worktree add -b "$BRANCH" "$WORKTREE" "$BEFORE_SHA"

cd "$WORKTREE"

echo
echo "==> Installing repo dependencies"
# This repo's `prepare` script invokes pnpm. Use pnpm directly when there's a
# pnpm-lock.yaml. pnpm exits non-zero on ERR_PNPM_IGNORED_BUILDS (a postinstall
# warning, e.g. for esbuild) even when deps install fine — we verify success by
# checking that node_modules ends up populated.
install_with_pnpm() {
    local pnpm_cmd
    if command -v pnpm >/dev/null 2>&1; then
        pnpm_cmd=(pnpm)
    else
        pnpm_cmd=(corepack pnpm)
    fi
    "${pnpm_cmd[@]}" install --frozen-lockfile 2>&1 || \
        "${pnpm_cmd[@]}" install 2>&1 || true
}

if [[ -f pnpm-lock.yaml ]]; then
    install_with_pnpm >/dev/null
    if [[ ! -d node_modules ]] || [[ -z "$(ls -A node_modules 2>/dev/null)" ]]; then
        echo "    error: node_modules is empty after pnpm install" >&2
        exit 1
    fi
    echo "    pnpm install ok (node_modules populated)"
else
    npm ci 2>/dev/null || npm install
fi

echo
echo "==> Ensuring latest @fission-ai/openspec is on PATH"
if command -v openspec >/dev/null 2>&1; then
    CURRENT="$(openspec --version 2>/dev/null || echo unknown)"
    LATEST="$(npm view @fission-ai/openspec version 2>/dev/null || echo unknown)"
    if [[ "$CURRENT" != "$LATEST" && "$LATEST" != "unknown" ]]; then
        echo "    found openspec $CURRENT, upgrading to $LATEST"
        npm install -g "@fission-ai/openspec@latest"
    else
        echo "    openspec $CURRENT already installed"
    fi
else
    echo "    installing @fission-ai/openspec globally"
    npm install -g "@fission-ai/openspec@latest"
fi

OPENSPEC_VERSION="$(openspec --version 2>/dev/null || echo unknown)"

echo
echo "==> Installing OpenSpec slash commands & skills for claude + pi"
# Worktrees only honor info/exclude in the common gitdir, not the per-worktree
# one. Write there. (.pi/ doesn't exist in main, so this is a no-op for it.)
COMMON_GITDIR="$(git -C "$WORKTREE" rev-parse --git-common-dir)"
EXCLUDE="$COMMON_GITDIR/info/exclude"
mkdir -p "$(dirname "$EXCLUDE")"
for p in '.claude/' '.pi/'; do
    grep -qxF "$p" "$EXCLUDE" 2>/dev/null || echo "$p" >>"$EXCLUDE"
done

openspec init --tools claude,pi --force

# openspec init mutates tracked files (removes legacy openspec/AGENTS.md,
# strips markers from AGENTS.md, drops in openspec/config.yaml, etc.). Commit
# that state to the eval branch so the model starts from a clean working tree
# and its diff doesn't pick up init's noise.
echo
echo "==> Committing post-init baseline"
cd "$WORKTREE"
git add -A
if git diff --cached --quiet; then
    echo "    (no changes to commit)"
    BASELINE_SHA="$BEFORE_SHA"
else
    git -c user.email=eval@local -c user.name=eval-setup \
        commit --no-verify -m "eval: openspec init baseline" >/dev/null
    BASELINE_SHA="$(git rev-parse HEAD)"
    echo "    baseline commit: $BASELINE_SHA"
fi

cat <<EOF

==> Ready.

  Slug:            $SLUG
  Model:           $MODEL
  Worktree:        $WORKTREE
  Branch:          $BRANCH
  before_sha:      $BEFORE_SHA  (dataset entry baseline)
  baseline:        $BASELINE_SHA  (post-init — diff model work against this)
  Golden after:    $AFTER_SHA  (do NOT peek before scoring)
  OpenSpec CLI:    $OPENSPEC_VERSION (global)
  Tools installed: claude (.claude/), pi (.pi/) — both gitignored locally
  Proposal:        $WORKTREE/openspec/changes/$SLUG/

Next steps:
  cd $WORKTREE
  cc-open-spec
  # in Claude: implement the change in openspec/changes/$SLUG/

Capture and score (after the model finishes):
  # Model patch — diff against the post-init baseline, not the dataset before_sha:
  git -C $WORKTREE add -A
  git -C $WORKTREE diff --staged $BASELINE_SHA > /tmp/$LABEL.model.diff

  # Golden patch (code only, no proposal-folder churn):
  python3 $REPO_ROOT/scripts/golden_patch.py $SLUG --code-only -o /tmp/$SLUG.golden.diff

  # Feed both diffs + the proposal artifacts to the judge per rubric.md.
EOF
