#!/usr/bin/env node
// Takealot Order Polling Cron
// Polls Takealot for new orders and creates Zoho Books invoices
// Runs every 30 min via cron
// Deduplication is two-layered: local state + Zoho invoice idempotency check

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const { logTakealotEvent } = require('./takealot-debug-log');

const MCP_URL = 'http://127.0.0.1:9091/mcp/v1';
const STATE_FILE = path.join(__dirname, '.takealot-order-state.json');
const HEALTH_FILE = path.join(__dirname, '.takealot-health.json');
const LOG_FILE = '/home/stan/reports/takealot-orders.log';
const STATE_ID_LIMIT = 1000;
const DEDUPE_LOOKBACK_DAYS = 45;

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function toId(value) {
  if (value === undefined || value === null) return '';
  return String(value).trim();
}

function getOrderId(item) {
  return toId(item.order_id || item.order_number || item.order_item_id);
}

function getOrderItemKey(item) {
  const explicit = toId(item.order_item_id || item.sale_id || item.id);
  if (explicit) return explicit;
  return [
    getOrderId(item),
    toId(item.sku),
    toId(item.quantity || 1),
    toId(item.selling_price || item.unit_price || item.price),
    toId(item.order_date || item.sale_date)
  ].join('|');
}

function uniqueRecent(values, limit = STATE_ID_LIMIT) {
  const seen = new Set();
  const out = [];
  for (let i = values.length - 1; i >= 0; i--) {
    const id = toId(values[i]);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out.reverse().slice(-limit);
}

function normalizeState(state) {
  const safe = state && typeof state === 'object' ? state : {};
  return {
    ...safe,
    last_poll: safe.last_poll || null,
    processed_order_ids: uniqueRecent(Array.isArray(safe.processed_order_ids) ? safe.processed_order_ids : [])
  };
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return normalizeState(JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')));
    }
  } catch (e) {
    log(`State read failed; using empty state: ${e.message}`);
  }
  return normalizeState({ last_poll: null, processed_order_ids: [] });
}

function saveState(state) {
  const clean = normalizeState(state);
  const tmp = STATE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(clean, null, 2));
  fs.renameSync(tmp, STATE_FILE);
  Object.assign(state, clean);
}

function markOrderProcessed(state, orderId) {
  const id = toId(orderId);
  if (!id) return false;
  if (!state.processed_order_ids.map(String).includes(id)) {
    state.processed_order_ids.push(id);
  }
  state.processed_order_ids = uniqueRecent(state.processed_order_ids);
  return true;
}

// V2.1: Health state - atomic write via temp+rename
function loadHealth() {
  try {
    if (fs.existsSync(HEALTH_FILE)) {
      return JSON.parse(fs.readFileSync(HEALTH_FILE, 'utf8'));
    }
  } catch (e) {}
  return {};
}

function saveHealth(updates) {
  try {
    const health = loadHealth();
    Object.assign(health, updates);
    const tmp = HEALTH_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(health, null, 2));
    fs.renameSync(tmp, HEALTH_FILE);
  } catch (e) {
    log('Health write failed (non-fatal): ' + e.message);
  }
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function flattenInvoiceText(inv) {
  const parts = [];
  const add = value => {
    if (value !== undefined && value !== null && value !== '') parts.push(String(value));
  };

  add(inv.invoice_number);
  add(inv.reference_number);
  add(inv.notes);
  add(inv.description);
  add(inv.cf_takealot_order_id);
  add(inv.cf_marketplace_order_id);
  add(inv.cf_channel_order_id);

  if (inv.custom_field_hash && typeof inv.custom_field_hash === 'object') {
    Object.values(inv.custom_field_hash).forEach(add);
  }
  if (Array.isArray(inv.custom_fields)) {
    for (const field of inv.custom_fields) {
      add(field.value);
      add(field.label);
      add(field.api_name);
      add(field.placeholder);
    }
  }

  return parts.join(' ');
}

function invoiceMatchesOrder(inv, orderId) {
  const id = toId(orderId);
  if (!id) return false;

  const directFields = [
    inv.reference_number,
    inv.cf_takealot_order_id,
    inv.cf_marketplace_order_id,
    inv.cf_channel_order_id,
    inv.custom_field_hash?.cf_takealot_order_id,
    inv.custom_field_hash?.cf_marketplace_order_id,
    inv.custom_field_hash?.cf_channel_order_id
  ];

  if (directFields.some(value => toId(value) === id || toId(value) === `TL-${id}` || toId(value) === `TAKEALOT-${id}`)) {
    return true;
  }

  const text = flattenInvoiceText(inv);
  return new RegExp(`(^|[^0-9])${escapeRegExp(id)}([^0-9]|$)`).test(text);
}

function webhookResultIsExisting(result) {
  const status = toId(result.status).toLowerCase();
  const reason = `${toId(result.reason)} ${toId(result.error)} ${toId(result.message)}`.toLowerCase();
  return ['duplicate', 'existing', 'already_exists', 'already_invoiced', 'skipped_existing'].includes(status)
    || reason.includes('duplicate')
    || reason.includes('already')
    || reason.includes('exists');
}

function isoDateDaysAgo(now, days) {
  return new Date(now.getTime() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
}

async function callMCP(toolName, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0', id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    });

    const url = new URL(MCP_URL);
    const options = {
      hostname: url.hostname, port: url.port, path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 60000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`Invalid JSON: ${data.substring(0, 200)}`)); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Timeout')); });
    req.write(payload);
    req.end();
  });
}

async function getTakealotCustomerId() {
  const custResp = await callMCP('get_books_customers', { search: 'Takealot', per_page: 5 });
  if (custResp.error) throw new Error(`Customer lookup MCP error: ${custResp.error.message || JSON.stringify(custResp.error)}`);

  const custText = custResp.result?.content?.[0]?.text || '{}';
  const custData = JSON.parse(custText);
  const contacts = custData.contacts || [];
  const existing = contacts.find(c => String(c.contact_name || '').includes('Takealot'));
  if (!existing) throw new Error('No "Takealot" customer found in Zoho Books. Create one first.');

  log(`Using customer: ${existing.contact_name} (${existing.contact_id})`);
  return existing.contact_id;
}

async function findExistingZohoInvoiceForOrder(orderId, customerId, dateStart, dateEnd) {
  const perPage = 200;
  const maxPages = 10;

  for (let page = 1; page <= maxPages; page++) {
    const resp = await callMCP('get_books_invoices', {
      customer_id: customerId,
      date_start: dateStart,
      date_end: dateEnd,
      per_page: perPage,
      page
    });
    if (resp.error) throw new Error(`Invoice dedupe lookup MCP error: ${resp.error.message || JSON.stringify(resp.error)}`);

    const text = resp.result?.content?.[0]?.text || '{}';
    const data = JSON.parse(text);
    const invoices = data.invoices || [];
    const match = invoices.find(inv => invoiceMatchesOrder(inv, orderId));
    if (match) return match;

    const pageContext = data.page_context || {};
    const hasMore = pageContext.has_more_page === true || invoices.length === perPage;
    if (!hasMore) break;

    await new Promise(r => setTimeout(r, 250));
  }

  return null;
}

function groupOrders(orders) {
  const grouped = {};
  let badRows = 0;
  let duplicateRows = 0;

  for (const item of orders) {
    const oid = getOrderId(item);
    if (!oid) {
      badRows++;
      continue;
    }

    if (!grouped[oid]) grouped[oid] = { order_id: oid, items: [], item_keys: new Set(), order_date: item.order_date };

    const itemKey = getOrderItemKey(item);
    if (grouped[oid].item_keys.has(itemKey)) {
      duplicateRows++;
      continue;
    }

    grouped[oid].item_keys.add(itemKey);
    grouped[oid].items.push(item);
  }

  for (const group of Object.values(grouped)) delete group.item_keys;
  return { grouped, badRows, duplicateRows };
}

async function postOrderToWebhook(orderId, orderItems) {
  return new Promise((resolve, reject) => {
    const secret = process.env.TAKEALOT_WEBHOOK_SECRET || '';
    const postData = JSON.stringify({
      order_id: orderId,
      sales: [{ order_id: orderId, line_items: orderItems }]
    });
    const url = new URL(`http://127.0.0.1:9091/takealot/webhook/orders?secret=${secret}`);
    const options = {
      hostname: url.hostname, port: url.port,
      path: url.pathname + url.search,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
      timeout: 30000
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({ error: data }); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Webhook timeout')); });
    req.write(postData);
    req.end();
  });
}

async function main() {
  log('Order poll starting...');
  logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_started', level: 'info', message: 'Order poll starting' });
  saveHealth({ last_started_at: new Date().toISOString() });
  const state = loadState();

  // Poll orders from the last 2 days (overlap window to catch any missed)
  const now = new Date();
  const twoDaysAgo = new Date(now - 2 * 24 * 60 * 60 * 1000);
  const startDate = twoDaysAgo.toISOString().split('T')[0];
  const endDate = now.toISOString().split('T')[0];
  const dedupeStartDate = isoDateDaysAgo(now, DEDUPE_LOOKBACK_DAYS);

  let resp;
  try {
    resp = await callMCP('takealot/get_sales', {
      start_date: startDate,
      end_date: endDate,
      page_size: 100
    });
  } catch (e) {
    log(`ERROR: Failed to fetch orders: ${e.message}`);
    saveHealth({ last_error_at: now.toISOString(), last_error_message: e.message });
    process.exit(1);
  }

  if (resp.error) {
    const msg = resp.error.message || JSON.stringify(resp.error);
    log(`ERROR: MCP error: ${msg}`);
    saveHealth({ last_error_at: now.toISOString(), last_error_message: msg });
    process.exit(1);
  }

  const resultText = resp.result?.content?.[0]?.text || '{}';
  let orderData;
  try { orderData = JSON.parse(resultText); } catch (e) {
    log(`ERROR: Invalid order data: ${resultText.substring(0, 200)}`);
    saveHealth({ last_error_at: now.toISOString(), last_error_message: 'Invalid order data' });
    process.exit(1);
  }

  const orders = orderData.sales || orderData.orders || [];
  log(`Fetched ${orders.length} order rows (${startDate} to ${endDate})`);
  logTakealotEvent({ source: 'takealot-order-poll', event_type: 'orders_fetched', level: 'info', message: `Fetched ${orders.length} order rows`, context: { orders_seen: orders.length, start_date: startDate, end_date: endDate } });

  if (orders.length === 0) {
    state.last_poll = now.toISOString();
    saveState(state);
    saveHealth({ last_success_at: now.toISOString(), orders_seen: 0, distinct_orders_seen: 0, orders_created: 0, orders_skipped_existing: 0 });
    log('No orders found. Done.');
    logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_no_orders', level: 'info', message: 'No orders found', context: { orders_seen: 0 } });
    return;
  }

  const { grouped, badRows, duplicateRows } = groupOrders(orders);
  const distinctOrderCount = Object.keys(grouped).length;
  const processedSet = new Set(state.processed_order_ids.map(String));
  const candidateEntries = Object.entries(grouped).filter(([orderId]) => !processedSet.has(orderId));
  const skippedByState = distinctOrderCount - candidateEntries.length;
  const candidateLineItems = candidateEntries.reduce((sum, [, order]) => sum + order.items.length, 0);

  log(`Grouped into ${distinctOrderCount} distinct orders (${duplicateRows} duplicate rows removed, ${badRows} bad rows ignored)`);
  log(`Orders to process: ${candidateEntries.length} (${skippedByState} skipped by local state)`);

  if (candidateEntries.length === 0) {
    state.last_poll = now.toISOString();
    saveState(state);
    saveHealth({ last_success_at: now.toISOString(), orders_seen: orders.length, distinct_orders_seen: distinctOrderCount, orders_created: 0, orders_skipped_existing: skippedByState, duplicate_rows_removed: duplicateRows });
    log('All orders already processed by local state. Done.');
    logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_all_processed', level: 'info', message: 'All orders already processed by local state', context: { orders_seen: orders.length, distinct_orders_seen: distinctOrderCount, orders_skipped_existing: skippedByState } });
    return;
  }

  let customerId;
  try {
    customerId = await getTakealotCustomerId();
  } catch (e) {
    log(`ERROR: ${e.message}`);
    saveHealth({ last_error_at: now.toISOString(), last_error_message: e.message });
    process.exit(1);
  }

  let created = 0;
  let errors = 0;
  let skippedExisting = skippedByState;

  for (const [orderId, order] of candidateEntries) {
    try {
      const existingInvoice = await findExistingZohoInvoiceForOrder(orderId, customerId, dedupeStartDate, endDate);
      if (existingInvoice) {
        markOrderProcessed(state, orderId);
        skippedExisting++;
        log(`  DEDUPE: Order ${orderId} already has Zoho invoice ${existingInvoice.invoice_number || existingInvoice.invoice_id || '(unknown)'} - skipping create`);
        logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_invoice_dedupe_hit', level: 'info', message: `Existing Zoho invoice found for order ${orderId}`, context: { order_id: orderId, invoice_number: existingInvoice.invoice_number || '', invoice_id: existingInvoice.invoice_id || '' } });
        continue;
      }

      // Match order items to Zoho items by SKU. This validates before webhook create.
      const lineItems = [];
      for (const item of order.items) {
        const sku = item.sku || '';
        if (!sku) continue;

        const itemResp = await callMCP('get_books_items', { search: sku, per_page: 5 });
        const itemText = itemResp.result?.content?.[0]?.text || '{}';
        const itemData = JSON.parse(itemText);
        const zohoItem = (itemData.items || []).find(i => i.sku === sku);

        if (zohoItem) {
          lineItems.push({
            item_id: zohoItem.item_id,
            quantity: item.quantity || 1,
            rate: item.selling_price || zohoItem.rate
          });
        } else {
          log(`  SKU ${sku} not found in Zoho - order ${orderId} will not be marked processed`);
        }
      }

      if (lineItems.length === 0) {
        log(`  Order ${orderId}: no matching Zoho items - not marked processed, will retry next poll`);
        errors++;
        continue;
      }

      const createResp = await postOrderToWebhook(orderId, order.items);

      // Only mark processed on success or proven existing invoice; never mark failed orders.
      let orderInvoiced = false;
      let orderAlreadyExists = false;
      if (createResp.success) {
        const results = createResp.results || [];
        for (const r of results) {
          if (r.status === 'invoiced') {
            log(`  OK Order ${orderId} -> Invoice ${r.invoice_number} (R${r.total})`);
            created++;
            orderInvoiced = true;
            saveHealth({ last_takealot_order_id: orderId, last_zoho_invoice_number: r.invoice_number || '', last_zoho_invoice_id: r.invoice_id || '' });
            logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_invoice_created', level: 'info', message: `Invoice created for order ${orderId}`, context: { order_id: orderId, invoice_number: r.invoice_number, total: r.total, item_count: order.items.length } });
          } else if (webhookResultIsExisting(r)) {
            log(`  DEDUPE: Order ${orderId}: webhook says existing/duplicate - ${r.reason || r.error || r.status || ''}`);
            orderAlreadyExists = true;
          } else {
            log(`  WARNING Order ${orderId}: ${r.status} - ${r.reason || r.error || ''}`);
          }
        }
      } else {
        log(`  ERROR Order ${orderId}: webhook returned error - ${JSON.stringify(createResp).substring(0, 200)}`);
        errors++;
      }

      if (orderInvoiced || orderAlreadyExists) {
        markOrderProcessed(state, orderId);
        if (orderAlreadyExists && !orderInvoiced) skippedExisting++;
      } else {
        log(`  PENDING Order ${orderId}: not marked as processed - will retry next poll`);
      }

      await new Promise(r => setTimeout(r, 1000));

    } catch (e) {
      log(`  ERROR Order ${orderId}: ${e.message}`);
      errors++;
    }
  }

  state.last_poll = now.toISOString();
  saveState(state);
  saveHealth({
    last_success_at: now.toISOString(),
    orders_seen: orders.length,
    distinct_orders_seen: distinctOrderCount,
    orders_created: created,
    orders_skipped_existing: skippedExisting,
    duplicate_rows_removed: duplicateRows,
    bad_rows_ignored: badRows
  });
  log(`Done. Created ${created} invoices, skipped ${skippedExisting} existing, ${errors} errors, ${candidateLineItems} candidate rows checked.`);
  logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_completed', level: 'info', message: `Poll completed: ${created} created, ${skippedExisting} skipped existing, ${errors} errors`, context: { orders_seen: orders.length, distinct_orders_seen: distinctOrderCount, orders_created: created, orders_skipped_existing: skippedExisting, errors, candidate_rows_checked: candidateLineItems, duplicate_rows_removed: duplicateRows } });
}

// Load env for webhook secret
require('dotenv').config({ path: path.join(__dirname, '.env') });
main().catch(e => { log(`FATAL: ${e.message}`); logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_failed', level: 'error', message: `Fatal error: ${e.message}`, context: { error_message: e.message, stage: 'main' } }); saveHealth({ last_error_at: new Date().toISOString(), last_error_message: e.message }); process.exit(1); });
