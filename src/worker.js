import statusHTML from './status.html';

export default {
  async fetch(request) {
    const params = new URL(request.url).searchParams;

    if (!params.get('url')) {
      return new Response(statusHTML, {
        headers: { 'Content-Type': 'text/html' }
      });
    }

    if (params.get('key') !== 'yoursecretkey') {
      return new Response('Forbidden', { status: 403 });
    }

    const url = params.get('url');
    const res = await fetch(url);
    const data = await res.json();
    return new Response(JSON.stringify(data), {
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
};