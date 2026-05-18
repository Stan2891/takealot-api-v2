#!/usr/bin/env node
// Takealot V2.1 — Read-Only Returns Detector
// Fetches returns from Marketplace API v1, reports proposed actions.
// Does NOT create credit notes or modify Zoho.

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const TakealotMarketplaceClient = require('./takealot-marketplace-client');
const { sendNtfyNotification } = require('./notification-helper');
const { logTakealotEvent } = require('./takealot-debug-log');

const STATE_FILE = path.join(__dirname, '.takealot-returns-state.json');

// Parse CLI args
const args = process.argv.slice(2);
function getArgValue(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}
const DRY_RUN = args.includes('--dry-run');
const NO_NOTIFY = args.includes('--no-notify');
const INCLUDE_EXISTING = args.includes('--include-existing');
const DAYS = parseInt(getArgValue('--days', '30'), 10);
const LIMIT = parseInt(getArgValue('--limit', '100'), 10);

// State helpers
function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { last_poll: null, processed_return_ids: [] };
}

function saveState(state) {
  if (state.processed_return_ids.length > 1000) {
    state.processed_return_ids = state.processed_return_ids.slice(-1000);
  }
  try {
    const tmp = STATE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, STATE_FILE);
  } catch (e) {
    console.error('[RETURNS] State write failed:', e.message);
  }
}

// Extract transaction amounts by type
function sumTransactions(transactions, type) {
  return (transactions || [])
    .filter(t => t.transaction_type === type)
    .reduce((sum, t) => sum + (t.amount_incl_vat || 0), 0);
}

async function main() {
  const apiKey = process.env.TAKEALOT_API_KEY;
  if (!apiKey) {
    console.error('[RETURNS] TAKEALOT_API_KEY not set');
    process.exit(1);
  }

  const client = new TakealotMarketplaceClient(apiKey);

  // Date range
  const now = new Date();
  const fromDate = new Date(now - DAYS * 24 * 60 * 60 * 1000);
  const fromStr = fromDate.toISOString().split('T')[0];
  const toStr = now.toISOString().split('T')[0];

  console.error(`[RETURNS] Fetching returns ${fromStr} to ${toStr} (dry_run=${DRY_RUN}, days=${DAYS}, limit=${LIMIT})`);
  logTakealotEvent({ source: 'takealot-returns-check', event_type: 'returns_check_started', level: 'info', message: 'Returns check starting', context: { days: DAYS, limit: LIMIT, dry_run: DRY_RUN, no_notify: NO_NOTIFY, include_existing: INCLUDE_EXISTING, date_from: fromStr, date_to: toStr } });

  // Fetch all returns
  let result;
  try {
    result = await client.getAllReturns({
      return_date__gte: fromStr,
      return_date__lte: toStr,
      limit: LIMIT,
      expands: ['outcomes', 'transactions']
    });
  } catch (e) {
    console.error('[RETURNS] API error:', e.message);
    process.exit(1);
  }

  const allReturns = result.items;
  console.error(`[RETURNS] Fetched ${allReturns.length} returns across ${result.pages_read} page(s)${result.truncated ? ' (TRUNCATED)' : ''}`);
  logTakealotEvent({ source: 'takealot-returns-check', event_type: 'returns_fetched', level: 'info', message: `Fetched ${allReturns.length} returns`, context: { returns_seen: allReturns.length, pages_read: result.pages_read, truncated: result.truncated, date_from: fromStr, date_to: toStr } });

  // Load state
  const state = loadState();
  const processedSet = new Set(state.processed_return_ids.map(Number));

  // Filter new vs existing
  const proposedActions = [];
  let skippedExisting = 0;

  for (const ret of allReturns) {
    const rid = ret.seller_return_id;
    const isExisting = processedSet.has(rid);

    if (isExisting && !INCLUDE_EXISTING) {
      skippedExisting++;
      continue;
    }

    const customerOrderReversal = sumTransactions(ret.transactions, 'reversal-customer-order');
    const successFeeReversal = sumTransactions(ret.transactions, 'reversal-success-fee');
    const outcomeStatuses = (ret.outcomes || []).map(o => o.status);

    proposedActions.push({
      seller_return_id: rid,
      return_reference_number: ret.return_reference_number || null,
      order_id: ret.order_id,
      zoho_reference: 'TK-' + ret.order_id,
      sku: ret.sku || null,
      quantity: ret.quantity || 0,
      return_date: ret.return_date || null,
      return_reason: ret.return_reason || null,
      customer_comment_present: !!(ret.customer_comment && ret.customer_comment.trim()),
      outcome_status: outcomeStatuses.length > 0 ? outcomeStatuses[0] : null,
      customer_order_reversal_amount: customerOrderReversal,
      success_fee_reversal_amount: successFeeReversal,
      proposed_action: 'review_for_credit_note',
      zoho_invoice_lookup: 'not_implemented_in_phase_8',
      already_processed: isExisting
    });

    if (isExisting) {
      skippedExisting++;
    }
  }

  const newActions = proposedActions.filter(a => !a.already_processed);

  // Build report
  const report = {
    success: true,
    mode: DRY_RUN ? 'DRY_RUN' : 'LIVE',
    date_range: { from: fromStr, to: toStr },
    returns_seen: allReturns.length,
    returns_new: newActions.length,
    returns_skipped_existing: skippedExisting,
    proposed_actions: proposedActions,
    continuation_pages_read: result.pages_read,
    truncated: result.truncated
  };

  logTakealotEvent({ source: 'takealot-returns-check', event_type: 'returns_new_detected', level: 'info', message: `New returns: ${newActions.length}`, context: { returns_new: newActions.length, returns_skipped_existing: skippedExisting, proposed_actions_count: proposedActions.length } });

  // Output report to stdout
  console.log(JSON.stringify(report, null, 2));

  // Notification
  if (newActions.length > 0 && !NO_NOTIFY) {
    const first = newActions[0];
    const ntfyMsg = [
      'New returns: ' + newActions.length,
      'First order: TK-' + first.order_id,
      'SKU: ' + (first.sku || 'n/a'),
      'Reason: ' + (first.return_reason || 'n/a'),
      'Reversal: R' + (first.customer_order_reversal_amount || 0)
    ].join('\n');

    if (DRY_RUN) {
      console.error('[RETURNS] DRY-RUN: Would send notification:');
      console.error('  Title: Takealot return detected');
      console.error('  Message: ' + ntfyMsg.replace(/\n/g, ' | '));
      logTakealotEvent({ source: 'takealot-returns-check', event_type: 'returns_notification_attempted', level: 'info', message: 'Notification skipped (dry-run)', context: { returns_new: newActions.length, first_order_id: first.order_id, first_sku: first.sku, dry_run: true, no_notify: false }, result: { sent: false, reason: 'dry_run' } });
    } else {
      try {
        const ntfyResult = await sendNtfyNotification({
          title: 'Takealot return detected',
          message: ntfyMsg,
          priority: 'high',
          tags: 'warning,takealot'
        });
        console.error('[RETURNS] Notification ' + (ntfyResult.sent ? 'sent' : 'skipped/failed: ' + (ntfyResult.reason || ntfyResult.error || 'unknown')));
        logTakealotEvent({ source: 'takealot-returns-check', event_type: 'returns_notification_attempted', level: ntfyResult.sent ? 'info' : 'warn', message: `Notification ${ntfyResult.sent ? 'sent' : 'failed'}`, context: { returns_new: newActions.length, first_order_id: first.order_id, first_sku: first.sku, dry_run: false, no_notify: false }, result: { sent: ntfyResult.sent, reason: ntfyResult.reason || null, error: ntfyResult.error || null, attempts: ntfyResult.attempts } });
      } catch (notifErr) {
        console.error('[RETURNS] Notification error (non-fatal): ' + notifErr.message);
      }
    }
  }

  // Save state (only in non-dry-run mode)
  if (!DRY_RUN) {
    for (const action of newActions) {
      state.processed_return_ids.push(action.seller_return_id);
    }
    state.last_poll = now.toISOString();
    saveState(state);
    console.error(`[RETURNS] State saved: ${newActions.length} new return IDs recorded`);
    logTakealotEvent({ source: 'takealot-returns-check', event_type: 'returns_state_saved', level: 'info', message: `State saved: ${newActions.length} new IDs`, context: { new_return_ids_recorded: newActions.length, processed_return_ids_count: state.processed_return_ids.length } });
  } else {
    console.error('[RETURNS] DRY-RUN: State not modified');
  }

  logTakealotEvent({ source: 'takealot-returns-check', event_type: 'returns_check_completed', level: 'info', message: `Returns check completed`, context: { returns_seen: allReturns.length, returns_new: newActions.length, returns_skipped_existing: skippedExisting, proposed_actions_count: proposedActions.length, mode: DRY_RUN ? 'DRY_RUN' : 'LIVE' } });
}

main().catch(e => {
  logTakealotEvent({ source: 'takealot-returns-check', event_type: 'returns_check_failed', level: 'error', message: `Fatal error: ${e.message}`, context: { error_message: e.message } });
  console.error('[RETURNS] FATAL:', e.message);
  process.exit(1);
});
