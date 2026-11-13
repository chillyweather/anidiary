# Browser Security Policy

Anidiary sends its browser security headers before static files and application
routes, so static responses carry them too. Its Content Security Policy does not
allow inline script execution.

Its only external allowlist is `cdn.myanimelist.net`, `s4.anilist.co`, and
`shikimori.io` for provider posters (`img-src`, which also allows `data:` for the
stylesheet's inline SVG icons). Fonts are self-hosted, so `style-src` and
`font-src` are `'self'` only and no page contacts a font service.

All scripts, styles, fonts, API connections, forms, and other resources are
same-origin. Pages carry no inline scripts, event-handler attributes, or `style`
attributes. Frames,
plugins, camera, microphone, and geolocation are disabled.

Sessions use an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). Every
POST requires the session's CSRF token. Anonymous visitors get a session only
when a login or registration form is rendered; it lasts 1 hour, and login
regenerates it into a 30-day session with a new token.
