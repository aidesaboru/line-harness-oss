const API_ORIGIN = __API_ORIGIN_JSON__;

export default {
  async fetch(request, env) {
    const requestUrl = new URL(request.url);

    if (requestUrl.pathname === '/api' || requestUrl.pathname.startsWith('/api/')) {
      const upstreamUrl = new URL(`${requestUrl.pathname}${requestUrl.search}`, API_ORIGIN);
      const headers = new Headers(request.headers);
      headers.delete('host');

      const upstreamRequest = new Request(upstreamUrl, {
        method: request.method,
        headers,
        body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
        redirect: 'manual',
      });

      return fetch(upstreamRequest);
    }

    return env.ASSETS.fetch(request);
  },
};
