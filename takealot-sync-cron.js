#!/usr/bin/env node
// Takealot Stock & Price Sync Cron Job
// Runs via cron/systemd timer every 15-30 minutes
// Calls the MCP server's takealot/sync_stock tool
const http = require('http');

const MCP_URL = 'http://127.0.0.1:9091/mcp/v1';
const SYNC_PRICES = process.argv.includes('--sync-prices');
const DRY_RUN = process.argv.includes('--dry-run');

async function callMCP(toolName, args) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: toolName, arguments: args }
    });

    const url = new URL(MCP_URL);
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
      timeout: 120000
    };

    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(new Error(`Invalid JSON: ${data.substring(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('Request timeout')); });
    req.write(payload);
    req.end();
  });
}

async function main() {
  const ts = new Date().toISOString();
  console.log(`[${ts}] Takealot sync starting (dry_run=${DRY_RUN}, sync_prices=${SYNC_PRICES})`);

  try {
    const resp = await callMCP('takealot/sync_stock', {
      dry_run: DRY_RUN,
      sync_prices: SYNC_PRICES
    });

    if (resp.error) {
      console.error(`[${ts}] MCP error:`, resp.error.message || JSON.stringify(resp.error));
      process.exit(1);
    }

    const resultText = resp.result?.content?.[0]?.text || '{}';
    const result = JSON.parse(resultText);

    console.log(`[${ts}] Sync complete:`, JSON.stringify(result.summary || {}, null, 2));
    if (result.applied && result.applied.length > 0) {
      console.log(`[${ts}] Applied ${result.applied.length} changes`);
      const errors = result.applied.filter(a => a.status === 'error');
      if (errors.length > 0) {
        console.error(`[${ts}] ${errors.length} errors:`, JSON.stringify(errors));
      }
    }
  } catch (err) {
    console.error(`[${ts}] Sync failed:`, err.message);
    process.exit(1);
  }
}

main();
