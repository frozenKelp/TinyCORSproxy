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
