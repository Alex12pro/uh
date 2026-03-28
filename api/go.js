export const config = {
  runtime: "nodejs",
};

function isHtml(ct = "") {
  return /text\/html|application\/xhtml\+xml/i.test(ct);
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

function proxify(origin, absoluteUrl) {
  // 🔥 PREVENT DOUBLE PROXY (THIS FIXES 414)
  if (absoluteUrl.includes("/api/go?url=")) return absoluteUrl;
  return `${origin}/api/go?url=${encodeURIComponent(absoluteUrl)}`;
}

function rewriteHtml(html, baseUrl, origin) {
  let out = String(html);

  const attrs = ["href", "src", "action"];
  for (const attr of attrs) {
    const re = new RegExp(`${attr}=(["'])(.*?)\\1`, "gi");
    out = out.replace(re, (m, quote, value) => {
      if (shouldSkipUrl(value)) return m;

      const absolute = abs(baseUrl, value);

      // 🔥 prevent recursive wrapping
      if (absolute.includes("/api/go?url=")) {
        return `${attr}=${quote}${absolute}${quote}`;
      }

      return `${attr}=${quote}${proxify(origin, absolute)}${quote}`;
    });
  }

  return out;
}

export default async function handler(req, res) {
  const { url } = req.query;
  if (!url) return res.status(400).send("Missing url");

  let target;
  try {
    target = new URL(url);
  } catch {
    return res.status(400).send("Invalid URL");
  }

  try {
    const response = await fetch(target.toString(), {
      headers: {
        "user-agent": "Mozilla/5.0 VoidBrowser",
        "accept-encoding": "identity"
      }
    });

    const contentType = response.headers.get("content-type") || "";
    const origin = `${req.headers["x-forwarded-proto"] || "https"}://${req.headers.host}`;

    // remove blocking headers
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Cache-Control", "no-store");

    if (isHtml(contentType)) {
      const html = await response.text();
      return res.send(rewriteHtml(html, target.toString(), origin));
    }

    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader("content-type", contentType);
    return res.send(buffer);

  } catch (err) {
    return res.status(500).send("Proxy failed");
  }
}
