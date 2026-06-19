# Browser Security Policy

Anidiary sends its browser security headers before static files and application
routes. Its Content Security Policy does not allow inline script execution.

The external allowlist is intentionally limited to:

- `fonts.googleapis.com` for the Nunito stylesheet;
- `fonts.gstatic.com` for Nunito font files;
- `cdn.myanimelist.net`, `s4.anilist.co`, and `shikimori.one` for provider posters.

All scripts, API connections, forms, and other resources are same-origin. Frames,
plugins, camera, microphone, and geolocation are disabled.
