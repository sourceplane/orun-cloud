#!/usr/bin/env sh
# Re-vendor public/install.sh from the canonical script in sourceplane/orun.
#
# The install script is owned by the orun repo. This site only serves a copy
# at https://orun.dev/install.sh, so it must stay byte-identical. Run this
# whenever the upstream script changes, then commit the result.
#
#   sh apps/website/scripts/sync-install.sh
#
# Override the source with ORUN_INSTALL_CANON_URL (e.g. a local checkout or a
# pinned ref) when needed.
set -eu

HERE="$(CDPATH= cd "$(dirname "$0")" && pwd)"
DEST="$HERE/../public/install.sh"
SRC="${ORUN_INSTALL_CANON_URL:-https://raw.githubusercontent.com/sourceplane/orun/main/install.sh}"

curl -fsSL "$SRC" -o "$DEST"
echo "Vendored install.sh from $SRC -> $DEST"
