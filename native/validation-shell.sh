#!/bin/sh
# pnpm lifecycle shell: restore the compatibility library after SIP starts /bin/sh.
# The inherited OS sandbox still denies network, original-project IO and process-group escape.
if [ "$#" -ne 2 ] || [ "$1" != "-c" ] || [ -z "${HCODE_VALIDATION_SHIM:-}" ]; then
  printf '%s\n' 'HCode validation shell requires -c and its host runtime' >&2
  exit 2
fi
exec /bin/sh -c 'export DYLD_INSERT_LIBRARIES="$HCODE_VALIDATION_SHIM"
'"$2" sh
