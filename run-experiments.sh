#!/usr/bin/env bash
# Run 5 build experiments and capture per-endpoint API peaks.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$ROOT/api"
APP_DIR="$ROOT/app"
LOG_DIR="$ROOT/experiment-logs"
mkdir -p "$LOG_DIR"

variants=("baseline" "cpus1" "maxConc1" "minPages999" "combo")

results_file="$LOG_DIR/results.tsv"
printf "variant\tpeakAll\tpeakList\tpeakDetail\ttotalRequests\tbuildTimeMs\n" > "$results_file"

for v in "${variants[@]}"; do
  echo "=== variant=$v ==="

  api_log="$LOG_DIR/api-$v.log"
  build_log="$LOG_DIR/build-$v.log"
  result_file="$LOG_DIR/result-$v.json"
  : > "$api_log"
  : > "$build_log"
  rm -f "$result_file"

  # Start API server (use `exec` so api_pid is the node PID, not the subshell's)
  (cd "$API_DIR" && exec env COMPANIES=12 PRODUCTS_PER_COMPANY=10 RESPONSE_DELAY_MS=100 \
    RESULT_FILE="$result_file" node server.js) \
    > "$api_log" 2>&1 &
  api_pid=$!

  # Wait for "[API]" listen log
  for _ in $(seq 1 30); do
    if grep -q '^\[API\]' "$api_log" 2>/dev/null; then
      break
    fi
    sleep 0.1
  done

  # Run build
  (cd "$APP_DIR" && rm -rf .next out)
  start_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  (cd "$APP_DIR" && CONFIG_VARIANT="$v" COMPANIES=12 PRODUCTS_PER_COMPANY=10 \
    API_URL=http://localhost:3001 npm run build) > "$build_log" 2>&1
  end_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  build_ms=$((end_ms - start_ms))

  # Stop API and wait for it to write result file
  kill -TERM "$api_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true

  if [[ ! -f "$result_file" ]]; then
    echo "ERROR: $result_file was not produced. api log:"
    cat "$api_log"
    exit 1
  fi

  peak_all=$(node -e "const j=require('$result_file');process.stdout.write(String(j.peak))")
  peak_list=$(node -e "const j=require('$result_file');process.stdout.write(String(j.peakList))")
  peak_detail=$(node -e "const j=require('$result_file');process.stdout.write(String(j.peakDetail))")
  total=$(node -e "const j=require('$result_file');process.stdout.write(String(j.totalRequests))")

  printf "%s\t%s\t%s\t%s\t%s\t%s\n" "$v" "$peak_all" "$peak_list" "$peak_detail" "$total" "$build_ms" >> "$results_file"
  echo "  peakAll=$peak_all peakList=$peak_list peakDetail=$peak_detail total=$total buildMs=$build_ms"
  echo
done

echo "=== results ==="
column -t -s $'\t' "$results_file"
