// Takealot Credit-Note Approval Queue
// Manages a local JSON queue of credit-note previews pending manual approval.
// Does NOT create, apply, or modify Zoho credit notes or invoices.

const fs = require('fs');
const path = require('path');
const { logTakealotEvent } = require('./takealot-debug-log');

const QUEUE_FILE = path.join(__dirname, '.takealot-credit-approval-queue.json');
const CN_STATE_FILE = path.join(__dirname, '.takealot-credit-note-state.json');

function loadCreditNoteState() {
  try {
    if (fs.existsSync(CN_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(CN_STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { created_credit_notes: [] };
}

function buildCreditNoteMap() {
  const state = loadCreditNoteState();
  const map = new Map();
  for (const cn of (state.created_credit_notes || [])) {
    map.set(cn.seller_return_id, cn);
  }
  return map;
}

function loadApprovalQueue() {
  let queue;
  try {
    if (fs.existsSync(QUEUE_FILE)) {
      queue = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    }
  } catch (e) {
    logTakealotEvent({ source: 'takealot-credit-approval-queue', event_type: 'credit_approval_queue_failed', level: 'error', message: 'Queue load failed', context: { error_message: e.message, stage: 'load' } });
  }
  if (!queue) queue = { updated_at: null, items: [] };

  // Reconcile: mark any pending items that are already credit-noted as processed
  const cnMap = buildCreditNoteMap();
  let reconciled = 0;
  for (const item of queue.items) {
    if (item.status === 'pending' && cnMap.has(item.seller_return_id)) {
      const cn = cnMap.get(item.seller_return_id);
      item.status = 'processed';
      item.processed_at = item.processed_at || cn.created_at || new Date().toISOString();
      item.credit_note_id = cn.zoho_creditnote_id || null;
      item.credit_note_number = cn.zoho_creditnote_number || null;
      reconciled++;
      logTakealotEvent({ source: 'takealot-credit-approval-queue', event_type: 'credit_approval_candidate_already_processed', level: 'info', message: `Reconciled ${item.approval_id} as processed`, context: { approval_id: item.approval_id, seller_return_id: item.seller_return_id, credit_note_number: item.credit_note_number } });
    }
  }
  if (reconciled > 0) {
    logTakealotEvent({ source: 'takealot-credit-approval-queue', event_type: 'credit_approval_queue_reconciled', level: 'info', message: `Reconciled ${reconciled} already-credit-noted items`, context: { reconciled } });
  }

  return queue;
}

function saveApprovalQueue(queue) {
  queue.updated_at = new Date().toISOString();
  const tmp = QUEUE_FILE + '.tmp.' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(queue, null, 2));
    fs.renameSync(tmp, QUEUE_FILE);
  } catch (e) {
    logTakealotEvent({ source: 'takealot-credit-approval-queue', event_type: 'credit_approval_queue_failed', level: 'error', message: 'Queue save failed', context: { error_message: e.message, stage: 'save' } });
    // Clean up temp file if rename failed
    try { fs.unlinkSync(tmp); } catch (_) {}
    throw e;
  }
}

function upsertApprovalCandidate(queue, preview, cnMap) {
  const approvalId = 'RET-' + preview.seller_return_id;
  const alreadyCredited = cnMap && cnMap.has(preview.seller_return_id);
  const cn = alreadyCredited ? cnMap.get(preview.seller_return_id) : null;

  const existing = queue.items.find(i => i.approval_id === approvalId);

  if (existing) {
    // Already credit-noted — ensure status is processed
    if (alreadyCredited && existing.status === 'pending') {
      existing.status = 'processed';
      existing.processed_at = existing.processed_at || cn.created_at || new Date().toISOString();
      existing.credit_note_id = cn.zoho_creditnote_id || null;
      existing.credit_note_number = cn.zoho_creditnote_number || null;
      return { action: 'skipped', reason: 'already_credit_noted', approval_id: approvalId };
    }

    // Do not overwrite approved/processed
    if (existing.status !== 'pending') {
      return { action: 'skipped', reason: `status_${existing.status}`, approval_id: approvalId };
    }

    // Update preview fields on existing pending item
    existing.return_reference_number = preview.return_reference_number;
    existing.order_id = preview.order_id;
    existing.zoho_reference = preview.zoho_reference;
    existing.invoice_id = preview.invoice_id;
    existing.invoice_number = preview.invoice_number;
    existing.customer_id = preview.proposed_credit_note_payload_preview?.customer_id || existing.customer_id;
    existing.sku = preview.sku;
    existing.quantity = preview.quantity_returned;
    existing.amount = preview.expected_credit_amount;
    existing.credit_note_reference_preview = preview.credit_note_reference_preview;
    existing.recommended_action = preview.recommended_action;
    existing.proposed_credit_note_payload_preview = preview.proposed_credit_note_payload_preview;

    return { action: 'updated', approval_id: approvalId };
  }

  // Already credit-noted but not in queue — add as processed for audit visibility
  if (alreadyCredited) {
    queue.items.push({
      approval_id: approvalId,
      seller_return_id: preview.seller_return_id,
      return_reference_number: preview.return_reference_number,
      order_id: preview.order_id,
      zoho_reference: preview.zoho_reference,
      invoice_id: preview.invoice_id,
      invoice_number: preview.invoice_number,
      customer_id: preview.proposed_credit_note_payload_preview?.customer_id || null,
      sku: preview.sku,
      quantity: preview.quantity_returned,
      amount: preview.expected_credit_amount,
      credit_note_reference_preview: preview.credit_note_reference_preview,
      recommended_action: preview.recommended_action,
      proposed_credit_note_payload_preview: preview.proposed_credit_note_payload_preview,
      status: 'processed',
      created_at: cn.created_at || new Date().toISOString(),
      approved_at: null,
      processed_at: cn.created_at || new Date().toISOString(),
      credit_note_id: cn.zoho_creditnote_id || null,
      credit_note_number: cn.zoho_creditnote_number || null
    });
    return { action: 'skipped', reason: 'already_credit_noted', approval_id: approvalId };
  }

  // New candidate — truly pending
  queue.items.push({
    approval_id: approvalId,
    seller_return_id: preview.seller_return_id,
    return_reference_number: preview.return_reference_number,
    order_id: preview.order_id,
    zoho_reference: preview.zoho_reference,
    invoice_id: preview.invoice_id,
    invoice_number: preview.invoice_number,
    customer_id: preview.proposed_credit_note_payload_preview?.customer_id || null,
    sku: preview.sku,
    quantity: preview.quantity_returned,
    amount: preview.expected_credit_amount,
    credit_note_reference_preview: preview.credit_note_reference_preview,
    recommended_action: preview.recommended_action,
    proposed_credit_note_payload_preview: preview.proposed_credit_note_payload_preview,
    status: 'pending',
    created_at: new Date().toISOString(),
    approved_at: null,
    processed_at: null,
    credit_note_id: null,
    credit_note_number: null
  });

  return { action: 'queued', approval_id: approvalId };
}

module.exports = { loadApprovalQueue, saveApprovalQueue, upsertApprovalCandidate, buildCreditNoteMap, QUEUE_FILE };
