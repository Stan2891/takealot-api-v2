#!/usr/bin/env bash
# Takealot V2.1 — Order Poller with Healthchecks.io heartbeat
# Runs the order poller, then pings Healthchecks only on success.

set -euo pipefail

SCRIPT_DIR="/home/stan/zoho-mcp-server"
DEBUG_LOG="/home/stan/reports/takealot-debug.log"
cd "$SCRIPT_DIR"

# Append a JSONL debug event (never fails the wrapper)
log_debug() {
  local etype="$1" level="$2" msg="$3" ctx="$4"
  local ts
  ts=$(date -u +"%Y-%m-%dT%H:%M:%S.000Z")
  printf '{"timestamp":"%s","source":"takealot-order-poll-heartbeat","event_type":"%s","level":"%s","message":"%s","context":%s,"result":{}}\n' \
    "$ts" "$etype" "$level" "$msg" "$ctx" >> "$DEBUG_LOG" 2>/dev/null || true
}

# Load .env silently
if [ -f "$SCRIPT_DIR/.env" ]; then
  set -a
  source "$SCRIPT_DIR/.env"
  set +a
fi

# Run the order poller
set +e
/usr/bin/node "$SCRIPT_DIR/takealot-order-poll.js"
POLL_EXIT=$?
set -e

if [ $POLL_EXIT -eq 0 ]; then
  if [ -n "${HC_TAKEALOT_ORDER_POLLER_URL:-}" ]; then
    log_debug "healthchecks_ping_attempted" "info" "Pinging Healthchecks" '{"job":"order-poll","script_exit_code":0}'
    if curl -fsS -m 10 --retry 3 -o /dev/null "$HC_TAKEALOT_ORDER_POLLER_URL"; then
      log_debug "healthchecks_ping_succeeded" "info" "Healthchecks ping succeeded" '{"job":"order-poll"}'
    else
      CURL_EXIT=$?
      log_debug "healthchecks_ping_failed" "error" "Healthchecks ping failed" "{\"job\":\"order-poll\",\"curl_exit_code\":$CURL_EXIT}"
      echo "[$(date -Iseconds)] WARNING: Healthchecks ping failed (non-fatal)"
    fi
  else
    log_debug "healthchecks_ping_skipped" "warn" "Healthchecks URL not set" '{"job":"order-poll","reason":"missing_url"}'
    echo "[$(date -Iseconds)] WARNING: HC_TAKEALOT_ORDER_POLLER_URL not set — skipping heartbeat"
  fi
else
  log_debug "healthchecks_ping_skipped" "warn" "Poller failed, skipping ping" "{\"job\":\"order-poll\",\"reason\":\"script_failed\",\"script_exit_code\":$POLL_EXIT}"
  echo "[$(date -Iseconds)] Order poller exited $POLL_EXIT — skipping Healthchecks ping"
fi

exit $POLL_EXIT
