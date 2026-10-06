#!/usr/bin/env bash
# Run the daemon's ExUnit suite N times with random seeds while K CPU burners
# load the machine, then tally failures per test. Exits non-zero if any run
# failed, so a timing window that only opens under load shows up on demand.
#
#   scripts/stress-daemon-tests.sh [runs=10] [burners=4] [-- extra mix test args]
#
# Per-run logs land in $STRESS_LOG_DIR (default: a fresh mktemp dir), and the
# summary prints each run's seed, wall time and failure count.
set -euo pipefail

runs=${1:-10}
burners=${2:-4}
shift $(( $# > 2 ? 2 : $# )) || true
[[ "${1:-}" == "--" ]] && shift
extra=("$@")

root=$(cd "$(dirname "$0")/.." && pwd)
log_dir=${STRESS_LOG_DIR:-$(mktemp -d "${TMPDIR:-/tmp}/daemon-stress.XXXXXX")}
mkdir -p "$log_dir"

pids=()
cleanup() {
  for pid in "${pids[@]:-}"; do
    [[ -n "$pid" ]] && kill "$pid" 2>/dev/null || true
  done
}
trap cleanup EXIT INT TERM

for _ in $(seq 1 "$burners"); do
  sh -c 'while :; do :; done' &
  pids+=("$!")
done

cd "$root/daemon"
MIX_ENV=test mix compile --warnings-as-errors >/dev/null

failed_runs=0
for run in $(seq 1 "$runs"); do
  seed=$(( (RANDOM << 15 | RANDOM) % 1000000 ))
  log="$log_dir/run-$run.log"
  start=$(date +%s)
  status=0
  mix test --seed "$seed" ${extra[@]+"${extra[@]}"} >"$log" 2>&1 || status=$?
  wall=$(( $(date +%s) - start ))
  failures=$(grep -Eo '[0-9]+ failures?' "$log" | tail -1 | grep -Eo '[0-9]+' || echo "?")
  if [[ "$status" -ne 0 ]]; then failed_runs=$((failed_runs + 1)); fi
  echo "run $run  seed $seed  ${wall}s  failures ${failures}  exit $status"
done

echo
echo "== per-test failures across $runs runs ($burners burners), logs in $log_dir"
# A failure header is "  N) test <name> (<Module>)", with "file:line" on the next line.
cat "$log_dir"/run-*.log |
  awk '/^ +[0-9]+\) test /{sub(/^ +[0-9]+\) /, ""); name=$0; getline; gsub(/^ +/, ""); print $0 "  " name}' |
  sort | uniq -c | sort -rn || true

exit $(( failed_runs > 0 ))
