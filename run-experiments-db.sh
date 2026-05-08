#!/usr/bin/env bash
# Run DB-backed build experiments and capture pool-wait + DB connection metrics.
# Requires Postgres to already be running (docker compose up -d).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
API_DIR="$ROOT/api"
APP_DIR="$ROOT/app"
LOG_DIR="$ROOT/experiment-logs"
mkdir -p "$LOG_DIR"

# Each scenario is: name|SEMAPHORE_LIMIT|DB_POOL_MAX|DB_POOL_TIMEOUT_MS|PG_MAX_CONNECTIONS
scenarios=(
  "db-noLimit|0|5|10000|100"
  "db-sem2|2|5|10000|100"
  "db-pgMax15|0|30|10000|15"
)

results_file="$LOG_DIR/results-db.tsv"
printf "scenario\tsemLimit\tpoolMax\tpgMax\tpeakAll\trejected503\tpoolTimeouts\tdbConnectErrors\twaitAvgMs\twaitP95Ms\twaitMaxMs\tbuildOk\tbuildTimeMs\n" > "$results_file"

current_pg_max=""

for s in "${scenarios[@]}"; do
  IFS='|' read -r name sem_limit pool_max pool_timeout pg_max <<< "$s"
  echo "=== $name (sem=$sem_limit poolMax=$pool_max pgMax=$pg_max) ==="

  api_log="$LOG_DIR/api-$name.log"
  build_log="$LOG_DIR/build-$name.log"
  result_file="$LOG_DIR/result-$name.json"
  : > "$api_log"
  : > "$build_log"
  rm -f "$result_file"

  # Restart Postgres if max_connections changed
  if [[ "$pg_max" != "$current_pg_max" ]]; then
    echo "  restarting postgres with max_connections=$pg_max"
    PG_MAX_CONNECTIONS="$pg_max" docker compose up -d --force-recreate postgres > /dev/null
    until docker compose ps --format json | grep -q '"Health":"healthy"'; do sleep 1; done
    current_pg_max="$pg_max"
  fi

  (cd "$API_DIR" && exec env \
      COMPANIES=12 PRODUCTS_PER_COMPANY=10 RESPONSE_DELAY_MS=100 \
      DB_POOL_MAX="$pool_max" DB_POOL_TIMEOUT_MS="$pool_timeout" \
      RESULT_FILE="$result_file" node server-db.js) \
    > "$api_log" 2>&1 &
  api_pid=$!

  for _ in $(seq 1 60); do
    if grep -q '^\[API-DB\]' "$api_log" 2>/dev/null; then
      break
    fi
    sleep 0.2
  done

  (cd "$APP_DIR" && rm -rf .next out)
  start_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  build_ok="yes"
  (cd "$APP_DIR" && SEMAPHORE_LIMIT="$sem_limit" COMPANIES=12 PRODUCTS_PER_COMPANY=10 \
      API_URL=http://localhost:3001 npm run build) > "$build_log" 2>&1 || build_ok="no"
  end_ms=$(node -e 'process.stdout.write(String(Date.now()))')
  build_ms=$((end_ms - start_ms))

  kill -TERM "$api_pid" 2>/dev/null || true
  wait "$api_pid" 2>/dev/null || true

  if [[ ! -f "$result_file" ]]; then
    echo "  ERROR: $result_file was not produced. api log:"
    cat "$api_log"
    continue
  fi

  read peak_all rej pool_to db_err wait_avg wait_p95 wait_max <<< "$(node -e "
    const j = require('$result_file');
    const w = j.poolWait || {};
    process.stdout.write([j.peak, j.rejected503, j.poolTimeouts, j.dbConnectErrors, w.avgMs ?? 0, w.p95Ms ?? 0, w.maxMs ?? 0].join(' '));
  ")"

  printf "%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n" \
    "$name" "$sem_limit" "$pool_max" "$pg_max" "$peak_all" "$rej" "$pool_to" "$db_err" "$wait_avg" "$wait_p95" "$wait_max" "$build_ok" "$build_ms" \
    >> "$results_file"

  echo "  peakAll=$peak_all rejected=$rej poolTimeouts=$pool_to dbErrors=$db_err waitAvg=${wait_avg}ms waitP95=${wait_p95}ms waitMax=${wait_max}ms buildOk=$build_ok buildMs=$build_ms"
  echo
done

echo "=== results ==="
column -t -s $'\t' "$results_file"
