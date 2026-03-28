Void rebuilt proxy system

Files:
- public/index.html
- api/proxy/index.js
- api/proxy/[...target].js
- api/proxy/shared.js
- vercel.json

Major changes:
- path-based target encoding instead of nested query rewriting
- self-proxy loop detection and unwrapping
- safer client-side URL interception
- POST JSON bridge for many non-file form submits
- response header stripping for iframe compatibility

Notes:
- This should remove proxy-caused recursion and malformed URL problems.
- Browser extensions such as ad blockers can still block some upstream resources.
- Some anti-bot sites and complex apps may still refuse to work because that is controlled by the remote site.
