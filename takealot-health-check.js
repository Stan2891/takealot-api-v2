#!/usr/bin/env node
// Takealot V2.1 — Poller Health Check
// Reads .takealot-health.json and alerts if poller is stale or errored.
// Uses notification-helper.js for ntfy alerts.
// Cooldown prevents alert spam per alert type.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });
const { sendNtfyNotification } = require('./notification-helper');
const { logTakealotEvent } = require('./takealot-debug-log');

const HEALTH_FILE = path.join(__dirname, '.takealot-health.json');
const COOLDOWN_FILE = path.join(__dirname, '.takealot-health-alert-state.json');
const DEFAULT_MAX_AGE_MINUTES = 90;
const COOLDOWN_MINUTES = 60;

// Parse CLI args
const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const maxAgeFlag = args.find(a => a.startsWith('--max-age-minutes'));
const maxAgeIdx = args.indexOf('--max-age-minutes');
let MAX_AGE_MINUTES = DEFAULT_MAX_AGE_MINUTES;
if (maxAgeIdx !== -1 && args[maxAgeIdx + 1]) {
  const parsed = parseInt(args[maxAgeIdx + 1], 10);
  if (!isNaN(parsed) && parsed > 0) MAX_AGE_MINUTES = parsed;
}

function log(msg) {
  console.log(`[${new Date().toISOString()}] ${msg}`);
}

// Cooldown: load/save/check per alert type
function loadCooldown() {
  try {
    if (fs.existsSync(COOLDOWN_FILE)) {
      return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveCooldown(state) {
  try {
    const tmp = COOLDOWN_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, COOLDOWN_FILE);
  } catch (e) {
    log('Cooldown write failed (non-fatal): ' + e.message);
  }
}

function isCoolingDown(alertType) {
  const state = loadCooldown();
  const lastSent = state[alertType];
  if (!lastSent) return false;
  const elapsed = Date.now() - new Date(lastSent).getTime();
  return elapsed < COOLDOWN_MINUTES * 60 * 1000;
}

function markAlertSent(alertType) {
  const state = loadCooldown();
  state[alertType] = new Date().toISOString();
  saveCooldown(state);
}

async function sendAlert(alertType, title, message) {
  if (isCoolingDown(alertType)) {
    log(`COOLDOWN: "${alertType}" alert suppressed (last sent < ${COOLDOWN_MINUTES}min ago)`);
    return { sent: false, reason: 'cooldown' };
  }

  if (DRY_RUN) {
    log(`DRY-RUN: Would send alert "${alertType}"`);
    log(`  Title: ${title}`);
    log(`  Message: ${message}`);
    return { sent: false, reason: 'dry_run' };
  }

  const result = await sendNtfyNotification({
    title,
    message,
    priority: 'high',
    tags: 'warning,takealot'
  });

  if (result.sent) {
    markAlertSent(alertType);
    log(`ALERT SENT: "${alertType}" (status ${result.status})`);
  } else {
    log(`ALERT FAILED: "${alertType}" — ${result.reason || result.error || 'unknown'}`);
  }

  return result;
}

async function main() {
  log(`Health check starting (max_age=${MAX_AGE_MINUTES}min, dry_run=${DRY_RUN})`);
  logTakealotEvent({ source: 'takealot-health-check', event_type: 'health_check_started', level: 'info', message: 'Health check starting', context: { max_age_minutes: MAX_AGE_MINUTES, dry_run: DRY_RUN } });

  // 1. Check if health file exists
  if (!fs.existsSync(HEALTH_FILE)) {
    log('PROBLEM: Health file missing');
    logTakealotEvent({ source: 'takealot-health-check', event_type: 'health_file_missing', level: 'error', message: 'Health file missing', context: { health_file_path_present: false } });
    await sendAlert(
      'health_file_missing',
      'Takealot Poller: Health File Missing',
      'The health file .takealot-health.json does not exist.\nThe poller may have never run or the file was deleted.'
    );
    process.exit(1);
  }

  // 2. Parse health file
  let health;
  try {
    health = JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
  } catch (e) {
    log('PROBLEM: Health file corrupt — ' + e.message);
    logTakealotEvent({ source: 'takealot-health-check', event_type: 'health_file_corrupt', level: 'error', message: 'Health file corrupt', context: { error_message: e.message } });
    await sendAlert(
      'health_file_corrupt',
      'Takealot Poller: Health File Corrupt',
      'Could not parse .takealot-health.json: ' + e.message
    );
    process.exit(1);
  }

  log(`Health data: last_started=${health.last_started_at || 'never'}, last_success=${health.last_success_at || 'never'}, last_error=${health.last_error_at || 'none'}`);

  // 3. Check if last_error_at is newer than last_success_at
  const lastSuccess = health.last_success_at ? new Date(health.last_success_at).getTime() : 0;
  const lastError = health.last_error_at ? new Date(health.last_error_at).getTime() : 0;

  if (lastError > 0 && lastError > lastSuccess) {
    const errorMsg = health.last_error_message || 'unknown error';
    log('PROBLEM: Last run errored (error newer than last success)');
    logTakealotEvent({ source: 'takealot-health-check', event_type: 'health_check_error_state', level: 'error', message: 'Last run errored', context: { last_error_at: health.last_error_at, last_success_at: health.last_success_at || null, error_message: health.last_error_message || 'unknown' } });
    await sendAlert(
      'poller_error',
      'Takealot Poller: Last Run Failed',
      'The poller last run ended in error.\nError: ' + errorMsg + '\nError at: ' + health.last_error_at
    );
    process.exit(1);
  }

  // 4. Check if last_success_at is older than threshold
  if (lastSuccess === 0) {
    log('PROBLEM: Poller has never completed successfully');
    await sendAlert(
      'poller_never_succeeded',
      'Takealot Poller: Never Succeeded',
      'The health file exists but last_success_at is not set.\nThe poller may have never completed a run.'
    );
    process.exit(1);
  }

  const ageMinutes = (Date.now() - lastSuccess) / (60 * 1000);
  if (ageMinutes > MAX_AGE_MINUTES) {
    log(`PROBLEM: Poller stale — last success ${Math.round(ageMinutes)}min ago (threshold ${MAX_AGE_MINUTES}min)`);
    logTakealotEvent({ source: 'takealot-health-check', event_type: 'health_check_stale', level: 'error', message: `Poller stale: ${Math.round(ageMinutes)}min`, context: { age_minutes: Math.round(ageMinutes), max_age_minutes: MAX_AGE_MINUTES, last_success_at: health.last_success_at } });
    await sendAlert(
      'poller_stale',
      'Takealot Poller: Stale',
      'Last successful poll was ' + Math.round(ageMinutes) + ' minutes ago.\nThreshold: ' + MAX_AGE_MINUTES + ' minutes.\nLast success: ' + health.last_success_at
    );
    process.exit(1);
  }

  // All checks passed
  log(`OK: Poller healthy — last success ${Math.round(ageMinutes)}min ago, orders_created=${health.orders_created || 0}, orders_seen=${health.orders_seen || 0}`);
  logTakealotEvent({ source: 'takealot-health-check', event_type: 'health_check_ok', level: 'info', message: 'Poller healthy', context: { age_minutes: Math.round(ageMinutes), orders_seen: health.orders_seen || 0, orders_created: health.orders_created || 0, last_success_at: health.last_success_at } });
  process.exit(0);
}

main().catch(e => {
  logTakealotEvent({ source: 'takealot-health-check', event_type: 'health_check_failed', level: 'error', message: `Fatal error: ${e.message}`, context: { error_message: e.message } });
  log('FATAL: ' + e.message);
  process.exit(2);
});
