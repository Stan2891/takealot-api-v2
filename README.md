# Takealot API V2.1

Takealot Marketplace integration for Zoho Books/Inventory — returns detection, credit-note workflow, health monitoring.

## Features

- **Order Polling** — Polls Takealot sales, creates Zoho Sales Orders → Invoices
- **Stock Sync** — Syncs Zoho Inventory stock levels to Takealot offers
- **Price Sync** — Syncs Zoho prices to Takealot (daily)
- **Returns Detection** — Fetches returns from Marketplace API v1
- **Credit-Note Workflow** — Matches returns → invoices → builds/approves credit notes
- **Health Monitoring** — Tracks poller health, alerts on stale/error states
- **Notifications** — ntfy.sh push notifications for orders, returns, credit notes

## Files

| File | Purpose |
|------|---------|
| `takealot-connector.js` | Takealot Seller API v2 client (offers, sales, orders) |
| `takealot-marketplace-client.js` | Takealot Marketplace API v1 client (returns) |
| `takealot-order-poll.js` | Order polling cron script |
| `takealot-sync-cron.js` | Stock/price sync cron script |
| `takealot-returns-check.js` | Returns detection (read-only) |
| `takealot-credit-preview.js` | Match returns → invoices → build credit-note previews |
| `takealot-credit-approval-queue.js` | Local JSON approval queue |
| `takealot-credit-approve.js` | Manual approval CLI |
| `takealot-create-credit-notes-phase14.js` | One-shot credit-note creation script |
| `takealot-health-check.js` | Poller health monitoring |
| `takealot-order-poll-heartbeat.sh` | Health state writer |
| `notification-helper.js` | ntfy.sh notifications with retry/cooldown |
| `takealot-debug-log.js` | Unified JSONL audit logger |
| `takealot-integration-audit.md` | Technical audit document |

## Environment Variables

```bash
# Takealot
TAKEALOT_API_KEY=your_api_key

# Zoho
ZOHO_CLIENT_ID=your_client_id
ZOHO_CLIENT_SECRET=your_client_secret
ZOHO_REFRESH_TOKEN=your_refresh_token
ZOHO_BOOKS_ORGANIZATION_ID=your_org_id
ZOHO_DATA_CENTER=com  # or eu, in, au

# Notifications (optional)
NTFY_ENABLED=true
NTFY_SERVER=https://ntfy.sh
NTFY_TOPIC=your_topic
NTFY_EMAIL=your@email.com  # optional
```

## Usage

### Order Polling
```bash
node takealot-order-poll.js
```

### Stock Sync
```bash
node takealot-sync-cron.js              # stock only
node takealot-sync-cron.js --sync-prices # stock + prices
```

### Returns Check
```bash
node takealot-returns-check.js --dry-run --days 30
```

### Credit-Note Preview
```bash
node takealot-credit-preview.js --days 30 --queue-ready
```

### Credit-Note Approval
```bash
node takealot-credit-approve.js --list
node takealot-credit-approve.js --approve RET-XXXX
node takealot-credit-approve.js --approve RET-XXXX --execute
```

### Health Check
```bash
node takealot-health-check.js --max-age-minutes 90
```

## Cron Setup (Example)

```cron
# Order polling every 30 min
*/30 * * * * cd /path/to/project && node takealot-order-poll.js >> /var/log/takealot-orders.log 2>&1

# Stock sync hourly
0 * * * * cd /path/to/project && node takealot-sync-cron.js >> /var/log/takealot-sync.log 2>&1

# Price sync daily at 6am
0 6 * * * cd /path/to/project && node takealot-sync-cron.js --sync-prices >> /var/log/takealot-sync.log 2>&1

# Health check every 2 hours
0 */2 * * * cd /path/to/project && node takealot-health-check.js >> /var/log/takealot-health.log 2>&1

# Returns check every 4 hours
0 */4 * * * cd /path/to/project && node takealot-returns-check.js >> /var/log/takealot-returns.log 2>&1
```

## License

Private / Internal Use

## Restore Procedure

1. Clone repo
2. Restore `.env` manually from secure backup
3. `npm install`
4. Restore systemd service
5. Restore crontab
6. Restore runtime state files if available
7. Start `zoho-mcp-node.service`
8. Verify health/order/returns logs
