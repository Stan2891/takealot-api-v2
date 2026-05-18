const axios = require('axios');

const MARKETPLACE_BASE = 'https://marketplace-api.takealot.com/v1';

class TakealotMarketplaceClient {
  constructor(apiKey) {
    this.client = axios.create({
      baseURL: MARKETPLACE_BASE,
      timeout: 30000,
      headers: {
        'X-API-Key': apiKey,
        'Accept': 'application/json'
      },
      paramsSerializer: {
        indexes: null
      }
    });
  }

  async getStatus() {
    const resp = await this.client.get('/status');
    return resp.data;
  }

  async getReturns(params = {}) {
    const query = {};
    query.limit = params.limit || 100;

    if (params.continuation_token) query.continuation_token = params.continuation_token;
    if (params.return_date__gte) query.return_date__gte = params.return_date__gte;
    if (params.return_date__lte) query.return_date__lte = params.return_date__lte;
    if (params.order_id) query.order_id = params.order_id;
    if (params.sku) query.sku = params.sku;
    if (params.include_count) query.include_count = true;

    query.expands = params.expands || ['outcomes', 'transactions'];

    const resp = await this.client.get('/returns', { params: query });
    return resp.data;
  }

  async getAllReturns(params = {}, maxPages = 20) {
    const allItems = [];
    let continuationToken = null;
    let pages = 0;

    do {
      const pageParams = { ...params };
      if (continuationToken) pageParams.continuation_token = continuationToken;

      const resp = await this.getReturns(pageParams);
      const items = resp.items || [];
      allItems.push(...items);

      continuationToken = resp.continuation_token || null;
      pages++;
    } while (continuationToken && pages < maxPages);

    return {
      items: allItems,
      pages_read: pages,
      truncated: !!continuationToken
    };
  }
}

module.exports = TakealotMarketplaceClient;
