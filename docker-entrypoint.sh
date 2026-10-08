#!/bin/sh
# Entrypoint of the dev-server image (see README "Docker").
#
#   no arguments, `--flags`, or `remote-claude [flags]`: runs the dev-server on the game repo at $TT_GAME_DIR
#       (default /work/game). TT_USERS, when set, is passed as --users; otherwise the ids remembered in the repo are
#       used. TT_IDLE=1 keeps the container up without starting the dev-server (set-up in a terminal).
#   anything else (`claude auth login`, `git status`, `sh`): runs that command as the container user.
set -eu

case "${1:-}" in
  ""|-*|remote-claude)
    if [ "${1:-}" = "remote-claude" ]; then
      shift
    fi
    if [ -n "${TT_IDLE:-}" ]; then
      echo "TT_IDLE is set: the dev-server is not started. Set up in a terminal, then unset TT_IDLE." >&2
      exec sleep infinity
    fi
    if [ -n "${TT_USERS:-}" ]; then
      exec bun /app/src/index.ts remote-claude --repo "${TT_GAME_DIR:-/work/game}" --users "$TT_USERS" "$@"
    fi
    exec bun /app/src/index.ts remote-claude --repo "${TT_GAME_DIR:-/work/game}" "$@"
    ;;
esac

exec "$@"
