#!/bin/sh
# Container entrypoint for MailPouch.
#   daemon (default)  apply MAILPOUCH_* settings, then run the shared HTTP daemon
#   setup-bridge      connect MailPouch to the Bridge container (interactive)
#   anything else     passed to the mailpouch CLI (agent, doctor, status, ...)
set -eu

case "${1:-daemon}" in
  daemon)
    node /app/docker/configure.mjs
    exec mailpouch daemon --host 0.0.0.0 --port "${MAILPOUCH_PORT}" --no-tray --no-settings-ui
    ;;
  setup-bridge)
    shift
    exec node /app/docker/setup-bridge.mjs "$@"
    ;;
  *)
    exec mailpouch "$@"
    ;;
esac
