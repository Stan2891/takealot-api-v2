// Takealot Seller API Connector for BMParts
// API Docs: https://seller-api.takealot.com/api-docs/
// Base URL: https://seller-api.takealot.com
const axios = require('axios');

const TAKEALOT_BASE = 'https://seller-api.takealot.com';

class TakealotConnector {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.client = axios.create({
      baseURL: TAKEALOT_BASE,
      timeout: 30000,
      headers: {
        'Authorization': `Key ${apiKey}`,
        'Content-Type': 'application/json'
      }
    });
  }

  // ========== OFFERS ==========

  // Get all offers with pagination and optional filters
  async getOffers({ page_number = 1, page_size = 100, filters, sort_key, sort_dir } = {}) {
    const params = { page_number, page_size };
    if (filters) params.filters = filters;
    if (sort_key) params.sort_key = sort_key;
    if (sort_dir) params.sort_dir = sort_dir;
    const resp = await this.client.get('/v2/offers', { params });
    return resp.data;
  }

  // Get all offers (paginate through everything)
  async getAllOffers() {
    let allOffers = [];
    let page = 1;
    const pageSize = 100;
    let hasMore = true;
    while (hasMore) {
      const data = await this.getOffers({ page_number: page, page_size: pageSize });
      const offers = data.offers || [];
      allOffers = allOffers.concat(offers);
      const total = data.page_summary?.total || 0;
      hasMore = allOffers.length < total;
      page++;
      if (offers.length === 0) break;
    }
    return allOffers;
  }

  // Get offer count by status
  async getOfferCount(offer_statuses) {
    const params = {};
    if (offer_statuses) params.offer_statuses = offer_statuses;
    const resp = await this.client.get('/v2/offers/count', { params });
    return resp.data;
  }

  // Get single offer by offer_id or SKU (uses list endpoint — path-based GET is unreliable)
  async getOffer(identifier) {
    const id = String(identifier);
    // Try to find in the full offer list by offer_id or SKU
    const data = await this.getOffers({ page_size: 100 });
    const total = data.page_summary?.total || 0;
    let allOffers = data.offers || [];
    // Paginate if needed
    if (allOffers.length < total) {
      const remaining = await this.getAllOffers();
      allOffers = remaining;
    }
    const match = allOffers.find(o => String(o.offer_id) === id || o.sku === id);
    return match ? { offer: match } : { offer: null, error: `Offer not found: ${identifier}` };
  }

  // Update single offer via batch endpoint (PATCH endpoint is unreliable/returns 500)
  async updateOffer(identifier, offerData) {
    // Resolve identifier to offer_id if it's a SKU
    let offerId = Number(identifier);
    if (isNaN(offerId)) {
      const found = await this.getOffer(identifier);
      if (!found.offer) throw new Error(`Offer not found: ${identifier}`);
      offerId = found.offer.offer_id;
    }
    const batchPayload = [{ offer_id: offerId, ...offerData }];
    const batchResp = await this.batchOffers(batchPayload);
    // Poll for batch completion
    const result = await this.waitForBatch(batchResp.batch_id);
    const offerResult = (result.results || [])[0];
    return offerResult || result;
  }

  // Create single offer against a barcode (GTIN)
  async createOffer(identifier, offerData) {
    const resp = await this.client.post(`/v2/offers/offer/${encodeURIComponent(identifier)}`, offerData);
    return resp.data;
  }

  // Batch create/update offers (up to 1000 per batch)
  async batchOffers(offers) {
    const resp = await this.client.post('/v2/offers/batch', offers);
    return resp.data;
  }

  // Get batch status
  async getBatchStatus(batchId) {
    const resp = await this.client.get(`/v2/offers/batch/${batchId}`);
    return resp.data;
  }

  // Wait for batch to complete (poll every 2s, max 30s)
  async waitForBatch(batchId, maxWaitMs = 30000) {
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
      const status = await this.getBatchStatus(batchId);
      if (status.status?.id === 4 || status.status?.description === 'Success') return status;
      if (status.status?.id === 5 || status.status?.description === 'Failed') return status;
      await new Promise(r => setTimeout(r, 2000));
    }
    return this.getBatchStatus(batchId);
  }

  // Get stock counts
  async getStockCounts() {
    const resp = await this.client.get('/v2/offers/stock_counts');
    return resp.data;
  }

  // Get stock health stats
  async getStockHealthStats() {
    const resp = await this.client.get('/v2/offers/stock_health_stats');
    return resp.data;
  }

  // ========== SALES ==========

  // Get sales
  async getSales({ page_number = 1, page_size = 100, filters } = {}) {
    const params = { page_number, page_size };
    if (filters) params.filters = filters;
    const resp = await this.client.get('/v2/sales', { params });
    return resp.data;
  }

  // Get sales summary
  async getSalesSummary() {
    const resp = await this.client.get('/v2/sales/summary');
    return resp.data;
  }

  // Get sales orders
  async getSalesOrders({ start_date, end_date, sku, order_id, page_number = 1, page_size = 100 } = {}) {
    const params = { page_number, page_size };
    if (start_date) params.start_date = start_date;
    if (end_date) params.end_date = end_date;
    if (sku) params.sku = sku;
    if (order_id) params.order_id = order_id;
    const resp = await this.client.get('/v2/sales/orders', { params });
    return resp.data;
  }

  // Get customer invoices for an order
  async getCustomerInvoices(orderId) {
    const resp = await this.client.get(`/v2/sales/orders/${orderId}/customer_invoices`);
    return resp.data;
  }
}

module.exports = TakealotConnector;
