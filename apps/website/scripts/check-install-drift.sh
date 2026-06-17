#!/usr/bin/env sh
# Guard against the vendored install script drifting from its canonical source.
#
# public/install.sh is served verbatim at https://orun.dev/install.sh but is
# owned by the orun repo. This check hard-fails when the committed copy differs
# from the canonical script, so a stale copy can never ship. If the canonical
# source can't be reached (offline CI, GitHub blip) it skips rather than fails,
# so it never blocks a deploy on a transient network error.
set -eu

HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
VENDORED="$HERE/../public/install.sh"
CANON_URL="${ORUN_INSTALL_CANON_URL:-https://raw.githubusercontent.com/sourceplane/orun/main/install.sh}"

if [ ! -f "$VENDORED" ]; then
  echo "error: vendored install script is missing: $VENDORED" >&2
  exit 1
fi

TMP="$(mktemp)"
trap 'rm -f "$TMP"' EXIT

if ! curl -fsSL "$CANON_URL" -o "$TMP" 2>/dev/null; then
  echo "warn: could not fetch canonical install script ($CANON_URL); skipping drift check" >&2
  exit 0
fi

if diff -u "$TMP" "$VENDORED" >/dev/null 2>&1; then
  echo "install.sh is in sync with sourceplane/orun"
  exit 0
fi

echo "error: apps/website/public/install.sh has drifted from sourceplane/orun." >&2
echo "       Re-vendor it and commit:  sh apps/website/scripts/sync-install.sh" >&2
echo "--- canonical (sourceplane/orun) vs vendored (this repo) ---" >&2
diff -u "$TMP" "$VENDORED" >&2 || true
exit 1
