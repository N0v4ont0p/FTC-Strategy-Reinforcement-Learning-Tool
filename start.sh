#!/bin/sh
# Starts the BIOBUZZ Evolution Studio (viewer + API on :4747) and DSIM (alpha, :5173).
# Nothing trains until you press Start in the studio. Close this terminal or press Ctrl-C to stop all.
cd "$(dirname "$0")" || exit 1
exec "./dsim-main/node_modules/.bin/tsx" train/studio.ts "$@"
