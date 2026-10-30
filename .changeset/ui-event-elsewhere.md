---
'@atmo-dev/events-ui': minor
---

A page can show an event that is not in its creator's public repo, such as a group's
members-only event in a space:

- `EventView` uses `data.eventUri`, when set, as the event's URI, so an RSVP and the calendar
  file name the record where it is. With `data.shareable` set to false it opens no share
  prompt, after an RSVP or a create, since such an event has no public page.
- `EventCard` takes `href`, where the card links when the event's page is not `/p/…/e/…`.
- `EventEditor` offers no image, and renders or uploads none, when the adapter's
  `features.images` is false, for an event whose image would be public though it is not.

All are optional. Without them, each component works as before.
