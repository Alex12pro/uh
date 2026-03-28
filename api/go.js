export const config = {
  runtime: "nodejs",
};

function isHtml(ct = "") {
  return /text\/html|application\/xhtml\+xml/i.test(ct);
}

function isCss(ct = "") {
  return /text\/css/i.test(ct);
}

function shouldSkipUrl(v = "") {
  const s = String(v).trim();
  return (
    !s ||
    s.startsWith("#") ||
    s.startsWith("javascript:") ||
    s.startsWith("mailto:") ||
    s.startsWith("tel:") ||
    s.startsWith("data:") ||
    s.startsWith("blob:")
  );
}

function abs(base, value) {
  try {
    return new URL(value, base).toString();
  } catch {
    return value;
  }
}

function isAlreadyProxied(value) {
  return /\/api\/go\?url=/i.test(String(value || ""));
}

function proxify(origin, absoluteUrl) {
  if (isAlreadyProxied(absoluteUrl)) return absoluteUrl;
  return `${origin}/api/go?url=${encodeURIComponent(absoluteUrl)}`;
}

function rewriteCssUrls(css, baseUrl, origin) {
  return String(css).replace(/url\((['"]?)(.*?)\1\)/gi, (_, q, raw) => {
    const v = String(raw || "").trim();
    if (shouldSkipUrl(v)) return `url(${q}${v}${q})`;
    const absolute = abs(baseUrl, v);
    return `url(${q}${proxify(origin, absolute)}${q})`;
  });
}

function rewriteSrcset(srcset, baseUrl, origin) {
  return String(srcset).split(",").map((part) => {
    const seg = part.trim();
    if (!seg) return seg;
    const pieces = seg.split(/\s+/);
    const rawUrl = pieces.shift();
    if (!rawUrl || shouldSkipUrl(rawUrl)) return seg;
    const absolute = abs(baseUrl, rawUrl);
    return [proxify(origin, absolute), ...pieces].join(" ");
  }).join(", ");
}

function injectClient(baseUrl, origin) {
  return `
<script>
(() => {
  const VOID_BASE = ${JSON.stringify(baseUrl)};
  const VOID_ORIGIN = ${JSON.stringify(origin)};

  const shouldSkip = (u) => {
    if (!u) return true;
    const s = String(u).trim();
    return !s || s.startsWith("#") || s.startsWith("javascript:") || s.startsWith("mailto:") || s.startsWith("tel:") || s.startsWith("data:") || s.startsWith("blob:");
  };

  const isAlreadyProxied = (u) => /\\/api\\/go\\?url=/i.test(String(u || ""));

  const abs = (u) => {
    try { return new URL(u, VOID_BASE).toString(); }
    catch { return u; }
  };

  const proxify = (u) => {
    if (shouldSkip(u)) return u;
    if (isAlreadyProxied(u)) return u;
    return \`\${VOID_ORIGIN}/api/go?url=\${encodeURIComponent(abs(u))}\`;
  };

  const navTo = (u, push = true) => {
    if (shouldSkip(u)) return;
    const absolute = abs(u);
    if (window.top !== window.self) {
      parent.postMessage({ type: "VOID_NAVIGATE", url: absolute, push }, "*");
    } else {
      location.href = proxify(absolute);
    }
  };

  const oldFetch = window.fetch;
  window.fetch = function(input, init) {
    try {
      if (typeof input === "string") input = proxify(input);
      else if (input instanceof URL) input = proxify(input.toString());
      else if (input && input.url) input = new Request(proxify(input.url), input);
    } catch {}
    return oldFetch.call(this, input, init);
  };

  const xhrOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(method, url, ...rest) {
    try { url = proxify(url); } catch {}
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

  document.addEventListener("click", (e) => {
    const a = e.target && e.target.closest ? e.target.closest("a[href]") : null;
    if (!a) return;
    const href = a.getAttribute("href");
    if (shouldSkip(href)) return;
    e.preventDefault();
    navTo(href, true);
  }, true);

  document.addEventListener("submit", async (e) => {
    const f = e.target;
    if (!(f instanceof HTMLFormElement)) return;
    e.preventDefault();

    const method = (f.getAttribute("method") || "GET").toUpperCase();
    const action = abs(f.getAttribute("action") || location.href);

    if (method === "GET") {
      const fd = new FormData(f);
      const u = new URL(action);
      for (const [k, v] of fd.entries()) u.searchParams.append(k, v);
      navTo(u.toString(), true);
      return;
    }

    try {
      const res = await fetch(proxify(action), {
        method,
        body: new FormData(f)
      });
      const html = await res.text();
      document.open();
      document.write(html);
      document.close();
    } catch {
      navTo(action, true);
    }
  }, true);

  const rewriteNode = (root) => {
    if (!root || !root.querySelectorAll) return;
    root.querySelectorAll("[href],[src],[action],[poster],[data],[srcset],[style]").forEach((el) => {
      ["href","src","action","poster","data"].forEach((attr) => {
        const v = el.getAttribute(attr);
        if (v && !shouldSkip(v) && !isAlreadyProxied(v)) {
          el.setAttribute(attr, proxify(v));
        }
      });

      const ss = el.getAttribute("srcset");
      if (ss) {
        const rewritten = ss.split(",").map(part => {
          const seg = part.trim();
          if (!seg) return seg;
          const pieces = seg.split(/\\s+/);
          const raw = pieces.shift();
          if (!raw || shouldSkip(raw) || isAlreadyProxied(raw)) return seg;
          return [proxify(raw), ...pieces].join(" ");
        }).join(", ");
        el.setAttribute("srcset", rewritten);
      }

      const style = el.getAttribute("style");
      if (style && /url\\(/i.test(style)) {
        el.setAttribute("style", style.replace(/url\\((['"]?)(.*?)\\1\\)/gi, (m, q, raw) => {
          if (shouldSkip(raw) || isAlreadyProxied(raw)) return m;
          return "url(" + q + proxify(raw) + q + ")";
        }));
      }

      if (el.tagName === "FORM") {
        const target = (el.getAttribute("target") || "").toLowerCase();
        if (target && target !== "_self") el.setAttribute("target", "_self");
      }
    });
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
    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then(regs => regs.forEach(r => r.unregister())).catch(() => {});
    }
  } catch {}
})();
</script>`;
}

function rewriteHtml(html, baseUrl, origin) {
  let out = String(html);

  out = out.replace(
    /<head([^>]*)>/i,
    `<head$1><base href="${baseUrl}">${injectClient(baseUrl, origin)}`
  );

  out = out.replace(/\s(integrity)=["'][^"']*["']/gi, "");
  out = out.replace(/\snonce=(["']).*?\1/gi, "");

  const attrs = ["href", "src", "action", "poster", "data"];
  for (const attr of attrs) {
    const re = new RegExp(`${attr}=(["'])(.*?)\\1`, "gi");
    out = out.replace(re, (m, quote, value) => {
      if (shouldSkipUrl(value)) return m;
      const absolute = abs(baseUrl, value);
      if (isAlreadyProxied(absolute)) return `${attr}=${quote}${absolute}${quote}`;
      return `${attr}=${quote}${proxify(origin, absolute)}${quote}`;
    });
  }

  out = out.replace(/srcset=(["'])(.*?)\1/gi, (m, quote, value) => {
    return `srcset=${quote}${rewriteSrcset(value, baseUrl, origin)}${quote}`;
  });

  out = out.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, css) => {
    return `<style>${rewriteCssUrls(css, baseUrl, origin)}</style>`;
  });

  out = out.replace(/style=(["'])(.*?)\1/gi, (m, quote, css) => {
    return `style=${quote}${rewriteCssUrls(css, baseUrl, origin)}${quote}`;
  });

  return out;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    return res.status(204).end();
  }

  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");

  let target;
  try {
    target = new URL(url);
    if (!/^https?:$/.test(target.protocol)) throw new Error("Bad protocol");
  } catch {
    return res.status(400).send("Invalid URL");
  }

  try {
    const method = (req.method || "GET").toUpperCase();
    const headers = {
      "user-agent": req.headers["user-agent"] || "Mozilla/5.0 VoidBrowser",
      "accept-language": req.headers["accept-language"] || "en-US,en;q=0.9",
      "accept-encoding": "identity",
      "referer": `${target.protocol}//${target.host}/`,
      "origin": `${target.protocol}//${target.host}`,
    };

    const init = { method, headers, redirect: "follow" };

    if (!["GET", "HEAD"].includes(method)) {
      init.body = req;
      init.duplex = "half";
    }

    const response = await fetch(target.toString(), init);
    const contentType = response.headers.get("content-type") || "";
    const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,HEAD,POST,PUT,PATCH,DELETE,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.setHeader("Cache-Control", "no-store");

    const blockedHeaders = new Set([
      "content-security-policy",
      "content-security-policy-report-only",
      "x-frame-options",
      "frame-options",
      "permissions-policy",
      "report-to",
      "nel",
      "cross-origin-opener-policy",
      "cross-origin-embedder-policy",
      "cross-origin-resource-policy",
      "clear-site-data",
      "location",
      "content-length",
      "content-encoding",
      "transfer-encoding",
      "content-md5",
      "etag"
    ]);

    for (const [key, value] of response.headers.entries()) {
      if (!blockedHeaders.has(key.toLowerCase())) {
        res.setHeader(key, value);
      }
    }

    if (isHtml(contentType)) {
      const html = await response.text();
      res.setHeader("content-type", "text/html; charset=utf-8");
      return res.status(response.status).send(rewriteHtml(html, target.toString(), origin));
    }

    if (isCss(contentType)) {
      const css = await response.text();
      res.setHeader("content-type", "text/css; charset=utf-8");
      return res.status(response.status).send(rewriteCssUrls(css, target.toString(), origin));
    }

    const buf = Buffer.from(await response.arrayBuffer());
    if (!res.getHeader("content-type") && contentType) {
      res.setHeader("content-type", contentType);
    }
    return res.status(response.status).send(buf);
  } catch (err) {
    return res.status(500).send(`Proxy fetch failed: ${err?.message || String(err)}`);
  }
}
