---
'@atmo-dev/events-ui': minor
---

The components can be pointed at an atproto network other than the public one.

`configureAtproto({ blobUrlTemplate, appviewUrl })` sets where event images and the Bluesky API are
read from, and an app calls it once, from its root layout. `blobUrlTemplate` fills in `{did}`,
`{cid}` and `{format}`. A null `appviewUrl` turns off what reads from the Bluesky API: comments show
none, and the post-to-Bluesky modal's mention search finds nobody.

Without the call, both are the addresses the components always used, exported as
`DEFAULT_BLOB_URL_TEMPLATE` and `DEFAULT_APPVIEW_URL`.
