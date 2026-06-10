import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';
import worker from './worker.js';

const schema = JSON.parse(
  readFileSync(
    fileURLToPath(new URL('../preview-contract.schema.json', import.meta.url)),
    'utf8'
  )
);

const sampleHtml = `<!doctype html><html><head>
<title>Fallback Title</title>
<meta property="og:title" content="OG Story" />
<meta property="og:description" content="A tidy little preview." />
<meta property="og:image" content="https://example.com/cover.png" />
</head><body>body</body></html>`;

describe('preview response conforms to the published contract', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns only allowed keys and the required url', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(sampleHtml, {
        headers: { 'content-type': 'text/html; charset=utf-8' }
      }))
    );

    const response = await worker.fetch(
      new Request(
        'https://preview.test/preview?url=https%3A%2F%2Fexample.com%2Fstory'
      )
    );
    const data = await response.json();

    const allowed = Object.keys(schema.properties);
    for (const key of Object.keys(data)) {
      expect(allowed).toContain(key);
    }
    for (const required of schema.required) {
      expect(data).toHaveProperty(required);
    }
  });
});
