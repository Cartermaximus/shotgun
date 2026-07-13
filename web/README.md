# familybiographer.com

Static marketing site + the legal pages Stripe requires (privacy, terms,
refunds). No build step — plain HTML/CSS.

Deployed on Cloudflare Pages from this repo (root directory: `web`).
`_redirects` forwards `/gift/CODE` links to the backend's invite pages.

Contact email on every page is support@familybiographer.com — forwarded to
Gmail via Cloudflare Email Routing.
