#!/bin/sh
# Fix ownership of the data volume (hosts such as Fly.io mount it as root), then run the server
# as the unprivileged "printbee" user.
set -e
chown printbee:printbee "${PRINTBEE_DATA_DIR:-/var/lib/printbee}"
exec setpriv --reuid=printbee --regid=printbee --init-groups "$@"
