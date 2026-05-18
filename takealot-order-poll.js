#!/usr/bin/env node
// Takealot Order Polling Cron
// Polls Takealot for new orders and creates Zoho Books invoices
// Runs every 30 min via cron
// State file tracks last processed order to avoid duplicates

const http = require('http');
const fs = require('fs');
const path = require('path');
const { logTakealotEvent } = require('./takealot-debug-log');

const MCP_URL = 'http://127.0.0.1:9091/mcp/v1';
const STATE_FILE = path.join(__dirname, '.takealot-order-state.json');
const HEALTH_FILE = path.join(__dirname, '.takealot-health.json');
const LOG_FILE = '/home/stan/reports/takealot-orders.log';

function log(msg) {
  const ts = new Date().toISOString();
  const line = `[${ts}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function loadState() {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    }
  } catch (e) {}
  return { last_poll: null, processed_order_ids: [] };
}

function saveState(state) {
  // Keep only last 500 order IDs to prevent file bloat
  if (state.processed_order_ids.length > 500) {
    state.processed_order_ids = state.processed_order_ids.slice(-500);
  }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// V2.1: Health state — atomic write via temp+rename
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

  let resp;
  try {
    resp = await callMCP('takealot/get_sales', {
      start_date: startDate,
      end_date: endDate,
      page_size: 100
    });
  } catch (e) {
    log(`ERROR: Failed to fetch orders: ${e.message}`);
    process.exit(1);
  }

  if (resp.error) {
    log(`ERROR: MCP error: ${resp.error.message || JSON.stringify(resp.error)}`);
    process.exit(1);
  }

  const resultText = resp.result?.content?.[0]?.text || '{}';
  let orderData;
  try { orderData = JSON.parse(resultText); } catch (e) {
    log(`ERROR: Invalid order data: ${resultText.substring(0, 200)}`);
    process.exit(1);
  }

  const orders = orderData.sales || orderData.orders || [];
  log(`Fetched ${orders.length} orders (${startDate} to ${endDate})`);
  logTakealotEvent({ source: 'takealot-order-poll', event_type: 'orders_fetched', level: 'info', message: `Fetched ${orders.length} orders`, context: { orders_seen: orders.length, start_date: startDate, end_date: endDate } });

  if (orders.length === 0) {
    state.last_poll = now.toISOString();
    saveState(state);
    saveHealth({ last_success_at: now.toISOString(), orders_seen: 0, orders_created: 0, orders_skipped_existing: 0 });
    log('No orders found. Done.');
    logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_no_orders', level: 'info', message: 'No orders found', context: { orders_seen: 0 } });
    return;
  }

  // Filter out already-processed orders
  const processedSet = new Set(state.processed_order_ids.map(String));
  const newOrders = orders.filter(o => {
    const orderId = String(o.order_id || o.order_item_id || '');
    return orderId && !processedSet.has(orderId);
  });

  log(`New orders to process: ${newOrders.length} (${orders.length - newOrders.length} already processed)`);

  if (newOrders.length === 0) {
    state.last_poll = now.toISOString();
    saveState(state);
    saveHealth({ last_success_at: now.toISOString(), orders_seen: orders.length, orders_created: 0, orders_skipped_existing: orders.length });
    log('All orders already processed. Done.');
    logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_all_processed', level: 'info', message: 'All orders already processed', context: { orders_seen: orders.length, orders_skipped_existing: orders.length } });
    return;
  }

  // Group order items by order_id (Takealot returns individual line items)
  const grouped = {};
  for (const item of newOrders) {
    const oid = String(item.order_id || 'unknown');
    if (!grouped[oid]) grouped[oid] = { order_id: oid, items: [], order_date: item.order_date };
    grouped[oid].items.push(item);
  }

  log(`Grouped into ${Object.keys(grouped).length} distinct orders`);

  // Process each order: find/create Takealot customer, match items, create invoice
  let created = 0;
  let errors = 0;

  for (const [orderId, order] of Object.entries(grouped)) {
    try {
      // Search Zoho for "Takealot Marketplace" customer
      const custResp = await callMCP('get_books_customers', { search: 'Takealot', per_page: 5 });
      const custText = custResp.result?.content?.[0]?.text || '{}';
      const custData = JSON.parse(custText);
      const contacts = custData.contacts || [];
      let customerId = null;

      const existing = contacts.find(c => c.contact_name.includes('Takealot'));
      if (existing) {
        customerId = existing.contact_id;
        log(`  Using customer: ${existing.contact_name} (${customerId})`);
      } else {
        log(`WARNING: No "Takealot" customer found in Zoho Books. Create one first.`);
        errors++;
        continue;
      }

      // Match order items to Zoho items by SKU
      const lineItems = [];
      for (const item of order.items) {
        const sku = item.sku || '';
        if (!sku) continue;

        // Search Zoho for this SKU
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
          log(`  SKU ${sku} not found in Zoho — skipping line item`);
        }
      }

      if (lineItems.length === 0) {
        log(`  Order ${orderId}: no matching Zoho items — skipping`);
        // Still mark as processed to avoid retrying
        for (const item of order.items) {
          state.processed_order_ids.push(String(item.order_id || item.order_item_id));
        }
        continue;
      }

      // Create draft invoice via MCP
      const invoiceResp = await callMCP('get_books_invoices', { status: 'draft', per_page: 1 });
      // Actually create the invoice by calling the Zoho API through the existing webhook handler
      const invoicePayload = {
        jsonrpc: '2.0', id: 1,
        method: 'tools/call',
        params: {
          name: 'get_books_invoices', // placeholder — we need a create_invoice tool
          arguments: {}
        }
      };

      // Use the webhook endpoint directly to create the invoice
      const createResp = await new Promise((resolve, reject) => {
        const secret = process.env.TAKEALOT_WEBHOOK_SECRET || '';
        const postData = JSON.stringify({
          order_id: orderId,
          sales: [{ order_id: orderId, line_items: order.items }]
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
        req.write(postData);
        req.end();
      });

      if (createResp.success) {
        const results = createResp.results || [];
        for (const r of results) {
          if (r.status === 'invoiced') {
            log(`  ✅ Order ${orderId} → Invoice ${r.invoice_number} (R${r.total})`);
            created++;
            saveHealth({ last_takealot_order_id: orderId, last_zoho_invoice_number: r.invoice_number || '', last_zoho_invoice_id: r.invoice_id || '' });
            logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_invoice_created', level: 'info', message: `Invoice created for order ${orderId}`, context: { order_id: orderId, invoice_number: r.invoice_number, total: r.total, item_count: order.items.length } });
          } else {
            log(`  ⚠️ Order ${orderId}: ${r.status} — ${r.reason || r.error || ''}`);
          }
        }
      } else {
        log(`  ❌ Order ${orderId}: webhook returned error — ${JSON.stringify(createResp).substring(0, 200)}`);
        errors++;
      }

      // Mark all items in this order as processed
      for (const item of order.items) {
        state.processed_order_ids.push(String(item.order_id || item.order_item_id));
      }

      // Rate limit between orders
      await new Promise(r => setTimeout(r, 1000));

    } catch (e) {
      log(`  ❌ Order ${orderId} error: ${e.message}`);
      errors++;
    }
  }

  state.last_poll = now.toISOString();
  saveState(state);
  saveHealth({ last_success_at: now.toISOString(), orders_seen: orders.length, orders_created: created, orders_skipped_existing: orders.length - newOrders.length });
  log(`Done. Created ${created} invoices, ${errors} errors, ${newOrders.length} items processed.`);
  logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_completed', level: 'info', message: `Poll completed: ${created} created, ${errors} errors`, context: { orders_seen: orders.length, orders_created: created, errors, new_items_processed: newOrders.length } });
}

// Load env for webhook secret
require('dotenv').config({ path: path.join(__dirname, '.env') });
main().catch(e => { log(`FATAL: ${e.message}`); logTakealotEvent({ source: 'takealot-order-poll', event_type: 'order_poll_failed', level: 'error', message: `Fatal error: ${e.message}`, context: { error_message: e.message, stage: 'main' } }); saveHealth({ last_error_at: new Date().toISOString(), last_error_message: e.message }); process.exit(1); });
