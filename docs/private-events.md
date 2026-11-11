# Private events

A private event is kept in its own space on the host's PDS, and read straight from that PDS with
each person's own access. It never reaches the index or a public URL. Private events are a beta:
each person turns them on in Settings.

## Settings a deployment has

- `PRIVATE_EVENTS=true` turns private events on. Unset, `/private` and the event pages return 404.
- `PRIVATE_EVENT_INVITATIONS=true` turns invitations on as well. It does nothing without the
  first. Leave it off until the inbox space type (`rsvp.atmo.dev.inbox`,
  `lexicons/spaces/rsvp/atmo/dev/inbox.json`) is published where people's PDSes can find it: a PDS
  refuses a whole sign-in that names a type it can't find, so with this on too early nobody could
  allow private events at all.
- `SPACES_PDS_URL`, optional: a PDS with spaces support to point people at.

## Invitations

A PDS lists a space for someone only after they write in it, and tells nobody they were added. So
without invitations, an invited person sees nothing in atmo until the host sends them the link.

With invitations on:

- Each person who allows private events gets an inbox: a space on their own PDS, type
  `rsvp.atmo.dev.inbox`, key `self`, that anyone may write to and only they read.
- Adding a guest also writes an invite (`rsvp.atmo.dev.invite`) in the host's own repo, in the
  guest's inbox. Its key is the event's key and it holds the event's URI and a date. Removing the
  guest or cancelling the event deletes it.
- `/private` reads the inbox and lists the invitations the person hasn't answered: who invited
  them, when, and a link to the event.

This is the invites space of the opensocial.group proposal, with an invite that can name an event.

What it can't do:

- A PDS accepts an invite whether or not the guest has an inbox, so a host is never told it
  arrived. The guest list still says to send the link.
- An invite written before the guest's inbox exists is never listed in it.
- Anyone can write into an inbox. Every invite shows, by the inviter's verified handle.
- `/private` reads at most 50 inviters and 20 invites from each, and gives all their servers 4
  seconds together. Past any of those it says there may be more.

## What other people's servers learn

Two things tell someone else's server that a person looked, and atmo does neither behind a click.
Both were left out because the extra step cost more than it protected. They may be worth adding
later, perhaps as a setting a person can turn on.

- **Opening an event** asks the host's server for it, so that server learns who asked and when.
  An earlier version showed a page with an "Open this event" button first. A guest now lands on
  the event directly.
- **Loading `/private`** asks each server that has ever written into the person's inbox for its
  invites, so each learns that the person looked at their invitations, though not which one they
  opened. A writer stays on an inbox's list after deleting their invite, and anyone can write, so a
  stranger can cause this with one write. Not built: reading only from hosts the person already
  knows, with a button to check the rest.
