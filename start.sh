#!/bin/sh
# BIOBUZZ Learning Studio (viewer + API on :4747, and DSIM alpha on :5173). Nothing trains until you
# press Start in the studio.
#   ./start.sh               in this terminal (close it or press Ctrl-C to stop everything)
#   ./start.sh --install     as a macOS service: starts at login, restarts after a crash, resumes training
#   ./start.sh --background  detached from this terminal (keeps running when it closes)
#   ./start.sh --stop        quit the studio however it runs
#   ./start.sh --status      is it running
#   ./start.sh --uninstall   remove the service
cd "$(dirname "$0")" || exit 1
case "$1" in
  --install|--uninstall|--background|--stop|--status|--supervise) exec "./dsim-main/node_modules/.bin/tsx" train/service.ts "$@" ;;
esac
exec "./dsim-main/node_modules/.bin/tsx" train/studio.ts "$@"
