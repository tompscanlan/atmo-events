---
'@atmo-dev/events-ui': minor
---

The components can be pointed at an atproto network other than the public one.

`configureAtproto({ imageUrlTemplate, appviewUrl })` sets where event images and the Bluesky API are
read from, and an app calls it once, from its root layout. `imageUrlTemplate` fills in `{did}`,
`{cid}` and `{format}`.

Without the call, both are the addresses the components always used, exported as
`DEFAULT_IMAGE_URL_TEMPLATE` and `DEFAULT_APPVIEW_URL`.
