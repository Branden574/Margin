#!/bin/sh
set -eu
umask 077
export LC_ALL=C TZ=UTC HOME=/tmp
# Only the updater receives network access and a writable staging database mount.
# It never receives a document, application configuration or credentials.
/usr/bin/freshclam --config-file=/opt/margin/freshclam.conf --stdout
for database in bytecode daily main; do
  /usr/bin/sigtool --info="/definitions/$database.cvd"
done
