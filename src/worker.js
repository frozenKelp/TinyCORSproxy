const MAX_HTML_BYTES = 192_000;
const FETCH_TIMEOUT_MS = 4_500;
const SUCCESS_TTL_SECONDS = 86_400;
const FAILURE_TTL_SECONDS = 60;
const LOCAL_ORIGIN = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/u;
const FROZENKELP_ORIGIN = 'https://frozenkelp.vip';

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

export function isSafePreviewUrl(rawUrl) {
  let url;

  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return false;
  }

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/gu, '');

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host === 'metadata.google.internal'
  ) {
    return false;
  }

  return !isBlockedIp(host);
}

export function parsePreviewHtml(html, sourceUrl) {
  const meta = collectMeta(html);
  const links = collectLinks(html);

  return compactObject({
    title:
      meta.get('og:title') ||
      meta.get('twitter:title') ||
      textBetween(html, 'title'),
    description:
      meta.get('og:description') ||
      meta.get('twitter:description') ||
      meta.get('description'),
    siteName: meta.get('og:site_name'),
    image: resolveWebUrl(
      meta.get('og:image') || meta.get('twitter:image'),
      sourceUrl
    ),
    favicon: resolveWebUrl(findLink(links, 'icon'), sourceUrl),
    canonicalUrl: resolveWebUrl(findLink(links, 'canonical'), sourceUrl)
  });
}

async function fetchPreview(targetUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const response = await fetch(targetUrl, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        accept: 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.5',
        'user-agent': 'FrozenKelpCanvasPreview/1.0'
      }
    });
    const finalUrl = response.url || targetUrl;
    const contentType = response.headers.get('content-type') || '';

    if (!response.ok) {
      throw new Error('Bad preview response');
    }

    if (!contentType.toLowerCase().includes('html')) {
      return {
        url: targetUrl,
        finalUrl,
        title: hostLabel(finalUrl),
        contentType
      };
    }

    const html = await readLimitedText(response, MAX_HTML_BYTES);

    return compactObject({
      url: targetUrl,
      finalUrl,
      contentType,
      ...parsePreviewHtml(html, finalUrl)
    });
  } finally {
    clearTimeout(timeout);
  }
}

async function readLimitedText(response, maxBytes) {
  if (!response.body?.getReader) {
    return (await response.text()).slice(0, maxBytes);
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let received = 0;
  let text = '';

  while (received < maxBytes) {
    const { done, value } = await reader.read();

    if (done || !value) {
      break;
    }

    const chunk = value.slice(0, Math.max(0, maxBytes - received));
    received += chunk.byteLength;
    text += decoder.decode(chunk, { stream: received < maxBytes });
  }

  await reader.cancel().catch(() => {});
  return text + decoder.decode();
}

function collectMeta(html) {
  const meta = new Map();
  const tagPattern = /<meta\b([^>]*)>/giu;

  for (const match of html.matchAll(tagPattern)) {
    const attrs = parseAttributes(match[1]);
    const key = (attrs.property || attrs.name || '').toLowerCase();
    const content = attrs.content;

    if (key && content && !meta.has(key)) {
      meta.set(key, decodeHtml(content.trim()));
    }
  }

  return meta;
}

function collectLinks(html) {
  const links = [];
  const tagPattern = /<link\b([^>]*)>/giu;

  for (const match of html.matchAll(tagPattern)) {
    const attrs = parseAttributes(match[1]);
    if (attrs.rel && attrs.href) {
      links.push({
        rel: attrs.rel.toLowerCase(),
        href: decodeHtml(attrs.href.trim())
      });
    }
  }

  return links;
}

function parseAttributes(rawAttrs) {
  const attrs = {};
  const attrPattern =
    /([^\s"'=<>`]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/giu;

  for (const match of rawAttrs.matchAll(attrPattern)) {
    attrs[match[1].toLowerCase()] = match[2] ?? match[3] ?? match[4] ?? '';
  }

  return attrs;
}

function findLink(links, wantedRel) {
  const match = links.find(({ rel }) =>
    rel.split(/\s+/u).some((part) =>
      wantedRel === 'icon'
        ? part === 'icon' || part === 'shortcut' || part === 'apple-touch-icon'
        : part === wantedRel
    )
  );

  return match?.href;
}

function textBetween(html, tagName) {
  const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)<\\/${tagName}>`, 'iu');
  const match = html.match(pattern);
  return match ? decodeHtml(stripTags(match[1]).trim()) : undefined;
}

function stripTags(value) {
  return value.replace(/<[^>]*>/gu, '');
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/gu, '&')
    .replace(/&lt;/gu, '<')
    .replace(/&gt;/gu, '>')
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'");
}

function resolveWebUrl(value, baseUrl) {
  if (!value) {
    return undefined;
  }

  try {
    const url = new URL(value, baseUrl);
    return url.protocol === 'http:' || url.protocol === 'https:'
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
}

function isBlockedIp(host) {
  if (host === '::1' || host === '0:0:0:0:0:0:0:1') {
    return true;
  }

  if (!/^\d{1,3}(?:\.\d{1,3}){3}$/u.test(host)) {
    return false;
  }

  const parts = host.split('.').map(Number);

  if (parts.some((part) => part < 0 || part > 255)) {
    return true;
  }

  const [a, b] = parts;

  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168)
  );
}

function hostLabel(rawUrl) {
  try {
    return new URL(rawUrl).hostname.replace(/^www\./u, '');
  } catch {
    return rawUrl;
  }
}

function json(data, status = 200, request, ttl = SUCCESS_TTL_SECONDS) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...corsHeaders(request?.headers.get('origin') ?? null),
      'cache-control': `public, max-age=${ttl}`,
      'content-type': 'application/json; charset=utf-8'
    }
  });
}

function withCors(response, origin) {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(origin);

  for (const [key, value] of Object.entries(cors)) {
    headers.set(key, value);
  }

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers
  });
}

function corsHeaders(origin) {
  const headers = {
    'access-control-allow-methods': 'GET, OPTIONS',
    'access-control-allow-headers': 'content-type',
    vary: 'Origin'
  };

  if (!origin) {
    return { ...headers, 'access-control-allow-origin': '*' };
  }

  if (origin === FROZENKELP_ORIGIN || LOCAL_ORIGIN.test(origin)) {
    return { ...headers, 'access-control-allow-origin': origin };
  }

  return headers;
}

function compactObject(object) {
  return Object.fromEntries(
    Object.entries(object).filter(([, value]) => value !== undefined && value !== '')
  );
}
