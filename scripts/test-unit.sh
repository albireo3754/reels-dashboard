#!/bin/sh
# npm test runs the unit suite; explicit file arguments run only that selection.
set -eu
# Node's implicit discovery also walks Playwright and helper files.
has_selection=false
for argument do
  case "$argument" in
    *.test.ts | tests/*) has_selection=true ;;
  esac
done
if [ "$has_selection" = false ]; then
  set -- "$@" tests/unit/*.test.ts
fi
# Isolated test processes share V8 bytecode. Coverage runs need freshly compiled functions.
case "${NODE_OPTIONS:-} $*" in
  *--experimental-test-coverage* | *--test-coverage*) ;;
  *)
    if [ -z "${NODE_V8_COVERAGE:-}" ]; then
      export NODE_COMPILE_CACHE="${NODE_COMPILE_CACHE:-$PWD/node_modules/.cache/reels-dashboard/node-compile}"
    fi
    ;;
esac
exec node --import tsx --test --test-concurrency="${REELS_TEST_WORKERS:-2}" "$@"
