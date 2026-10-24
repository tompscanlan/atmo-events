---
'@atmo-dev/events-ui': minor
---

A page can show an event stored somewhere other than its creator's repo, such as a group's
members-only event, and say where things point.

- `EventCard` takes `href`, where the card links, and `lockLabel`, the lock icon's label.
- `EventView` reads `eventUri` and `editHref` from its data when they are set, and shows Edit when
  `editHref` is set. It skips the share prompt after an RSVP to a members-only event, and shows the
  invite flow only when it has a space key.
- `EventEditor` takes `storedImageUrl`, to preview an image the event already has when that image is
  not on the CDN.

Every new prop is optional. Without them, each component works as before.
