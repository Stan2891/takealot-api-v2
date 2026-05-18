#!/usr/bin/env node
// Takealot Credit-Note Preview Generator (Read-Only)
// Matches Takealot returns → Zoho invoices → invoice lines → proposed credit note data.
// Does NOT create, apply, or modify credit notes or invoices.

const fs = require('fs');
const path = require('path');
const axios = require('axios');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const TakealotMarketplaceClient = require('./takealot-marketplace-client');
const { logTakealotEvent } = require('./takealot-debug-log');
const { loadApprovalQueue, saveApprovalQueue, upsertApprovalCandidate, buildCreditNoteMap } = require('./takealot-credit-approval-queue');
const { sendNtfyNotification } = require('./notification-helper');

const ORG_ID = process.env.ZOHO_BOOKS_ORGANIZATION_ID;
const DC = process.env.ZOHO_DATA_CENTER || 'com';
const BOOKS_BASE = `https://www.zohoapis.${DC}/books/v3`;

// ---- Auth (read-only, same pattern as existing scripts) ----
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

// ---- CLI args ----
const args = process.argv.slice(2);
function getArgValue(name, defaultVal) {
  const idx = args.indexOf(name);
  if (idx !== -1 && args[idx + 1]) return args[idx + 1];
  return defaultVal;
}
function getArgValues(name) {
  const vals = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === name && args[i + 1]) vals.push(args[i + 1]);
  }
  return vals;
}

const DAYS = parseInt(getArgValue('--days', '30'), 10);
const SELLER_RETURN_IDS = getArgValues('--seller-return-id').map(Number).filter(n => !isNaN(n));
const INCLUDE_EXISTING = args.includes('--include-existing');
const OUTPUT_JSON = args.includes('--output-json');
const NO_NOTIFY = args.includes('--no-notify');
const QUEUE_READY = args.includes('--queue-ready');

// ---- Transaction amount helpers ----
function sumTransactions(transactions, type) {
  return (transactions || [])
    .filter(t => t.transaction_type === type)
    .reduce((sum, t) => sum + (t.amount_incl_vat || 0), 0);
}

// ---- State (read-only check for processed returns) ----
const RETURNS_STATE_FILE = path.join(__dirname, '.takealot-returns-state.json');

function loadReturnsState() {
  try {
    if (fs.existsSync(RETURNS_STATE_FILE)) {
      return JSON.parse(fs.readFileSync(RETURNS_STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { processed_return_ids: [] };
}

// ---- Main ----
async function main() {
  const apiKey = process.env.TAKEALOT_API_KEY;
  if (!apiKey) { console.error('[PREVIEW] TAKEALOT_API_KEY not set'); process.exit(1); }
  if (!ORG_ID) { console.error('[PREVIEW] ZOHO_BOOKS_ORGANIZATION_ID not set'); process.exit(1); }

  const now = new Date();
  const fromDate = new Date(now - DAYS * 24 * 60 * 60 * 1000);
  const fromStr = fromDate.toISOString().split('T')[0];
  const toStr = now.toISOString().split('T')[0];

  console.error(`[PREVIEW] Credit-note preview starting (days=${DAYS}, from=${fromStr}, to=${toStr})`);
  logTakealotEvent({
    source: 'takealot-credit-preview', event_type: 'credit_preview_started', level: 'info',
    message: 'Credit preview starting',
    context: { days: DAYS, date_from: fromStr, date_to: toStr, seller_return_ids: SELLER_RETURN_IDS, include_existing: INCLUDE_EXISTING }
  });

  // Step 1: Fetch Takealot returns
  const client = new TakealotMarketplaceClient(apiKey);
  let result;
  try {
    result = await client.getAllReturns({
      return_date__gte: fromStr,
      return_date__lte: toStr,
      limit: 100,
      expands: ['outcomes', 'transactions']
    });
  } catch (e) {
    console.error('[PREVIEW] Takealot API error:', e.message);
    logTakealotEvent({ source: 'takealot-credit-preview', event_type: 'credit_preview_failed', level: 'error', message: 'Takealot API error', context: { error_message: e.message, stage: 'fetch_returns' } });
    process.exit(1);
  }

  let allReturns = result.items;
  console.error(`[PREVIEW] Fetched ${allReturns.length} returns across ${result.pages_read} page(s)`);

  // Filter to specific return IDs if provided
  if (SELLER_RETURN_IDS.length > 0) {
    const idSet = new Set(SELLER_RETURN_IDS);
    allReturns = allReturns.filter(r => idSet.has(r.seller_return_id));
    console.error(`[PREVIEW] Filtered to ${allReturns.length} returns matching --seller-return-id`);
  }

  // Filter already-processed unless --include-existing
  const returnsState = loadReturnsState();
  const processedSet = new Set(returnsState.processed_return_ids.map(Number));
  if (!INCLUDE_EXISTING) {
    const before = allReturns.length;
    allReturns = allReturns.filter(r => !processedSet.has(r.seller_return_id));
    console.error(`[PREVIEW] After excluding processed: ${allReturns.length} (${before - allReturns.length} skipped)`);
  }

  // Step 2-5: Process each return
  const previews = [];
  let readyCount = 0;
  let reviewCount = 0;

  for (const ret of allReturns) {
    const rid = ret.seller_return_id;
    const orderId = ret.order_id;
    const sku = ret.sku || null;
    const quantityReturned = ret.quantity || 0;
    const returnRefNum = ret.return_reference_number || null;
    const zohoRef = 'TK-' + orderId;
    const customerOrderReversal = sumTransactions(ret.transactions, 'reversal-customer-order');
    const successFeeReversal = sumTransactions(ret.transactions, 'reversal-success-fee');
    const outcomeStatuses = (ret.outcomes || []).map(o => o.status);
    const expectedCreditAmount = Math.abs(customerOrderReversal);

    const preview = {
      seller_return_id: rid,
      return_reference_number: returnRefNum,
      order_id: orderId,
      zoho_reference: zohoRef,
      sku,
      quantity_returned: quantityReturned,
      return_date: ret.return_date || null,
      return_reason: ret.return_reason || null,
      customer_comment_present: !!(ret.customer_comment && ret.customer_comment.trim()),
      outcome_status: outcomeStatuses.length > 0 ? outcomeStatuses[0] : null,
      customer_order_reversal_amount: customerOrderReversal,
      success_fee_reversal_amount: successFeeReversal,
      expected_credit_amount: expectedCreditAmount,

      invoice_found: false,
      invoice_id: null,
      invoice_number: null,
      invoice_status: null,
      invoice_balance: null,

      line_found: false,
      invoice_line_sku: null,
      invoice_line_quantity: null,
      invoice_line_rate: null,
      invoice_line_total: null,

      amount_match: false,
      quantity_match: false,
      recommended_action: null,

      credit_note_reference_preview: null,
      proposed_credit_note_payload_preview: null
    };

    // Missing customer reversal → can't credit
    if (expectedCreditAmount === 0) {
      preview.recommended_action = 'manual_review_missing_customer_reversal';
      reviewCount++;
      previews.push(preview);
      logMatch(preview);
      continue;
    }

    // Step 2: Find Zoho invoice by reference_number
    let invoice = null;
    try {
      const invResp = await zohoGet('/invoices', { reference_number: zohoRef });
      const invoices = invResp.invoices || [];
      if (invoices.length > 0) {
        // Get full invoice details for line items
        const fullInvResp = await zohoGet(`/invoices/${invoices[0].invoice_id}`);
        invoice = fullInvResp.invoice || null;
      }
    } catch (e) {
      console.error(`[PREVIEW] Zoho invoice lookup failed for ${zohoRef}: ${e.message}`);
    }

    if (!invoice) {
      preview.recommended_action = 'manual_review_invoice_not_found';
      reviewCount++;
      previews.push(preview);
      logMatch(preview);
      continue;
    }

    preview.invoice_found = true;
    preview.invoice_id = invoice.invoice_id;
    preview.invoice_number = invoice.invoice_number;
    preview.invoice_status = invoice.status;
    preview.invoice_balance = invoice.balance;

    // Step 3: Match invoice line by SKU
    const lineItems = invoice.line_items || [];
    const matchedLine = lineItems.find(li => li.sku === sku);

    if (!matchedLine) {
      preview.recommended_action = 'manual_review_line_not_found';
      reviewCount++;
      previews.push(preview);
      logMatch(preview);
      continue;
    }

    preview.line_found = true;
    preview.invoice_line_sku = matchedLine.sku;
    preview.invoice_line_quantity = matchedLine.quantity;
    preview.invoice_line_rate = matchedLine.rate;
    preview.invoice_line_total = matchedLine.item_total;

    // Step 4: Compare and classify
    preview.quantity_match = quantityReturned <= matchedLine.quantity;
    const amtDiff = Math.abs(matchedLine.item_total - expectedCreditAmount);
    preview.amount_match = amtDiff <= 1.00;

    if (!preview.quantity_match) {
      preview.recommended_action = 'manual_review_quantity_mismatch';
      reviewCount++;
      previews.push(preview);
      logMatch(preview);
      continue;
    }

    if (!preview.amount_match) {
      preview.recommended_action = 'manual_review_amount_mismatch';
      reviewCount++;
      previews.push(preview);
      logMatch(preview);
      continue;
    }

    // Tax check
    const hasTax = !!(matchedLine.tax_id || matchedLine.tax_name || matchedLine.tax_percentage);
    if (!hasTax) {
      // Not a hard fail — mark for review but still produce preview
      // Most SA invoices should have VAT
    }

    // Step 5: Build proposed credit note payload preview
    const cnRef = `TK-${orderId}-${returnRefNum}`;
    preview.credit_note_reference_preview = cnRef;
    preview.recommended_action = 'ready_for_manual_approval';
    readyCount++;

    preview.proposed_credit_note_payload_preview = {
      customer_id: invoice.customer_id,
      invoice_id: invoice.invoice_id,
      reference_number: cnRef,
      date: new Date().toISOString().slice(0, 10),
      line_items: [
        {
          item_id: matchedLine.item_id,
          quantity: quantityReturned,
          rate: expectedCreditAmount / quantityReturned,
          tax_id: matchedLine.tax_id || ''
        }
      ],
      notes: [
        `Takealot return ${rid}`,
        `Takealot order TK-${orderId}`,
        `SKU ${sku}`,
        `Reason: ${ret.return_reason || 'unknown'}`,
        `Outcome: ${outcomeStatuses[0] || 'unknown'}`,
        `Customer-order reversal amount: R${expectedCreditAmount}`
      ].join('\n')
    };

    previews.push(preview);
    logMatch(preview);
  }

  // Build output report
  const report = {
    success: true,
    mode: 'READ_ONLY_PREVIEW',
    date_range: { from: fromStr, to: toStr },
    returns_seen: allReturns.length,
    previews_generated: previews.length,
    ready_for_manual_approval: readyCount,
    manual_review_required: reviewCount,
    previews
  };

  // Output
  if (OUTPUT_JSON) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(JSON.stringify(report, null, 2));
  }

  logTakealotEvent({
    source: 'takealot-credit-preview', event_type: 'credit_preview_completed', level: 'info',
    message: `Preview completed: ${previews.length} previews, ${readyCount} ready, ${reviewCount} review`,
    context: {
      returns_seen: allReturns.length,
      previews_generated: previews.length,
      ready_for_manual_approval: readyCount,
      manual_review_required: reviewCount
    }
  });

  // Queue ready previews if --queue-ready
  if (QUEUE_READY) {
    logTakealotEvent({ source: 'takealot-credit-preview', event_type: 'credit_approval_queue_started', level: 'info', message: 'Queue processing starting', context: { ready_count: readyCount } });

    const queue = loadApprovalQueue();
    const cnMap = buildCreditNoteMap();
    let queued = 0;
    let skipped = 0;

    for (const p of previews) {
      if (p.recommended_action !== 'ready_for_manual_approval') continue;
      if (!p.invoice_found || !p.line_found || !p.amount_match || !p.quantity_match) continue;

      const result = upsertApprovalCandidate(queue, p, cnMap);

      if (result.action === 'queued') {
        queued++;
        logTakealotEvent({ source: 'takealot-credit-preview', event_type: 'credit_approval_candidate_queued', level: 'info', message: `Queued ${result.approval_id}`, context: { approval_id: result.approval_id, seller_return_id: p.seller_return_id, invoice_number: p.invoice_number, sku: p.sku, amount: p.expected_credit_amount } });
      } else if (result.action === 'updated') {
        logTakealotEvent({ source: 'takealot-credit-preview', event_type: 'credit_approval_candidate_queued', level: 'info', message: `Updated ${result.approval_id}`, context: { approval_id: result.approval_id, action: 'updated' } });
      } else {
        skipped++;
        logTakealotEvent({ source: 'takealot-credit-preview', event_type: 'credit_approval_candidate_skipped', level: 'info', message: `Skipped ${result.approval_id}: ${result.reason}`, context: { approval_id: result.approval_id, reason: result.reason } });
      }
    }

    saveApprovalQueue(queue);

    const pendingItems = queue.items.filter(i => i.status === 'pending');
    console.error(`[PREVIEW] Queue: ${queued} new, ${skipped} skipped, ${pendingItems.length} total pending`);

    // Notification for new pending approvals
    if (queued > 0 && !NO_NOTIFY) {
      const first = previews.find(p => p.recommended_action === 'ready_for_manual_approval');
      try {
        await sendNtfyNotification({
          title: 'Takealot credit approval needed',
          message: `${queued} Takealot return(s) ready for credit-note approval. First: TK-${first.order_id}, SKU ${first.sku}, amount R${first.expected_credit_amount}`,
          priority: 'default',
          tags: 'takealot,credit-note'
        });
      } catch (ntfyErr) {
        console.error('[PREVIEW] Notification error (non-fatal): ' + ntfyErr.message);
      }
    }

    logTakealotEvent({ source: 'takealot-credit-preview', event_type: 'credit_approval_queue_completed', level: 'info', message: `Queue completed: ${queued} queued, ${skipped} skipped`, context: { queued, skipped, total_pending: pendingItems.length } });
  }

  console.error(`[PREVIEW] Done: ${previews.length} previews, ${readyCount} ready for approval, ${reviewCount} need manual review`);
}

function logMatch(preview) {
  logTakealotEvent({
    source: 'takealot-credit-preview', event_type: 'credit_preview_return_matched', level: 'info',
    message: `Return ${preview.seller_return_id}: ${preview.recommended_action}`,
    context: {
      seller_return_id: preview.seller_return_id,
      order_id: preview.order_id,
      sku: preview.sku,
      invoice_found: preview.invoice_found,
      line_found: preview.line_found,
      amount_match: preview.amount_match,
      quantity_match: preview.quantity_match,
      recommended_action: preview.recommended_action
    }
  });
}

main().catch(e => {
  logTakealotEvent({ source: 'takealot-credit-preview', event_type: 'credit_preview_failed', level: 'error', message: `Fatal error: ${e.message}`, context: { error_message: e.message } });
  console.error('[PREVIEW] FATAL:', e.message);
  process.exit(1);
});
