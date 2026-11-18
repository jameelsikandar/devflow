#!/bin/sh
set -eu
# This shell runs before Node can honor a preload. It never sources environment files.
[ -z "${NODE_OPTIONS-}" ] && [ -z "${NODE_PATH-}" ] || exit 70
unset NODE_OPTIONS NODE_PATH
export HOME=/tmp
case "${1-}" in
  serve) [ "$#" -eq 1 ] || exit 70; exec /usr/local/bin/node /work/rehearsal/controller.cjs serve ;;
  storage-probe) [ "$#" -eq 2 ] || exit 70; exec /usr/local/bin/node /work/rehearsal/storage-probe.cjs "$2" ;;
  *) exit 70 ;;
esac
