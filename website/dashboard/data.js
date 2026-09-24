window.GoldirhamData = {
  async query(baseUrl, key, table, opts = {}) {
    const url = new URL(`${baseUrl}/rest/v1/${table}`);
    url.searchParams.set('select', opts.select || '*');
    if (opts.order) url.searchParams.set('order', opts.order.includes('.') || opts.order.includes(',') ? opts.order : `${opts.order}.${opts.ascending === false ? 'asc' : 'desc'}`);
    if (opts.limit) url.searchParams.set('limit', opts.limit);
    if (opts.offset != null) url.searchParams.set('offset', Math.max(0, Number(opts.offset) || 0));
    if (opts.or) url.searchParams.set('or', opts.or);
    if (opts.range) url.searchParams.set(opts.rangeColumn || 'date', `gte.${opts.range}`);
    for (const [name, value] of Object.entries(opts.params || {})) url.searchParams.set(name, value);
    const response = await fetch(url, { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`Data temporarily unavailable (HTTP ${response.status})`);
    const rows = await response.json();
    if (!Array.isArray(rows)) throw new Error('Unexpected data response');
    return rows;
  },
  async allPages(baseUrl, key, table, opts = {}) {
    const result = [];
    for (let offset = 0; offset < 20000; offset += 500) {
      const rows = await this.query(baseUrl, key, table, { ...opts, limit: 500, offset });
      result.push(...rows);
      if (rows.length < 500) return result;
    }
    throw new Error('This date range is too large. Select a shorter range.');
  }
};
