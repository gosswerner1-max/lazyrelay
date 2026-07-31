# LazyRelay browser extension

Adds two right-click context menu entries:

- **Schedule this page with LazyRelay** — on any page or link, opens lazyrelay.com with the page URL pre-filled into the compose box.
- **Schedule this image with LazyRelay** — on any image, opens lazyrelay.com with the image URL pre-filled as the post's media.

## Loading it locally (unpacked)

1. Go to `chrome://extensions`.
2. Turn on **Developer mode** (top right).
3. Click **Load unpacked** and select this `browser-extension/` folder.

## What this does NOT do (real, current limitations)

- **No extension-side login.** The prefill only works if the customer already has a signed-in LazyRelay tab/session open — there's no OAuth/API-key flow built into the extension itself. If they're signed out, the prefill param is silently dropped by the dashboard (it just won't have anyone to attach the draft to).
- **Not published to the Chrome Web Store.** This is a real, working unpacked extension, not a listed one — publishing needs a Google developer account, a review pass, and store-listing assets, none of which is part of this build.
- **Firefox/Edge**: Manifest V3 with this shape loads in Chromium-based browsers (Chrome, Edge, Brave). Not tested in Firefox.
