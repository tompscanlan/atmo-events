---
"@atmo-dev/events-ui": minor
---

Keep the place name and the coordinates when picking an event location. The editor and the recurring event modal now write a `community.lexicon.location.geo` entry carrying the coordinates, so a park saves as the park instead of as its city and the event gets coordinates for radius search. A pick the geocoder gave no ISO country code for is written as that geo entry alone, carrying the place name, because the address lexicon requires a country.

Readers show the place name. The event page and both calendar exports lead with it and show the whole location, including the country. A card or an embed keeps showing the locality and region, as it did before — a list answers "is this near me?" — and falls back to the place name only for a record that has no locality or region, which such a card used to render blank. A record saved as usable bare coordinates shows its point instead of rendering nothing. Records authored before this change are not rewritten, but they are read by the same rules, so an existing record that already had a place name now displays it.

A point of `0,0` is read as the "no data" sentinel it conventionally is: a record carrying it shows its address rather than a position in the Gulf of Guinea, and a record that is nothing but the sentinel shows no location. This is a display rule only — stored coordinates are left as they are.

Adds `locationShortLabel`, `locationFullLabel`, `locationSummary`, `leadingPlaceName`, and `formatPoint` for reading a display location out of a record's `locations[]`.
