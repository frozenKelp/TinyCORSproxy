import { fetchPreview, parsePreviewHtml } from './preview.js';
import { isSafePreviewUrl } from './safety.js';
import {
  corsHeaders,
  json,
  withCors,
  FAILURE_TTL_SECONDS,
  SUCCESS_TTL_SECONDS
} from './http.js';

export default {
  async fetch(request) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: corsHeaders(request.headers.get('origin'))
      });
    }

    if (request.method !== 'GET') {
      return json({ error: 'method_not_allowed' }, 405, request, FAILURE_TTL_SECONDS);
    }

    const requestUrl = new URL(request.url);

    if (requestUrl.pathname !== '/preview') {
      return json({ ok: true, service: 'canvas-link-preview' }, 200, request);
    }

    const targetUrl = requestUrl.searchParams.get('url') ?? '';

    if (!isSafePreviewUrl(targetUrl)) {
      return json({ error: 'unsafe_url' }, 400, request, FAILURE_TTL_SECONDS);
    }

    const cache = globalThis.caches?.default;
    const cacheKey = new Request(request.url, { method: 'GET' });
    const cached = await cache?.match(cacheKey);

    if (cached) {
      return withCors(cached, request.headers.get('origin'));
    }

    try {
      const preview = await fetchPreview(targetUrl);
      const response = json(preview, 200, request, SUCCESS_TTL_SECONDS);
      await cache?.put(cacheKey, response.clone());
      return response;
    } catch {
      return json({ error: 'preview_failed' }, 502, request, FAILURE_TTL_SECONDS);
    }
  }
};

// Re-exported for the test suite, which imports them from this entry module.
export { isSafePreviewUrl, parsePreviewHtml };
