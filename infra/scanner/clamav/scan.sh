#!/bin/sh
set -eu
umask 077
export LC_ALL=C TZ=UTC HOME=/tmp

verdict() {
  printf '{"protocol":"margin-av-inspection-v1","engine":"clamav","engineVersion":"1.4.6","status":"%s"}\n' "$1"
  exit "$2"
}

# The host independently bounds stdin and the container lifetime. Read one extra
# byte so truncation can never turn an oversized document into a clean result.
/usr/bin/head -c 104857601 > /work/input.pdf || exit 20
size=$(/usr/bin/wc -c < /work/input.pdf)
[ "$size" -gt 0 ] && [ "$size" -le 104857600 ] || verdict unsupported 10

# A bounded pipe keeps engine diagnostics entirely inside tmpfs. No document
# text, signatures, embedded names or engine logs are returned to the host.
mkfifo /work/engine-output
/usr/bin/head -c 65537 < /work/engine-output > /work/result &
reader=$!
set +e
/usr/bin/timeout --signal=TERM --kill-after=1s 35s /usr/bin/clamscan \
  --database=/definitions --official-db-only=yes --bytecode-unsigned=no \
  --bytecode-timeout=5000 --fail-if-cvd-older-than=2 \
  --no-summary --stdout --tempdir=/tmp --disable-cache \
  --heuristic-alerts=yes --heuristic-scan-precedence=no \
  --alert-encrypted=yes --alert-exceeds-max=yes \
  --max-filesize=100M --max-scansize=256M --max-files=10000 --max-recursion=16 \
  --max-scantime=0 --follow-dir-symlinks=0 --follow-file-symlinks=0 \
  /work/input.pdf > /work/engine-output 2>&1
result=$?
wait "$reader"
reader_result=$?
set -e
[ "$reader_result" -eq 0 ] || exit 20
[ "$(/usr/bin/wc -c < /work/result)" -lt 65537 ] || verdict resource_limit 10
case "$result" in
  124|137) verdict resource_limit 10 ;;
  0)
    printf '/work/input.pdf: OK\n' > /work/expected
    # Warnings/errors accompanying an apparent success fail closed.
    cmp -s /work/result /work/expected || exit 20
    verdict clean 0
    ;;
  1)
    [ "$(/usr/bin/wc -l < /work/result)" -eq 1 ] || exit 20
    /usr/bin/grep -Eq '^/work/input\.pdf: [A-Za-z0-9_.:-]+ FOUND$' /work/result || exit 20
    if /usr/bin/grep -Eq ': Heuristics\.Limits\.Exceeded([.:-][A-Za-z0-9_.:-]+)? FOUND$' /work/result; then
      verdict resource_limit 10
    fi
    if /usr/bin/grep -Eq ': Heuristics\.Encrypted\.[A-Za-z0-9_.:-]+ FOUND$' /work/result; then
      verdict unsupported 10
    fi
    verdict malware 10
    ;;
  *) exit 20 ;;
esac
