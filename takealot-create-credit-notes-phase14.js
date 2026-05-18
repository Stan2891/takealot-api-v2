#!/usr/bin/env node
// Phase 14 — Controlled Zoho credit-note creation for approved Takealot returns
// One-shot script. Creates credit notes, applies to invoices, records state, notifies.
// Hard-coded to the two approved returns ONLY.

require('dotenv').config();
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const ORG_ID = process.env.ZOHO_BOOKS_ORGANIZATION_ID;
const DC = process.env.ZOHO_DATA_CENTER || 'com';
const BOOKS_BASE = `https://www.zohoapis.${DC}/books/v3`;

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

// ---- Notification ----
async function notify(title, message) {
  try {
    if (process.env.NTFY_ENABLED !== 'true' || !process.env.NTFY_TOPIC) return { sent: false };
    const server = process.env.NTFY_SERVER || 'https://ntfy.sh';
    const resp = await axios.post(`${server}/${process.env.NTFY_TOPIC}`, message, {
      headers: { Title: title, Priority: 'default', Tags: 'takealot,credit-note' },
      timeout: 10000
    });
    return { sent: true, status: resp.status };
  } catch (e) {
    return { sent: false, error: e.message };
  }
}

// ---- Atomic state write ----
const STATE_FILE = path.join(__dirname, '.takealot-credit-note-state.json');

function loadState() {
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); }
  catch { return { created_credit_notes: [] }; }
}

function saveState(state) {
  const tmp = STATE_FILE + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
  fs.renameSync(tmp, STATE_FILE);
}

// ---- Approved returns (hard-coded for Phase 14) ----
const APPROVED = [
  {
    seller_return_id: 7603248,
    return_reference_number: 'RRN-CW488-JQO7',
    order_id: 209923987,
    zoho_invoice_id: '5377650000015592002',
    zoho_invoice_number: 'INV-005737',
    sku: '11517586925',
    expected_amount: 2342,
    expected_quantity: 1,
    return_reason: 'defective_or_damaged',
    outcome_status: 'removal_order'
  },
  {
    seller_return_id: 7589922,
    return_reference_number: 'RRN-VVAXX-XWGR',
    order_id: 209782047,
    zoho_invoice_id: '5377650000015436003',
    zoho_invoice_number: 'INV-005715',
    sku: '61319217329',
    expected_amount: 750,
    expected_quantity: 1,
    return_reason: 'defective_or_damaged',
    outcome_status: 'removal_order'
  }
];

async function main() {
  const results = [];
  const state = loadState();

  for (const ret of APPROVED) {
    const ref = `TK-${ret.order_id}-${ret.return_reference_number}`;
    const result = {
      seller_return_id: ret.seller_return_id,
      order_id: ret.order_id,
      invoice_number: ret.zoho_invoice_number,
      sku: ret.sku,
      amount: ret.expected_amount,
      reference: ref,
      precheck_passed: false,
      duplicate_credit_note_found: false,
      credit_note_created: false,
      credit_note_number: null,
      credit_note_id: null,
      applied_to_invoice: false,
      notification_sent: false,
      local_state_recorded: false,
      error: null
    };

    try {
      // Step 1: Duplicate check — search credit notes by reference
      console.log(`[CN] Checking for duplicate: ${ref}`);
      const cnSearch = await zohoGet('/creditnotes', { reference_number: ref });
      const existing = (cnSearch.creditnotes || []).find(cn => cn.reference_number === ref);
      if (existing) {
        result.duplicate_credit_note_found = true;
        result.credit_note_number = existing.creditnote_number;
        result.credit_note_id = existing.creditnote_id;
        result.error = 'already_exists';
        console.log(`[CN] SKIP: Credit note ${existing.creditnote_number} already exists for ${ref}`);
        results.push(result);
        continue;
      }

      // Step 2: Re-read invoice and verify
      console.log(`[CN] Re-reading invoice ${ret.zoho_invoice_number}`);
      const invResp = await zohoGet(`/invoices/${ret.zoho_invoice_id}`);
      const inv = invResp.invoice;

      if (!inv) throw new Error('Invoice not found');
      if (!['overdue', 'sent', 'unpaid', 'partially_paid'].includes(inv.status)) {
        throw new Error(`Invoice status ${inv.status} not eligible for credit note`);
      }

      const line = (inv.line_items || []).find(li => li.sku === ret.sku);
      if (!line) throw new Error(`SKU ${ret.sku} not found in invoice line items`);
      if (line.quantity !== ret.expected_quantity) {
        throw new Error(`Quantity mismatch: invoice=${line.quantity} expected=${ret.expected_quantity}`);
      }
      const amtDiff = Math.abs(line.item_total - ret.expected_amount);
      if (amtDiff > 1.00) {
        throw new Error(`Amount mismatch: invoice_line_total=${line.item_total} expected=${ret.expected_amount} diff=${amtDiff}`);
      }

      result.precheck_passed = true;
      console.log(`[CN] Precheck passed for ${ref}`);

      // Step 3: Create credit note
      const cnBody = {
        customer_id: inv.customer_id,
        reference_number: ref,
        date: new Date().toISOString().slice(0, 10),
        notes: [
          `Takealot return ${ret.seller_return_id}`,
          `Takealot order TK-${ret.order_id}`,
          `SKU ${ret.sku}`,
          `Reason: ${ret.return_reason}`,
          `Outcome: ${ret.outcome_status}`,
          `Customer-order reversal amount: R${ret.expected_amount}`
        ].join('\n'),
        line_items: [
          {
            item_id: line.item_id,
            quantity: ret.expected_quantity,
            rate: ret.expected_amount / ret.expected_quantity,
            tax_id: line.tax_id || ''
          }
        ]
      };

      console.log(`[CN] Creating credit note for ${ref}, amount R${ret.expected_amount}`);
      const createResp = await zohoPost('/creditnotes', cnBody);
      const cn = createResp.creditnote;

      if (!cn || !cn.creditnote_id) throw new Error('Credit note creation returned no creditnote_id');

      result.credit_note_created = true;
      result.credit_note_number = cn.creditnote_number;
      result.credit_note_id = cn.creditnote_id;
      console.log(`[CN] Created ${cn.creditnote_number} (${cn.creditnote_id})`);

      // Step 4: Apply credit note to invoice
      try {
        console.log(`[CN] Applying ${cn.creditnote_number} to ${ret.zoho_invoice_number}`);
        const applyBody = {
          invoices: [
            {
              invoice_id: ret.zoho_invoice_id,
              amount_applied: ret.expected_amount
            }
          ]
        };
        await zohoPost(`/creditnotes/${cn.creditnote_id}/invoices`, applyBody);
        result.applied_to_invoice = true;
        console.log(`[CN] Applied R${ret.expected_amount} to ${ret.zoho_invoice_number}`);
      } catch (applyErr) {
        console.error(`[CN] WARNING: Apply failed: ${applyErr.message}`);
        result.error = `created_but_apply_failed: ${applyErr.message}`;
      }

      // Step 5: Save state
      try {
        state.created_credit_notes.push({
          seller_return_id: ret.seller_return_id,
          return_reference_number: ret.return_reference_number,
          order_id: ret.order_id,
          zoho_invoice_id: ret.zoho_invoice_id,
          zoho_invoice_number: ret.zoho_invoice_number,
          zoho_creditnote_id: cn.creditnote_id,
          zoho_creditnote_number: cn.creditnote_number,
          reference_number: ref,
          amount: ret.expected_amount,
          applied_to_invoice: result.applied_to_invoice,
          created_at: new Date().toISOString()
        });
        saveState(state);
        result.local_state_recorded = true;
      } catch (stateErr) {
        console.error(`[CN] WARNING: State save failed: ${stateErr.message}`);
      }

      // Step 6: Notify
      const ntfyResult = await notify(
        'Takealot credit note created',
        `Credit note ${cn.creditnote_number} created for TK-${ret.order_id}, invoice ${ret.zoho_invoice_number}, SKU ${ret.sku}, amount R${ret.expected_amount}`
      );
      result.notification_sent = ntfyResult.sent;

    } catch (err) {
      result.error = err.message;
      console.error(`[CN] ERROR for ${ref}: ${err.message}`);
    }

    results.push(result);
  }

  console.log(JSON.stringify({ results }, null, 2));
}

main().catch(err => { console.error(`[CN] Fatal: ${err.message}`); process.exit(1); });
