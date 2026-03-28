export const config = {
  runtime: 'nodejs',
};

function isHtml(ct = '') {
  return /text\/html|application\/xhtml\+xml/i.test(ct);
}

function isCss(ct = '') {
  return /text\/css/i.test(ct);
}

function shouldSkipUrl(v = '') {
  const s = String(v).trim();
  return !s || s.startsWith('#') || s.startsWith('javascript:') || s.startsWith('mailto:') || s.startsWith('tel:') || s.startsWith('data:') || s.startsWith('blob:');
}

function getSelfOrigin(req) {
  return `${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}`;
}

function decodePathTarget(parts) {
  const joined = Array.isArray(parts) ? parts.join('/') : String(parts || '');
  if (!joined) return '';
  const normalized = joined.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '==='.slice((normalized.length + 3) % 4);
  return Buffer.from(padded, 'base64').toString('utf8');
}

function encodePathTarget(url) {
  return Buffer.from(String(url), 'utf8').toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function abs(base, value) {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function isProxyUrl(value, selfOrigin) {
  try {
    const url = new URL(String(value));
    return url.origin === selfOrigin && (url.pathname === '/api/proxy' || url.pathname.startsWith('/api/proxy/'));
  } catch {
    return false;
  }
}

function unwrapProxyTarget(raw, selfOrigin) {
  let current = String(raw || '');
  for (let i = 0; i < 12; i += 1) {
    let parsed;
    try {
      parsed = new URL(current);
    } catch {
      return current;
    }
    if (parsed.origin !== selfOrigin) return current;
    if (parsed.pathname.startsWith('/api/proxy/')) {
      const encoded = parsed.pathname.slice('/api/proxy/'.length);
      if (!encoded) return current;
      current = decodePathTarget(encoded);
      continue;
    }
    if (parsed.pathname === '/api/proxy' && parsed.searchParams.has('url')) {
      current = parsed.searchParams.get('url') || '';
      continue;
    }
    return current;
  }
  return current;
}

function proxify(selfOrigin, absoluteUrl) {
  if (isProxyUrl(absoluteUrl, selfOrigin)) return absoluteUrl;
  return `${selfOrigin}/api/proxy/${encodePathTarget(absoluteUrl)}`;
}

function stripMetaCsp(html) {
  return String(html).replace(/<meta[^>]+http-equiv=["']Content-Security-Policy["'][^>]*>/gi, '');
}

function rewriteCssUrls(css, baseUrl, selfOrigin) {
  return String(css).replace(/url\((['"]?)(.*?)\1\)/gi, (_, q, raw) => {
    const v = String(raw || '').trim();
    if (shouldSkipUrl(v)) return `url(${q}${v}${q})`;
    return `url(${q}${proxify(selfOrigin, abs(baseUrl, v))}${q})`;
  });
}

function rewriteSrcset(srcset, baseUrl, selfOrigin) {
  return String(srcset).split(',').map((part) => {
    const seg = part.trim();
    if (!seg) return seg;
    const pieces = seg.split(/\s+/);
    const rawUrl = pieces.shift();
    if (!rawUrl || shouldSkipUrl(rawUrl)) return seg;
    return [proxify(selfOrigin, abs(baseUrl, rawUrl)), ...pieces].join(' ');
  }).join(', ');
}

function injectClient(baseUrl, selfOrigin) {
  return `<script>
(() => {
  const VOID_BASE = ${JSON.stringify(baseUrl)};
  const VOID_ORIGIN = ${JSON.stringify(selfOrigin)};

  const shouldSkip = (u) => {
    if (!u) return true;
    const s = String(u).trim();
    return !s || s.startsWith('#') || s.startsWith('javascript:') || s.startsWith('mailto:') || s.startsWith('tel:') || s.startsWith('data:') || s.startsWith('blob:');
  };

  const encodeTarget = (url) => {
    const bytes = new TextEncoder().encode(url);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return btoa(binary).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/g, '');
  };

  const abs = (u) => {
    try { return new URL(u, VOID_BASE).toString(); }
    catch { return u; }
  };

  const isProxyUrl = (u) => {
    try {
      const parsed = new URL(String(u), location.href);
      return parsed.origin === VOID_ORIGIN && (parsed.pathname === '/api/proxy' || parsed.pathname.startsWith('/api/proxy/'));
    } catch {
      return false;
    }
  };

  const proxify = (u) => {
    if (shouldSkip(u)) return u;
    const absolute = abs(u);
    if (isProxyUrl(absolute)) return absolute;
    return VOID_ORIGIN + '/api/proxy/' + encodeTarget(absolute);
  };

  const navTo = (u, push = true) => {
    if (shouldSkip(u)) return;
    const absolute = abs(u);
    if (window.top !== window.self) {
      parent.postMessage({ type: 'VOID_NAVIGATE', url: absolute, push }, '*');
    } else {
      location.href = proxify(absolute);
    }
  };

  const rewriteNode = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll('[href],[src],[action],[poster],[data],[srcset],[style]').forEach((el) => {
      ['href','src','action','poster','data'].forEach((attr) => {
        const v = el.getAttribute(attr);
        if (v && !shouldSkip(v) && !isProxyUrl(v)) {
          el.setAttribute(attr, proxify(v));
        }
      });

      const ss = el.getAttribute('srcset');
      if (ss) {
        const rewritten = ss.split(',').map(part => {
          const seg = part.trim();
          if (!seg) return seg;
          const pieces = seg.split(/\\s+/);
          const raw = pieces.shift();
          if (!raw || shouldSkip(raw) || isProxyUrl(raw)) return seg;
          return [proxify(raw), ...pieces].join(' ');
        }).join(', ');
        el.setAttribute('srcset', rewritten);
      }

      const style = el.getAttribute('style');
      if (style && /url\\(/i.test(style)) {
        el.setAttribute('style', style.replace(/url\\((['"]?)(.*?)\\1\\)/gi, (m, q, raw) => {
          if (shouldSkip(raw) || isProxyUrl(raw)) return m;
          return 'url(' + q + proxify(raw) + q + ')';
        }));
      }

      if (el.tagName === 'FORM') {
        const target = (el.getAttribute('target') || '').toLowerCase();
        if (target && target !== '_self') el.setAttribute('target', '_self');
      }
    });
  };

  document.addEventListener('click', (e) => {
    const a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    const href = a.getAttribute('href');
    if (shouldSkip(href)) return;
    e.preventDefault();
    navTo(href, true);
  }, true);

  document.addEventListener('submit', async (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    e.preventDefault();
    const method = (f.getAttribute('method') || 'GET').toUpperCase();
    const action = abs(f.getAttribute('action') || location.href);

    if (method === 'GET') {
      const fd = new FormData(f);
      const u = new URL(action);
      for (const [k, v] of fd.entries()) {
        if (typeof v === 'string') u.searchParams.append(k, v);
      }
      navTo(u.toString(), true);
      return;
    }

    const fd = new FormData(f);
    const hasFile = Array.from(fd.values()).some(v => typeof File !== 'undefined' && v instanceof File);
    if (hasFile) {
      navTo(action, true);
      return;
    }

    const pairs = [];
    for (const [k, v] of fd.entries()) {
      if (typeof v === 'string') pairs.push([k, v]);
    }

    try {
      const res = await fetch(VOID_ORIGIN + '/api/proxy', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ url: action, method, form: pairs })
      });
      const html = await res.text();
      document.open();
      document.write(html);
      document.close();
    } catch {
      navTo(action, true);
    }
  }, true);

  const oldFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      if (typeof input === 'string') {
        if (!shouldSkip(input) && !isProxyUrl(input)) input = proxify(input);
      } else if (input instanceof URL) {
        const u = input.toString();
        if (!shouldSkip(u) && !isProxyUrl(u)) input = proxify(u);
      }
    } catch {}
    return oldFetch.call(this, input, init);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try {
      if (!shouldSkip(url) && !isProxyUrl(url)) url = proxify(url);
    } catch {}
    return xhrOpen.call(this, method, url, ...rest);
  };

  const pushState = history.pushState.bind(history);
  const replaceState = history.replaceState.bind(history);
  history.pushState = function(state, title, url) {
    if (url) return navTo(url, true);
    return pushState(state, title, url);
  };
  history.replaceState = function(state, title, url) {
    if (url) return navTo(url, false);
    return replaceState(state, title, url);
  };

  const origOpen = window.open;
  window.open = function(url, target, features) {
    if (url && (!target || target === '_self')) {
      navTo(url, true);
      return null;
    }
    return origOpen.call(window, url, target, features);
  };

  rewriteNode(document);
  const observer = new MutationObserver((mutations) => {
    for (const m of mutations) {
      for (const n of m.addedNodes) {
        if (n.nodeType === 1) rewriteNode(n);
      }
    }
  });
  observer.observe(document.documentElement || document, { childList: true, subtree: true });

  try {
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())).catch(() => {});
    }
  } catch {}
})();
</script>`;
}

function rewriteHtml(html, baseUrl, selfOrigin) {
  let out = stripMetaCsp(String(html));
  out = out.replace(/<head([^>]*)>/i, `<head$1><base href="${baseUrl}">${injectClient(baseUrl, selfOrigin)}`);
  out = out.replace(/\s(integrity)=['"][^'"]*['"]/gi, '');
  out = out.replace(/\snonce=(['"]).*?\1/gi, '');

  const attrs = ['href', 'src', 'action', 'poster', 'data'];
  for (const attr of attrs) {
    const re = new RegExp(`${attr}=(["'])(.*?)\\1`, 'gi');
    out = out.replace(re, (m, quote, value) => {
      if (shouldSkipUrl(value)) return m;
      const absolute = abs(baseUrl, value);
      return `${attr}=${quote}${proxify(selfOrigin, absolute)}${quote}`;
    });
  }

  out = out.replace(/srcset=(['"])(.*?)\1/gi, (m, quote, value) => `srcset=${quote}${rewriteSrcset(value, baseUrl, selfOrigin)}${quote}`);
  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => `<style>${rewriteCssUrls(css, baseUrl, selfOrigin)}</style>`);
  out = out.replace(/style=(['"])(.*?)\1/gi, (m, quote, css) => `style=${quote}${rewriteCssUrls(css, baseUrl, selfOrigin)}${quote}`);
  return out;
}

async function fetchUpstream(targetUrl, req, method, formPairs) {
  const headers = {
    'user-agent': req.headers['user-agent'] || 'Mozilla/5.0 VoidBrowser',
    'accept-language': req.headers['accept-language'] || 'en-US,en;q=0.9',
    'accept-encoding': 'identity',
    'referer': `${targetUrl.protocol}//${targetUrl.host}/`,
    'origin': `${targetUrl.protocol}//${targetUrl.host}`,
  };

  const init = { method, headers, redirect: 'follow' };

  if (!['GET', 'HEAD'].includes(method)) {
    if (Array.isArray(formPairs)) {
      const usp = new URLSearchParams();
      for (const [k, v] of formPairs) usp.append(String(k), String(v));
      init.body = usp.toString();
      init.headers['content-type'] = 'application/x-www-form-urlencoded;charset=UTF-8';
    } else {
      init.body = req;
      init.duplex = 'half';
    }
  }

  return fetch(targetUrl.toString(), init);
}

function applyResponseHeaders(res, upstream) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Cache-Control', 'no-store');

  const blockedHeaders = new Set([
    'content-security-policy',
    'content-security-policy-report-only',
    'x-frame-options',
    'frame-options',
    'permissions-policy',
    'report-to',
    'nel',
    'cross-origin-opener-policy',
    'cross-origin-embedder-policy',
    'cross-origin-resource-policy',
    'clear-site-data',
    'location',
    'content-length',
    'content-encoding',
    'transfer-encoding',
    'content-md5',
    'etag'
  ]);

  for (const [key, value] of upstream.headers.entries()) {
    if (!blockedHeaders.has(key.toLowerCase())) res.setHeader(key, value);
  }
}

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    return res.status(204).end();
  }

  const selfOrigin = getSelfOrigin(req);
  let rawTarget = '';
  let method = (req.method || 'GET').toUpperCase();
  let formPairs = null;

  if (method === 'POST' && req.headers['content-type']?.includes('application/json')) {
    rawTarget = req.body?.url || '';
    method = String(req.body?.method || 'GET').toUpperCase();
    formPairs = Array.isArray(req.body?.form) ? req.body.form : null;
  } else if (Array.isArray(req.query?.target) || req.query?.target) {
    rawTarget = decodePathTarget(req.query.target);
  } else if (req.query?.url) {
    rawTarget = String(req.query.url);
  }

  if (!rawTarget) return res.status(400).send('Missing target URL');
  rawTarget = unwrapProxyTarget(rawTarget, selfOrigin);

  let targetUrl;
  try {
    targetUrl = new URL(rawTarget);
    if (!/^https?:$/.test(targetUrl.protocol)) throw new Error('Bad protocol');
  } catch {
    return res.status(400).send('Invalid target URL');
  }

  if (isProxyUrl(targetUrl.toString(), selfOrigin)) {
    return res.status(400).send('Refusing self-proxy loop');
  }

  try {
    const upstream = await fetchUpstream(targetUrl, req, method, formPairs);
    applyResponseHeaders(res, upstream);

    const finalUrl = upstream.url || targetUrl.toString();
    const contentType = upstream.headers.get('content-type') || '';

    if (isHtml(contentType)) {
      const html = await upstream.text();
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.status(upstream.status).send(rewriteHtml(html, finalUrl, selfOrigin));
    }

    if (isCss(contentType)) {
      const css = await upstream.text();
      res.setHeader('content-type', 'text/css; charset=utf-8');
      return res.status(upstream.status).send(rewriteCssUrls(css, finalUrl, selfOrigin));
    }

    const buf = Buffer.from(await upstream.arrayBuffer());
    if (!res.getHeader('content-type') && contentType) {
      res.setHeader('content-type', contentType);
    }
    return res.status(upstream.status).send(buf);
  } catch (err) {
    return res.status(500).send(`Proxy fetch failed: ${err?.message || String(err)}`);
  }
}
