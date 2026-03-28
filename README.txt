# Void Vercel Fix v2

This update fixes the net::ERR_CONTENT_DECODING_FAILED issue.

What changed:
- Forces upstream requests to ask for identity encoding
- Strips content-encoding and transfer-encoding from proxied responses
- Resets HTML and CSS content-type headers after rewriting

Deploy this version to Vercel and replace the old one.
