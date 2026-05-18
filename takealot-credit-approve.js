#!/usr/bin/env node
// Takealot Credit-Note Manual Approval Command
// Lists, previews, and (with --execute) creates/applies Zoho credit notes for approved queue items.
//
// Usage:
//   node takealot-credit-approve.js --list
//   node takealot-credit-approve.js --approve RET-7603248
//   node takealot-credit-approve.js --approve RET-7603248 --execute

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const { loadApprovalQueue, saveApprovalQueue, buildCreditNoteMap, QUEUE_FILE } = require('./takealot-credit-approval-queue');
const { logTakealotEvent } = require('./takealot-debug-log');
const { sendNtfyNotification } = require('./notification-helper');

const ORG_ID = process.env.ZOHO_BOOKS_ORGANIZATION_ID;
const DC = process.env.ZOHO_DATA_CENTER || 'com';
const BOOKS_BASE = `https://www.zohoapis.${DC}/books/v3`;
const CN_STATE_FILE = path.join(__dirname, '.takealot-credit-note-state.json');

// ---- Auth ----
let accessToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (accessToken && tokenExpiry && Date.now() < tokenExpiry) return accessToken;
  const resp = await axios.post(`https://accounts.zoho.${DC}/oauth/v2/token`, null, {
    params: {
      refresh_token: process.env.ZOHO_REFRESH_TOKEN,
      client_id: process.env.ZOHO_CLIENT_ID,
      client_secret: process.env.ZOHO_CLIENT_SECRET,
      grant_type: 'refresh_token'
    }
  });
  accessToken = resp.data.access_token;
  tokenExpiry = Date.now() + (resp.data.expires_in * 1000) - 60000;
  return accessToken;
}

async function zohoGet(endpoint, params = {}) {
  const token = await getAccessToken();
  const resp = await axios.get(`${BOOKS_BASE}${endpoint}`, {
    headers: { Authorization: `Zoho-oauthtoken ${token}` },
    params: { organization_id: ORG_ID, ...params },
    timeout: 30000
  });
  return resp.data;
}

async function zohoPost(endpoint, body) {
  const token = await getAccessToken();
  const resp = await axios.post(`${BOOKS_BASE}${endpoint}`, body, {
    headers: { Authorization: `Zoho-oauthtoken ${token}`, 'Content-Type': 'application/json' },
    params: { organization_id: ORG_ID },
    timeout: 30000
  });
  return resp.data;
}

// ---- Credit-note state helpers ----
function loadCreditNoteState() {
  try {
    if (fs.existsSync(CN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CN_STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { created_credit_notes: [] };
}

function saveCreditNoteState(state) {
  const tmp = CN_STATE_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, CN_STATE_FILE);
}

// ---- CLI ----
const args = process.argv.slice(2);
const MODE_LIST = args.includes('--list');
const APPROVE_ID = (() => {
  const idx = args.indexOf('--approve');
  return idx !== -1 && args[idx + 1] ? args[idx + 1] : null;
})();
const EXECUTE = args.includes('--execute');

// ---- List ----
function cmdList() {
  const queue = loadApprovalQueue();
  const items = queue.items || [];
  const pending = items.filter(i => i.status === 'pending');
  const processed = items.filter(i => i.status === 'processed');
  const approved = items.filter(i => i.status === 'approved');

  const summary = {
    updated_at: queue.updated_at,
    total: items.length,
    pending: pending.length,
    approved: approved.length,
    processed: processed.length,
    items: items.map(i => ({
      approval_id: i.approval_id,
      seller_return_id: i.seller_return_id,
      invoice_number: i.invoice_number,
      sku: i.sku,
      amount: i.amount,
      status: i.status,
      credit_note_number: i.credit_note_number || null
    }))
  };

  console.log(JSON.stringify(summary, null, 2));
  logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_listed', level: 'info', message: `Queue listed: ${items.length} total, ${pending.length} pending, ${processed.length} processed`, context: { total: items.length, pending: pending.length, processed: processed.length } });
}

// ---- Approve ----
async function cmdApprove(approvalId) {
  const queue = loadApprovalQueue();
  const cnMap = buildCreditNoteMap();
  const item = (queue.items || []).find(i => i.approval_id === approvalId);

  if (!item) {
    console.log(JSON.stringify({ approval_id: approvalId, action: 'blocked', reason: 'not_found' }, null, 2));
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_blocked', level: 'warn', message: `Blocked ${approvalId}: not_found`, context: { approval_id: approvalId, reason: 'not_found' } });
    return;
  }

  // Block if already processed
  if (item.status === 'processed') {
    console.log(JSON.stringify({
      approval_id: approvalId,
      action: 'blocked',
      reason: 'already_processed',
      credit_note_number: item.credit_note_number,
      credit_note_id: item.credit_note_id
    }, null, 2));
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_blocked', level: 'warn', message: `Blocked ${approvalId}: already_processed`, context: { approval_id: approvalId, reason: 'already_processed', credit_note_number: item.credit_note_number } });
    return;
  }

  // Block if already approved but not yet processed
  if (item.status === 'approved') {
    console.log(JSON.stringify({
      approval_id: approvalId,
      action: 'blocked',
      reason: 'already_approved',
      approved_at: item.approved_at
    }, null, 2));
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_blocked', level: 'warn', message: `Blocked ${approvalId}: already_approved`, context: { approval_id: approvalId, reason: 'already_approved' } });
    return;
  }

  // Block if credit-note state shows already credited
  if (cnMap.has(item.seller_return_id)) {
    const cn = cnMap.get(item.seller_return_id);
    console.log(JSON.stringify({
      approval_id: approvalId,
      action: 'blocked',
      reason: 'already_credit_noted_in_state',
      credit_note_number: cn.zoho_creditnote_number
    }, null, 2));
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_blocked', level: 'warn', message: `Blocked ${approvalId}: already_credit_noted_in_state`, context: { approval_id: approvalId, reason: 'already_credit_noted_in_state', credit_note_number: cn.zoho_creditnote_number } });
    return;
  }

  // Must be pending
  if (item.status !== 'pending') {
    console.log(JSON.stringify({ approval_id: approvalId, action: 'blocked', reason: `unexpected_status_${item.status}` }, null, 2));
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_blocked', level: 'warn', message: `Blocked ${approvalId}: unexpected status ${item.status}`, context: { approval_id: approvalId, reason: `unexpected_status_${item.status}` } });
    return;
  }

  // Validate required fields
  const payload = item.proposed_credit_note_payload_preview;
  if (!payload || !payload.customer_id || !payload.invoice_id || !payload.line_items || payload.line_items.length === 0) {
    console.log(JSON.stringify({ approval_id: approvalId, action: 'blocked', reason: 'incomplete_payload' }, null, 2));
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_blocked', level: 'warn', message: `Blocked ${approvalId}: incomplete_payload`, context: { approval_id: approvalId, reason: 'incomplete_payload' } });
    return;
  }

  if (!item.amount || item.amount <= 0) {
    console.log(JSON.stringify({ approval_id: approvalId, action: 'blocked', reason: 'invalid_amount', amount: item.amount }, null, 2));
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_blocked', level: 'warn', message: `Blocked ${approvalId}: invalid_amount`, context: { approval_id: approvalId, reason: 'invalid_amount', amount: item.amount } });
    return;
  }

  // Preview mode (no --execute)
  if (!EXECUTE) {
    const preview = {
      approval_id: approvalId,
      action: 'preview',
      mode: 'DRY_RUN',
      message: 'Pass --execute to create and apply credit note',
      seller_return_id: item.seller_return_id,
      invoice_number: item.invoice_number,
      sku: item.sku,
      amount: item.amount,
      credit_note_reference: payload.reference_number,
      customer_id: payload.customer_id,
      invoice_id: payload.invoice_id,
      line_items_count: payload.line_items.length
    };
    console.log(JSON.stringify(preview, null, 2));
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_previewed', level: 'info', message: `Previewed ${approvalId}`, context: { approval_id: approvalId, seller_return_id: item.seller_return_id, invoice_number: item.invoice_number, sku: item.sku, amount: item.amount } });
    return;
  }

  // ---- Execute mode: create and apply credit note ----
  console.error(`[APPROVE] Executing credit note for ${approvalId}...`);
  logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_executed', level: 'info', message: `Executing ${approvalId}`, context: { approval_id: approvalId, seller_return_id: item.seller_return_id, amount: item.amount } });

  const result = {
    approval_id: approvalId,
    action: 'executed',
    credit_note_created: false,
    credit_note_applied: false,
    credit_note_number: null,
    credit_note_id: null,
    state_saved: false,
    notification_sent: false,
    error: null
  };

  try {
    // Step 1: Duplicate check via Zoho
    const ref = payload.reference_number;
    const cnSearch = await zohoGet('/creditnotes', { reference_number: ref });
    const existing = (cnSearch.creditnotes || []).find(cn => cn.reference_number === ref);
    if (existing) {
      result.error = 'duplicate_credit_note_exists';
      result.credit_note_number = existing.creditnote_number;
      result.credit_note_id = existing.creditnote_id;
      console.log(JSON.stringify(result, null, 2));
      logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_blocked', level: 'warn', message: `Blocked ${approvalId}: duplicate in Zoho`, context: { approval_id: approvalId, reason: 'duplicate_credit_note_exists', credit_note_number: existing.creditnote_number } });
      return;
    }

    // Step 2: Create credit note
    const cnBody = {
      customer_id: payload.customer_id,
      reference_number: ref,
      date: new Date().toISOString().slice(0, 10),
      notes: payload.notes,
      line_items: payload.line_items
    };

    console.error(`[APPROVE] Creating credit note ${ref}, amount R${item.amount}`);
    const createResp = await zohoPost('/creditnotes', cnBody);
    const cn = createResp.creditnote;
    if (!cn || !cn.creditnote_id) throw new Error('Credit note creation returned no creditnote_id');

    result.credit_note_created = true;
    result.credit_note_number = cn.creditnote_number;
    result.credit_note_id = cn.creditnote_id;
    console.error(`[APPROVE] Created ${cn.creditnote_number} (${cn.creditnote_id})`);

    // Step 3: Apply to invoice
    try {
      const applyBody = { invoices: [{ invoice_id: payload.invoice_id, amount_applied: item.amount }] };
      await zohoPost(`/creditnotes/${cn.creditnote_id}/invoices`, applyBody);
      result.credit_note_applied = true;
      console.error(`[APPROVE] Applied R${item.amount} to invoice`);
    } catch (applyErr) {
      console.error(`[APPROVE] WARNING: Apply failed: ${applyErr.message}`);
      result.error = `created_but_apply_failed: ${applyErr.message}`;
    }

    // Step 4: Update queue
    item.status = 'processed';
    item.approved_at = new Date().toISOString();
    item.processed_at = new Date().toISOString();
    item.credit_note_id = cn.creditnote_id;
    item.credit_note_number = cn.creditnote_number;
    saveApprovalQueue(queue);

    // Step 5: Update credit-note state
    try {
      const cnState = loadCreditNoteState();
      cnState.created_credit_notes.push({
        seller_return_id: item.seller_return_id,
        return_reference_number: item.return_reference_number,
        order_id: item.order_id,
        zoho_invoice_id: payload.invoice_id,
        zoho_invoice_number: item.invoice_number,
        zoho_creditnote_id: cn.creditnote_id,
        zoho_creditnote_number: cn.creditnote_number,
        reference_number: ref,
        amount: item.amount,
        applied_to_invoice: result.credit_note_applied,
        created_at: new Date().toISOString()
      });
      saveCreditNoteState(cnState);
      result.state_saved = true;
    } catch (stateErr) {
      console.error(`[APPROVE] WARNING: State save failed: ${stateErr.message}`);
    }

    // Step 6: Notify
    try {
      const ntfyResult = await sendNtfyNotification({
        title: 'Takealot credit note created',
        message: `Credit note ${cn.creditnote_number} created for TK-${item.order_id}, invoice ${item.invoice_number}, SKU ${item.sku}, amount R${item.amount}`,
        priority: 'default',
        tags: 'takealot,credit-note'
      });
      result.notification_sent = ntfyResult && ntfyResult.sent;
    } catch (ntfyErr) {
      console.error(`[APPROVE] Notification error (non-fatal): ${ntfyErr.message}`);
    }

    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_executed', level: 'info', message: `Executed ${approvalId}: ${cn.creditnote_number}`, context: { approval_id: approvalId, credit_note_number: cn.creditnote_number, credit_note_id: cn.creditnote_id, applied: result.credit_note_applied, amount: item.amount } });

  } catch (err) {
    result.error = err.message;
    logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_failed', level: 'error', message: `Failed ${approvalId}: ${err.message}`, context: { approval_id: approvalId, error_message: err.message } });
  }

  console.log(JSON.stringify(result, null, 2));
}

// ---- Main ----
async function main() {
  if (!MODE_LIST && !APPROVE_ID) {
    console.error('Usage:');
    console.error('  node takealot-credit-approve.js --list');
    console.error('  node takealot-credit-approve.js --approve RET-XXXX');
    console.error('  node takealot-credit-approve.js --approve RET-XXXX --execute');
    process.exit(1);
  }

  if (MODE_LIST) {
    cmdList();
    return;
  }

  if (APPROVE_ID) {
    await cmdApprove(APPROVE_ID);
  }
}

main().catch(e => {
  logTakealotEvent({ source: 'takealot-credit-approve', event_type: 'credit_approval_failed', level: 'error', message: `Fatal: ${e.message}`, context: { error_message: e.message } });
  console.error('[APPROVE] FATAL:', e.message);
  process.exit(1);
});
