# Browser Security Policy

Anidiary sends its browser security headers before static files and application
routes, so static responses carry them too. Its Content Security Policy does not
allow inline script execution.

The external allowlist is intentionally limited to:

- `fonts.googleapis.com` for the Nunito stylesheet;
- `fonts.gstatic.com` for Nunito font files;
- `cdn.myanimelist.net`, `s4.anilist.co`, and `shikimori.io` for provider posters.

All scripts, API connections, forms, and other resources are same-origin. Frames,
plugins, camera, microphone, and geolocation are disabled.

Sessions use an `httpOnly`, `SameSite=Lax` cookie (`Secure` in production). Every
POST requires the session's CSRF token. Anonymous visitors get a session only
when a login or registration form is rendered; it lasts 1 hour, and login
regenerates it into a 30-day session with a new token.
