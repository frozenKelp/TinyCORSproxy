import { compactObject, hostLabel } from './http.js';

const MAX_HTML_BYTES = 192_000;
const FETCH_TIMEOUT_MS = 4_500;

export async function fetchPreview(targetUrl) {
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
