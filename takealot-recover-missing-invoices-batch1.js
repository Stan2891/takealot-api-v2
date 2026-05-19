#!/usr/bin/env node
/**
 * One-off recovery script: Batch 1 historical missing invoices
 * Posts exactly 5 Takealot orders to local webhook for SO/Invoice creation.
 * Safe: only processes the hardcoded Batch 1 order IDs.
 * No Takealot writes, no credit notes.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const http = require('http');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const BATCH1_IDS = ['210222809', '210291249', '210292588', '210360258', '210375917'];
const STATE_FILE = path.join(__dirname, '.takealot-order-state.json');
const LOG_FILE = '/home/stan/reports/takealot-orders.log';

function log(msg) {
  const line = `[${new Date().toISOString()}] [BATCH1-RECOVERY] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(LOG_FILE, line + '\n'); } catch (e) {}
}

function logTakealotEvent(evt) {
  try {
    const { logTakealotEvent: ld } = require('./takealot-debug-log');
    ld(evt);
  } catch (e) {}
}

async function main() {
  log('Starting Batch 1 historical recovery for order IDs: ' + BATCH1_IDS.join(', '));
  logTakealotEvent({ source: 'batch1-recovery', event_type: 'batch1_recovery_started', level: 'info',
    message: 'Batch 1 recovery started', context: { order_ids: BATCH1_IDS } });

  // Load Takealot line items
  const lineItems = JSON.parse(fs.readFileSync('/home/stan/reports/batch1-line-items.json', 'utf8'));
  
  // Group by order_id
  const grouped = {};
  for (const item of lineItems) {
    const oid = String(item.order_id);
    if (!BATCH1_IDS.includes(oid)) continue;
    if (!grouped[oid]) grouped[oid] = [];
    grouped[oid].push(item);
  }

  const webhookSecret = process.env.TAKEALOT_WEBHOOK_SECRET || '';
  const results = [];
  let created = 0, errors = 0;

  for (const orderId of BATCH1_IDS) {
    const items = grouped[orderId];
    if (!items || items.length === 0) {
      log(`  ⚠️ Order ${orderId}: no line items found — skipping`);
      results.push({ order_id: orderId, status: 'skipped', reason: 'no_line_items' });
      continue;
    }

    log(`  Processing order ${orderId} (${items.length} item(s))...`);

    const postData = JSON.stringify({
      order_id: orderId,
      sales: [{ order_id: orderId, line_items: items }]
    });

    try {
      const createResp = await new Promise((resolve, reject) => {
        const url = new URL(`http://127.0.0.1:9091/takealot/webhook/orders?secret=${webhookSecret}`);
        const options = {
          hostname: url.hostname, port: url.port,
          path: url.pathname + url.search,
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) },
          timeout: 60000
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

      let orderInvoiced = false;
      if (createResp.success) {
        const respResults = createResp.results || [];
        for (const r of respResults) {
          if (r.status === 'invoiced') {
            log(`  ✅ Order ${orderId} → Invoice ${r.invoice_number} (R${r.total})`);
            created++;
            orderInvoiced = true;
            results.push({ order_id: orderId, status: 'invoiced', invoice_number: r.invoice_number, salesorder_number: r.salesorder_number, total: r.total });
            logTakealotEvent({ source: 'batch1-recovery', event_type: 'order_invoice_created', level: 'info',
              message: `Batch 1 invoice created for order ${orderId}`, context: { order_id: orderId, invoice_number: r.invoice_number, total: r.total } });
          } else {
            log(`  ⚠️ Order ${orderId}: ${r.status} — ${r.reason || r.error || ''}`);
            results.push({ order_id: orderId, status: r.status, reason: r.reason || r.error });
          }
        }
      } else {
        log(`  ❌ Order ${orderId}: webhook error — ${JSON.stringify(createResp).substring(0, 200)}`);
        errors++;
        results.push({ order_id: orderId, status: 'error', error: JSON.stringify(createResp).substring(0, 200) });
      }

      // Only mark as processed if invoiced
      if (orderInvoiced) {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
        for (const item of items) {
          const itemId = String(item.order_id || item.order_item_id);
          if (!state.processed_order_ids.includes(itemId)) {
            state.processed_order_ids.push(itemId);
          }
        }
        fs.writeFileSync(STATE_FILE + '.tmp', JSON.stringify(state, null, 2));
        fs.renameSync(STATE_FILE + '.tmp', STATE_FILE);
      } else {
        log(`  ⏳ Order ${orderId}: not marked as processed — failed`);
      }

    } catch (e) {
      log(`  ❌ Order ${orderId} error: ${e.message}`);
      errors++;
      results.push({ order_id: orderId, status: 'error', error: e.message });
    }

    // Rate limit between orders
    await new Promise(r => setTimeout(r, 1500));
  }

  log(`Batch 1 recovery done. Created: ${created}, Errors: ${errors}`);
  logTakealotEvent({ source: 'batch1-recovery', event_type: 'batch1_recovery_completed', level: 'info',
    message: `Batch 1 done: ${created} created, ${errors} errors`, context: { created, errors, results } });

  console.log(JSON.stringify({ created, errors, results }, null, 2));
}

main().catch(e => {
  log(`FATAL: ${e.message}`);
  logTakealotEvent({ source: 'batch1-recovery', event_type: 'batch1_recovery_failed', level: 'error',
    message: `Fatal: ${e.message}`, context: { error: e.message } });
  process.exit(1);
});
