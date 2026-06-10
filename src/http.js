export const SUCCESS_TTL_SECONDS = 86_400;
export const FAILURE_TTL_SECONDS = 60;

const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u;
const FROZENKELP_ORIGINS = new Set([
  'https://frozenkelp.vip',
  'http://frozenkelp.vip'
]);

export function json(data, status = 200, request, ttl = SUCCESS_TTL_SECONDS) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request?.headers.get('origin') ?? null),
      'cache-control': `public, max-age=${ttl}`,
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

export function withCors(response, origin) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin);

  headers.delete('access-control-allow-origin');

  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

export function corsHeaders(origin) {
  const headers = {
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin'
  };

  if (!origin) {
    return { ...headers, 'access-control-allow-origin': '*' };
  }

  if (FROZENKELP_ORIGINS.has(origin) || LOCAL_ORIGIN.test(origin)) {
    return { ...headers, 'access-control-allow-origin': origin };
  }

  return headers;
}

export function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(
      ([, value]) => value !== undefined && value !== ''
    )
  );
}

// Intentionally duplicated in canvas/src/domain/url.ts. Keep in sync.
export function hostLabel(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./u, '');
  } catch {
    return rawUrl;
  }
}
