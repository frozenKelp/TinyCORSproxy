import { afterEach, describe, expect, it, vi } from 'vitest';
import worker, { isSafePreviewUrl, parsePreviewHtml } from './worker.js';

const sampleHtml = `<!doctype html>
<html>
  <head>
    <title>Fallback Title</title>
    <link rel="canonical" href="/canonical-story" />
    <link rel="icon" href="/favicon.ico" />
    <meta property="og:title" content="OG Story" />
    <meta property="og:description" content="A tidy little preview." />
    <meta property="og:site_name" content="Example Journal" />
    <meta property="og:image" content="/cover.png" />
    <meta name="twitter:title" content="Twitter Story" />
  </head>
  <body>secret page body should not leak</body>
</html>`;

describe('link preview parsing', () => {
  it('extracts common preview metadata and resolves relative URLs', () => {
    expect(parsePreviewHtml(sampleHtml, 'https://example.com/story')).toEqual({
      canonicalUrl: 'https://example.com/canonical-story',
      description: 'A tidy little preview.',
      favicon: 'https://example.com/favicon.ico',
      image: 'https://example.com/cover.png',
      siteName: 'Example Journal',
      title: 'OG Story'
    });
  });
});

describe('preview URL safety', () => {
  it('allows normal http and https links', () => {
    expect(isSafePreviewUrl('https://example.com/story')).toBe(true);
    expect(isSafePreviewUrl('http://example.com/story')).toBe(true);
  });

  it('rejects non-web, localhost, private, and metadata-service targets', () => {
    expect(isSafePreviewUrl('ftp://example.com/story')).toBe(false);
    expect(isSafePreviewUrl('https://localhost/story')).toBe(false);
    expect(isSafePreviewUrl('https://127.0.0.1/story')).toBe(false);
    expect(isSafePreviewUrl('https://10.1.2.3/story')).toBe(false);
    expect(isSafePreviewUrl('https://172.16.1.4/story')).toBe(false);
    expect(isSafePreviewUrl('https://192.168.0.8/story')).toBe(false);
    expect(isSafePreviewUrl('https://169.254.169.254/latest/meta-data')).toBe(
      false
    );
  });
});

describe('preview worker', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('returns JSON preview data with CORS headers and no raw HTML body', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sampleHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
    );

    const response = await worker.fetch(
      new Request(
        'https://preview.test/preview?url=https%3A%2F%2Fexample.com%2Fstory',
        { headers: { origin: 'http://localhost:5175' } }
      )
    );
    const bodyText = await response.text();
    const data = JSON.parse(bodyText);

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(
      'http://localhost:5175'
    );
    expect(data).toMatchObject({
      url: 'https://example.com/story',
      title: 'OG Story',
      description: 'A tidy little preview.',
      image: 'https://example.com/cover.png'
    });
    expect(bodyText).not.toContain('<html>');
    expect(bodyText).not.toContain('secret page body');
  });

  it('allows both frozenkelp canvas origins during HTTPS rollout', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sampleHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
    );

    for (const origin of ['https://frozenkelp.vip', 'http://frozenkelp.vip']) {
      const response = await worker.fetch(
        new Request(
          'https://preview.test/preview?url=https%3A%2F%2Fexample.com%2Fstory',
          { headers: { origin } }
        )
      );

      expect(response.headers.get('access-control-allow-origin')).toBe(origin);
    }
  });

  it('does not reuse cached CORS allow-origin headers for disallowed origins', async () => {
    const cachedResponses = new Map();
    vi.stubGlobal('caches', {
      default: {
        match: vi.fn(async (request) => cachedResponses.get(request.url)),
        put: vi.fn(async (request, response) => {
          cachedResponses.set(request.url, response.clone());
        })
      }
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sampleHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
    );

    const url =
      'https://preview.test/preview?url=https%3A%2F%2Fexample.com%2Fstory';
    const first = await worker.fetch(
      new Request(url, { headers: { origin: 'https://frozenkelp.vip' } })
    );
    const second = await worker.fetch(
      new Request(url, { headers: { origin: 'https://evil.test' } })
    );

    expect(first.headers.get('access-control-allow-origin')).toBe(
      'https://frozenkelp.vip'
    );
    expect(second.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('returns JSON failure when a preview fetch times out', async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => reject(new Error('aborted')));
          })
      )
    );

    const responsePromise = worker.fetch(
      new Request(
        'https://preview.test/preview?url=https%3A%2F%2Fslow.example%2Fstory'
      )
    );
    await vi.advanceTimersByTimeAsync(4_500);
    const response = await responsePromise;
    const body = await response.json();

    expect(response.status).toBe(502);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect(body).toEqual({ error: 'preview_failed' });
  });

  it('rejects unsafe preview targets before fetching', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const response = await worker.fetch(
      new Request('https://preview.test/preview?url=http://127.0.0.1/admin')
    );

    expect(response.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
