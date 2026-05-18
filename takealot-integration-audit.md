# Takealot ↔ Zoho Integration — Technical Audit Report
**Server:** 192.168.80.24 | **Directory:** /home/stan/zoho-mcp-server
**Date:** 2026-05-13 | **Status:** Production (active cron + systemd)

---

## 1. Project File Map

| File | Role |
|------|------|
| `takealot-connector.js` | API client class wrapping Takealot Seller API v2 (axios) |
| `mcp-sse-server-fixed.js` | Main MCP server — lines 1002-1125 define Takealot tool schemas, lines 2191-2400 implement tool handlers, lines 2547-2700 implement order webhook |
| `takealot-sync-cron.js` | Standalone cron script — calls MCP `takealot/sync_stock` tool via HTTP |
| `takealot-order-poll.js` | Standalone cron script — polls orders, triggers webhook endpoint locally |
| `.takealot-order-state.json` | Persistent state file tracking processed order IDs |
| `takealot-swagger.json` | Takealot API swagger spec (reference, 62KB) |
| `.env` | Environment variables including TAKEALOT_API_KEY and TAKEALOT_WEBHOOK_SECRET |
| `package.json` | Node.js project — axios, express, neo4j-driver, dotenv, etc. |

---

## 2. Runtime / Process Map

| Component | Mechanism | Config |
|-----------|-----------|--------|
| MCP Server | systemd (system-level) | `/etc/systemd/system/zoho-mcp-node.service` |
| Server entrypoint | `/usr/bin/node mcp-sse-server-fixed.js` | Port 9091 |
| Stock sync (hourly) | cron | `0 * * * *` — runs `takealot-sync-cron.js` |
| Price sync (daily 6am) | cron | `0 6 * * *` — runs `takealot-sync-cron.js --sync-prices` |
| Order polling (30min) | cron | `*/30 * * * *` — runs `takealot-order-poll.js` |
| Webhook endpoint | Express route in MCP server | `POST /takealot/webhook/orders` via ngrok |
| Process manager | systemd (Restart=always, RestartSec=5) | Not pm2 |

**Environment variables used:**
- `TAKEALOT_API_KEY` — present
- `TAKEALOT_WEBHOOK_SECRET` — present
- `ZOHO_CLIENT_ID`, `ZOHO_CLIENT_SECRET`, `ZOHO_REFRESH_TOKEN` — Zoho auth
- `ZOHO_BOOKS_ORGANIZATION_ID` — target org for invoices/SO

---

## 3. Takealot API Client Map (`takealot-connector.js`)

| Method | Endpoint | HTTP | Request | Query Params | Response Used | R/W | Error Handling |
|--------|----------|------|---------|--------------|---------------|-----|----------------|
| `getOffers()` | `/v2/offers` | GET | — | page_number, page_size, filters, sort_key, sort_dir | `.offers[]`, `.page_summary.total` | Read | Throws on HTTP error |
| `getAllOffers()` | `/v2/offers` | GET | — | Paginates automatically | All offers concatenated | Read | Breaks on empty page |
| `getOfferCount()` | `/v2/offers/count` | GET | — | offer_statuses | Count data | Read | Throws |
| `getOffer(id)` | `/v2/offers` | GET | — | Scans all offers by offer_id or SKU | Single matched offer | Read | Returns `{offer:null, error:...}` |
| `updateOffer(id, data)` | `/v2/offers/batch` | POST | `[{offer_id, ...data}]` | — | Batch result | **Write** | Throws if offer not found; polls batch status |
| `createOffer(barcode, data)` | `/v2/offers/offer/:barcode` | POST | `{sku, selling_price, rrp, leadtime_days}` | — | Created offer | **Write** | Throws on HTTP error |
| `batchOffers(offers)` | `/v2/offers/batch` | POST | Array of offer objects (max 1000) | — | `{batch_id}` | **Write** | Throws on HTTP error |
| `getBatchStatus(id)` | `/v2/offers/batch/:id` | GET | — | — | `{status, results}` | Read | Throws |
| `waitForBatch(id)` | Polls `getBatchStatus` | — | — | — | Final batch status | Read | Times out at 30s |
| `getStockCounts()` | `/v2/offers/stock_counts` | GET | — | — | Stock count data | Read | Throws |
| `getStockHealthStats()` | `/v2/offers/stock_health_stats` | GET | — | — | Health stats | Read | Throws |
| `getSales()` | `/v2/sales` | GET | — | page_number, page_size, filters | `.sales[]` | Read | Throws |
| `getSalesSummary()` | `/v2/sales/summary` | GET | — | — | Summary data | Read | Throws |
| `getSalesOrders()` | `/v2/sales/orders` | GET | — | start_date, end_date, sku, order_id, page_number, page_size | `.orders[]` | Read | Throws |
| `getCustomerInvoices(oid)` | `/v2/sales/orders/:id/customer_invoices` | GET | — | — | Invoice data | Read | Throws |

**Notes:**
- No retry logic on any method
- No rate-limit detection or backoff
- Timeout: 30s on all requests
- Auth: `Authorization: Key <api_key>` header

---

## 4. MCP Tool Map

| Tool Name | Input Schema | R/W | Underlying Method | Validation | Risk if misused |
|-----------|-------------|-----|-------------------|------------|-----------------|
| `takealot/get_offers` | page_number, page_size, filters | Read | `getOffers()` | None | Low — read only |
| `takealot/get_offer` | identifier (required) | Read | `getOffer()` | Checks identifier present | Low |
| `takealot/update_offer` | identifier (req), selling_price, rrp, leadtime_days, leadtime_stock, status_action | **Write** | `updateOffer()` | Checks identifier; rounds prices | **HIGH** — can change live prices/stock, disable offers |
| `takealot/create_offer` | barcode (req), sku (req), selling_price (req), rrp, leadtime_days | **Write** | `createOffer()` | Checks required fields; rounds prices | **HIGH** — creates live marketplace listings |
| `takealot/batch_offers` | offers[] (required) | **Write** | `batchOffers()` | Checks array non-empty | **CRITICAL** — up to 1000 simultaneous changes |
| `takealot/get_sales` | page_number, page_size, filters | Read | `getSales()` | None | Low |
| `takealot/get_sales_summary` | (none) | Read | `getSalesSummary()` | None | Low |
| `takealot/get_orders` | start_date, end_date, sku, order_id, page_number, page_size | Read | `getSalesOrders()` | None | Low |
| `takealot/get_stock_health` | (none) | Read | `getStockCounts()` + `getStockHealthStats()` | None | Low |
| `takealot/sync_stock` | dry_run (default true), sku, sync_prices | **Write** (if dry_run=false) | Custom logic + `batchOffers()` | dry_run defaults true | **HIGH** — bulk stock/price changes |

---

## 5. Stock Sync Logic

| Aspect | Implementation |
|--------|---------------|
| **Zoho stock source** | Zoho Inventory items via itemsCache (in-memory, refreshed from `/inventory/v1/items`) |
| **Zoho org** | org_id `856737871` |
| **Zoho fields used** | `sku`, `available_stock` or `stock_on_hand`, `rate` |
| **SKU matching** | Exact string match: Zoho `sku` === Takealot offer `sku` |
| **Quantity calculation** | `Math.max(0, Math.floor(zohoItem.available_stock \|\| zohoItem.stock_on_hand \|\| 0))` |
| **Stock buffer** | None — sends raw Zoho stock |
| **Max channel stock** | None — no cap |
| **Warehouse/location logic** | Uses first warehouse in Takealot's `leadtime_stock` array; sends `merchant_warehouse_id` from existing offer |
| **Price sync** | Only when `sync_prices=true`; uses `Math.round(zohoItem.rate)` |
| **Missing SKU in Zoho** | Logged to `noMatch[]`, skipped |
| **Missing offer on Takealot** | Not applicable (iterates Takealot offers, looks up Zoho) |
| **Zero stock** | Sends `quantity: 0` to Takealot + `leadtime_days: -1` (removes leadtime) |
| **Negative stock** | Clamped to 0 via `Math.max(0, ...)` |
| **Batch size** | Chunks of 500 (Takealot max 1000) |
| **Logging** | Console + cron redirects to `/home/stan/reports/takealot-sync.log` |

**Known bug:** When `leadtime_stock` array is empty on the Takealot offer, falls back to setting `leadtime_days` instead — but offers with leadtime_days=None error with E18.

---

## 6. Price Sync Logic

| Aspect | Implementation |
|--------|---------------|
| **When it runs** | Daily at 06:00 SAST via `--sync-prices` flag |
| **Source price field** | `zohoItem.rate` (standard selling price from Zoho Inventory) |
| **Cost/margin check** | None |
| **Takealot commission/fees** | Not factored in |
| **Rounding** | `Math.round()` to nearest whole ZAR |
| **Manual price lock** | None — overwrites any manual Takealot price |
| **Sale price / promo** | Does not read `cf_sale_price` from Zoho |
| **RRP sync** | Only selling_price synced; RRP not updated in sync |
| **Update payload** | `{offer_id, selling_price: <rounded zoho rate>}` via batch endpoint |
| **Change detection** | Only updates if `zohoRate !== tkOffer.selling_price` |

---

## 7. Order Polling Logic

| Aspect | Implementation |
|--------|---------------|
| **Polling interval** | Every 30 minutes (cron) |
| **Takealot endpoint** | `GET /v2/sales` via MCP tool `takealot/get_sales` |
| **Date window** | Last 2 days (`now - 48h` to `now`) — overlap to catch missed |
| **Order statuses** | All (no status filter) |
| **Duplicate prevention** | Flat array of processed order_id strings in state file |
| **State file** | `.takealot-order-state.json` — `{last_poll, processed_order_ids[]}` |
| **Zoho document created** | Sales Order → converted to Invoice → marked Sent |
| **Zoho endpoint** | `POST /books/v3/salesorders` → `POST /books/v3/invoices/fromsalesorder` → `POST /books/v3/invoices/:id/status/sent` |
| **Customer** | Searches for "Takealot" contact; creates `Takealot Marketplace` if missing |
| **Item matching** | Searches Zoho Books items by SKU (`search_text`) → finds exact `sku` match |
| **Price used** | `item.selling_price` from Takealot (not Zoho rate) |
| **Tax handling** | `is_inclusive_tax: true` on Sales Order |
| **Shipping** | Not captured |
| **Discount** | Not captured |
| **Payment recording** | Not applied (invoice stays unpaid/sent) |
| **Takealot fees** | Not recorded (success_fee, fulfillment_fee, courier_fee all available but unused) |
| **Partial failure** | Per-order try/catch — failed orders logged but still marked processed in some paths |
| **Custom fields** | `Sales Channel: Takealot` on Sales Order |
| **Reference** | `TK-{order_id}` |

**Two code paths exist:**
1. **Webhook** (`POST /takealot/webhook/orders`) — real-time push from Takealot
2. **Poller** (`takealot-order-poll.js`) — calls webhook endpoint locally as fallback

---

## 8. State & Persistence

| File | Purpose | Schema | Backup Risk | Corruption Risk | Rebuildable? |
|------|---------|--------|-------------|-----------------|--------------|
| `.takealot-order-state.json` | Tracks processed orders | `{last_poll: ISO, processed_order_ids: string[]}` | No backup | Medium — grows unbounded, written every 30min | Partially — can rebuild from Zoho invoice references (`TK-*`) |
| In-memory `itemsCache` | Caches Zoho Inventory items | Refreshed periodically in MCP server | N/A — volatile | N/A | Yes — re-fetched from Zoho API |

**Risks:**
- State file grows linearly (81 IDs currently, ~5KB) — will be 500+ IDs per year
- No TTL/rotation on old order IDs
- File write is not atomic (possible corruption on crash during write)

---

## 9. Error Handling & Logging

| Aspect | Implementation |
|--------|---------------|
| **Log files** | `/home/stan/reports/takealot-sync.log`, `/home/stan/reports/takealot-orders.log`, `/home/stan/reports/takealot_orders.log` (webhook) |
| **Error format** | Timestamped console.log/console.error, captured by cron `>>` redirect |
| **Retry behavior** | None — single attempt per sync/poll cycle |
| **Rate-limit handling** | None — no 429 detection or backoff |
| **Failed order handling** | Logged with error message; some paths still mark as processed (prevents retry) |
| **Failed stock update** | Logged in `applied[]` with status `error`; continues to next chunk |
| **Alerting** | None — no email, Slack, or notification on failure |
| **Replay capability** | No dead-letter queue or retry mechanism |

**Known recurring error:** SKU `63117180050` fails every sync cycle (offer disabled by Takealot + leadtime_days=None). No mechanism to suppress or skip known-bad offers.

---

## 10. API Version / Endpoint Verification

**Endpoints in active use:**
- `GET /v2/offers` — list offers
- `GET /v2/offers/count` — offer count
- `POST /v2/offers/batch` — batch create/update (main write path)
- `GET /v2/offers/batch/:id` — batch status polling
- `POST /v2/offers/offer/:barcode` — single offer creation
- `GET /v2/offers/stock_counts` — stock counts
- `GET /v2/offers/stock_health_stats` — stock health
- `GET /v2/sales` — sales list
- `GET /v2/sales/summary` — summary
- `GET /v2/sales/orders` — orders with filters
- `GET /v2/sales/orders/:id/customer_invoices` — customer invoices

**Unused/mentioned in swagger but not implemented:**
- Returns/refunds endpoints
- Shipment/dispatch endpoints
- Offer status history
- Product catalogue endpoints
- Reporting endpoints

**TODOs/comments found:**
- `// PATCH endpoint is unreliable/returns 500` (forced batch for single updates)
- `// path-based GET is unreliable` (forced full scan for single offer lookup)

---

## 11. Production Risk Assessment

| Risk | File/Function | Impact | Current Protection | Missing Protection | Fix |
|------|---------------|--------|-------------------|-------------------|-----|
| Accidental bulk price change to R0 | `takealot/sync_stock` with sync_prices=true | All 57 offers get wrong price | dry_run default | No min-price guard, no % change limit | Add floor price + max change % |
| Stock oversell | sync_stock | List stock > actual | None | No stock buffer, no max channel cap | Add configurable buffer (e.g. -2) |
| Duplicate invoices | order-poll.js | Double billing in Zoho | processed_order_ids array | No Zoho-side idempotency check (TK- reference not validated) | Check Zoho for existing `TK-{order_id}` before creating |
| State file corruption | .takealot-order-state.json | Orders re-processed → duplicate invoices | None | No atomic write, no backup | Use write-rename pattern; keep backup |
| Unbounded state growth | .takealot-order-state.json | Memory/parsing issues eventually | None | No TTL | Rotate IDs older than 30 days |
| Known-bad offer retried forever | sync_stock | Log spam, wasted API calls | None | No suppression list | Skip offers with persistent errors |
| No rate-limit handling | All API calls | 429 → data loss/partial sync | None | No backoff | Add exponential backoff on 429 |
| Write tools exposed to AI agents | MCP tools | Unintended price/stock changes | None | No confirmation step, no audit log | Add confirmation for write tools |
| getOffer scans ALL offers | connector.getOffer() | Slow, O(n) API calls | None | N/A | Use filters or cache offer map |
| Webhook secret in query string | order webhook | Potential exposure in logs/URLs | Optional auth check | Not enforced strictly | Require header-based auth |

---

## 12. Missing Capabilities Against V2 Goals

| Goal | Status | Notes |
|------|--------|-------|
| Webhook-based orders | Partial | Endpoint exists; also polling as fallback. Webhook receives pushes but poller duplicates work |
| Returns/refunds | Missing | No endpoints implemented, no Zoho credit note flow |
| Shipment tracking sync | Missing | No dispatch notification to Takealot |
| Automatic offer creation for new Zoho items | Missing | Manual only via MCP tool |
| Error alerting | Missing | No notifications on failure |
| Dashboard/reporting | Missing | Only raw log files |
| Commission/fee reconciliation | Missing | Fees available in order data but not recorded |
| Dead stock pricing rules | Missing | No auto-markdown logic |
| Stock buffer / max channel stock | Missing | Raw Zoho stock pushed |
| Margin protection | Missing | No cost/margin check before price sync |
| Dry-run mode | Exists | Default on sync_stock tool |
| Idempotent order import | Partial | State file prevents re-processing but no Zoho-side check |
| Reconciliation report | Missing | No Zoho vs Takealot comparison tool |

---

## 13. Questions for Stan / Architect

1. **Stock buffer** — Should we deduct a safety buffer (e.g. 2 units) before sending stock to Takealot, or send actual available?
2. **Max channel stock** — Should there be a cap (e.g. max 50 per SKU on Takealot) regardless of Zoho stock?
3. **Margin floor** — What is the minimum acceptable margin % before refusing to sync a price? Should cost price be checked?
4. **Fee recording** — Should Takealot success_fee/fulfillment_fee be recorded as line items, expenses, or custom fields on the Zoho invoice?
5. **Payment flow** — Should the Zoho invoice be auto-marked as paid? If so, to which payment account/method?
6. **Returns** — When Takealot processes a return, should it create a credit note in Zoho, or reverse the invoice? Should stock be adjusted?
7. **Dispatch** — When an order is shipped from your warehouse, who/what triggers the dispatch notification to Takealot? Is there a packing slip workflow?
8. **Multiple warehouses** — Currently only first warehouse in `leadtime_stock` is updated. Do you ship from multiple locations (JHB/CPT)?
9. **Disabled offers** — SKU `63117180050` (and 17 others) fail every cycle. Should they be auto-skipped, manually fixed, or removed from Takealot?
10. **Sale price** — Should Takealot selling_price use `cf_sale_price` when present (instead of `rate`)?
11. **New offer automation** — What criteria determine if a new Zoho item should be listed on Takealot? (condition=NEW? specific brand? minimum stock?)
12. **Alerting channel** — Where should error notifications go? (Telegram, email, Slack, SalesIQ?)

---

## 14. Recommended Next Step

**Do not implement yet.** The single safest next step is:

> **Create a read-only reconciliation tool** (`takealot/reconcile`) that:
> - Fetches all Takealot offers
> - Fetches all matched Zoho items
> - Compares stock levels, prices, and offer status
> - Identifies mismatches, disabled offers, and offers with persistent errors
> - Returns a structured diff report without making any changes

This gives you visibility into the current state before making any sync logic changes, and establishes a safety baseline for V2 development.
