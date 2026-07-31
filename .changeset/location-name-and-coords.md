---
"@atmo-dev/events-ui": minor
---

Keep the place name and the coordinates when picking an event location. The editor and the recurring event modal now write a `community.lexicon.location.geo` entry carrying the coordinates, so a park saves as the park instead of as its city and the event gets coordinates for radius search. A pick the geocoder gave no ISO country code for is written as that geo entry alone, carrying the place name, because the address lexicon requires a country.

A pick with no country code also keeps its TOWN. The geo lexicon has no locality or region field, so the locality and region are comma-joined onto the geo entry's `name` alongside the place name — otherwise they are discarded at save time and no reader can recover them, and a card ends up showing a street with no town beside it.

Readers show the place name and then the town. A card or an embed leads with the name and adds locality and region; the event page and both calendar exports show the whole location, including the country. Nothing shortens the name: recovering a town from a reverse-geocoded string written by another client means guessing which comma segment is a street and which is a settlement, and that guess is wrong too often to be worth making. A record saved as usable bare coordinates shows its point instead of rendering nothing. Records authored before this change are not rewritten, but they are read by the same rules, so an existing record that already had a place name now displays it.

A point of `0,0` is read as the "no data" sentinel it conventionally is: a record carrying it shows its address rather than a position in the Gulf of Guinea, and a record that is nothing but the sentinel shows no location. This is a display rule only — stored coordinates are left as they are.

Adds `locationShortLabel`, `locationFullLabel`, `locationSummary`, and `formatPoint` for reading a display location out of a record's `locations[]`.
