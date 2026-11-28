# What each step of the groups walk covers, against the old groups e2e

The old script is `apps/web/scripts/groups-e2e.mjs` on `test/groups-port-e2e-5` (44 numbered checks,
one linear run). The walk is `apps/web/e2e/groups.walk.mjs`: named steps in sections, run all or by
name or section (`WALK_ONLY=join`). The old checks are quoted from its labels.

## This build

Three parts of groups are held back in this build (`apps/web/src/lib/groups/build.ts`): making a
group from the app, a group's settings page, and its members page with its admin actions. Their
steps stay in the walk, skipped with the reason "held back in this build": create/allow-making-groups
through create/settings-members-only-and-back, and every roster step but
roster/members-address-answers-as-unknown. Where a table below names one of them, that check is not
run in this build; groups are made at the host (by script, or at the console's `/new`), and
admitted there (by script).

| What this build changed                                                      | Walk step                                                                                                             |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| the header, for a visitor: picture, name, badge, handle, counts, home        | link/header-for-a-visitor                                                                                             |
| "Group home" is the handle address, and opens the host's page for it         | link/header-for-a-visitor                                                                                             |
| a Website link only for an http(s) website, never `javascript:`              | link/website-only-when-http                                                                                           |
| `/p/<group handle or DID>` lands on the group page; a person's is as was     | link/profile-address-leads-to-the-group                                                                               |
| no listing switch: a group is in the lists while the host's declaration is   | link/listed-by-the-host, link/browse-signed-out, private/private-at-host, private/public-again-at-host                |
| the group's link asks no declaration write, only the event writes            | link/alice-links-by-handle, flags/index-endpoints-answer                                                              |
| a role granted only event writes links and posts; a plain member beside it   | link/event-writer-role-links-and-posts, link/plain-member-beside-the-role-cannot-post                                 |
| "Make a group" opens the host's `/new`; made there, then linked here         | create/make-a-group-goes-to-the-host, create/made-at-the-host-then-linked                                             |
| `/groups/create`, `…/settings`, `…/members` answer as an unknown address     | create/held-back-addresses-answer-as-unknown, roster/members-address-answers-as-unknown                               |
| a linked admin is sent to the host for members, requests, roles, settings    | join/linked-admin-is-sent-to-the-host, create/held-back-addresses-answer-as-unknown                                   |
| members-only events reuse a calendar another app made (key `wiki`)           | members-only/another-app-makes-a-wiki-calendar, turning-on-uses-the-wiki-calendar, alice-posts-into-the-wiki-calendar |
| ...members see its valid events only, and RSVP into it                       | members-only/a-member-sees-the-wiki-events-and-rsvps-there                                                            |
| ...an outsider gets "not found" for every key in it                          | members-only/an-outsider-gets-not-found-for-every-wiki-key                                                            |
| refused, with no second calendar, when no role may post to the one there     | members-only/refused-when-no-role-may-post-to-its-calendar                                                            |
| an older link is asked to approve again, and the prompt goes once it is      | link/an-older-link-is-asked-to-approve-again (needs `WALK_OLDER_LINK`)                                                |
| "Group host: <host>" opens the host's site; "Group home" the group's address | join/linked-admin-is-sent-to-the-host                                                                                 |
| turning on through the link alone (its read of the group's space index)      | members-only/turning-on-uses-the-wiki-calendar                                                                        |
| a plain member's link may not turn them on (403); the choice is unchanged    | members-only/a-member-who-links-may-not-turn-it-on                                                                    |
| a `self` calendar anyone may read: turning on is refused (409)               | members-only/refused-when-its-self-calendar-is-public                                                                 |
| /groups answers without the event index, and the scheduled job builds it     | setup/groups-list-with-and-without-its-event-index (drops it first with `WALK_EVENT_INDEX_TEST=1`)                    |
| no membership, join-request or settings permission asked; no createGroup     | link/alice-links-by-handle, flags/index-endpoints-answer, flags/admin-approval-page-asks-nothing-held-back            |

## One stacked part on its own (`WALK_UNIT`)

The feature is also built in stacked parts: `link-group` (link a group, its page, the lists,
browse and search, post public events as it, `/p/<group>`, "Make a group" at the host), then `join`
(join, ask, cancel, leave, "Your groups", a member seeing a private group), then
`members-only-events`. With `WALK_UNIT` set to one of the first two, against a dev server built from
that part's head, the sections of later parts (join, members-only) are skipped as "not in this
unit", and the checks that name a later part's permissions ask for this part's instead:

| On a build of one part                                                            | Walk step                                                                                                  |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| the group's link asks exactly the meta read, the event writes and image upload    | link/alice-links-by-handle, flags/index-endpoints-answer, flags/admin-approval-page-asks-nothing-held-back |
| no join control, no "Your groups" (link-group); nothing of members-only events    | link/nothing-of-later-units, link/private-linked-group-only-for-its-linker                                 |
| a person's client metadata gains nothing from groups (link-group), or only join's | flags/index-endpoints-answer (against a groups-off server of the same build with `WALK_GROUPS_OFF_URL`)    |

`/groups/create` reads as a group named `create` on these builds, and answers as a made-up group
does (404, "Group not found"); create/held-back-addresses-answer-as-unknown accepts that body too,
and notes which one each address matched.

The "another app" is a second loopback OAuth client of the walk's own, signed in as the group by
alice at the host's console with calendar-space scopes only (`manage=create`, and the event
collection and `org.example.wiki.page` writes). It makes the space by `com.atproto.space.createSpace`
under a policy where admins post events as the group and members read, with one more admin permission so it may write its own
kind of record there, is approved once more (the host grants a space's record writes only for a
space there at the approval), and puts the three records with `com.atproto.space.putRecord`.

## Old check, and the walk step that now covers it

| Old check                                                                             | Walk step                                                                                               |
| ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| signs in through their PDS                                                            | setup/people-sign-in                                                                                    |
| the owner makes a group at the host and lands on its page                             | create/make-a-public-listed-group                                                                       |
| a listed public group shows on the groups page, signed out                            | create/make-a-public-listed-group                                                                       |
| a public event lands in the group's repo at the host                                  | link/post-event-with-picture                                                                            |
| the group's public event shows on its page, signed out                                | link/visitor-sees-the-event                                                                             |
| the member asks to join                                                               | join/bob-asks-with-a-message-and-sees-it-waiting                                                        |
| the owner sees the request on the members page and approves it                        | roster/alice-links-and-sees-the-roster-controls, roster/approve-bobs-request                            |
| the member is a member on their next visit                                            | join/admitted-at-the-host-bob-is-a-member                                                               |
| the visit confirms the member on the roster                                           | roster/approve-bobs-request (under "Not confirmed yet" until the visit, then listed)                    |
| the settings form shows the group's listing as it is                                  | create/settings-change-and-records                                                                      |
| a members-only group is not found, signed out                                         | create/members-only-group-is-not-found-signed-out, create/settings-members-only-and-back                |
| the member still sees it                                                              | join/private-group-is-still-seen-by-a-member                                                            |
| a members-only group leaves the groups page                                           | create/settings-members-only-and-back                                                                   |
| made public and listed again, it shows signed out                                     | create/settings-members-only-and-back                                                                   |
| the owner unlinks the group                                                           | link/unlink-revokes-at-host                                                                             |
| linked again from the groups page in a fresh browser                                  | link/link-follows-alice, private/revoke-at-host-shows-link-again                                        |
| an event posted through the new link lands in the group's repo                        | link/post-event-with-picture                                                                            |
| the member leaves, and their next visit offers to ask again                           | join/bob-leaves-and-may-ask-again                                                                       |
| the owner's roster drops them                                                         | roster/remove-a-member                                                                                  |
| the former member asks again, the owner approves, and they are a member again         | roster/approve-bobs-request (bob asks again after leaving)                                              |
| the owner makes the member an admin                                                   | roster/make-bob-admin-and-back                                                                          |
| the new admin links the group and gets the roster controls                            | roster/two-admins-can-demote-each-other                                                                 |
| an event the new admin posts lands in the group's repo                                | link/event-writer-role-links-and-posts (a role granted event writes, not admin)                         |
| made a member again, they lose the roster controls                                    | roster/make-bob-admin-and-back (back to member), roster/a-plain-member-sees-the-roster-without-controls |
| an event posted through their old link is refused and never reaches the group         | link/lowered-role-refuses-the-save                                                                      |
| the owner removes them, and the roster drops them                                     | roster/remove-a-member                                                                                  |
| a removed member is not a member on their next visit                                  | roster/remove-a-member                                                                                  |
| they see the public group as anyone does                                              | roster/remove-a-member (the page offers "Ask to join" again)                                            |
| asked for group permissions, their server returns without them, and the page explains | join/carol-without-spaces-gets-an-explanation                                                           |
| their members page explains too, and names a server with spaces support               | none yet (the group page names it; the members page is not visited by carol)                            |
| an admin adds them by handle, and they wait under not confirmed yet                   | roster/carol-admitted-shows-as-not-confirmed (through a request, not "by handle")                       |
| after their visit they are still not confirmed, and the group still loads             | none yet                                                                                                |

## Members-only events, and the old checks they now cover

| Old check                                                 | Walk step                                                                                       |
| --------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| a members-only event stays out of the group's public repo | members-only/nothing-public-shows-it                                                            |
| the member sees the members-only event                    | members-only/bob-joins-and-sees-it, members-only/bob-rsvps-into-his-own-repo                    |
| never sees the members-only event                         | members-only/outsider-mallory-gets-not-found, members-only/nothing-public-shows-it (signed out) |
| still sees it, members-only event included                | members-only/private-group-member-still-sees-it                                                 |
| no longer sees the members-only event                     | members-only/bob-leaves-and-it-is-gone                                                          |

The section's other steps have no old counterpart: alice-turns-on-members-only-events,
approve-once-more-at-the-console, alice-posts-a-members-only-event, carol-is-told-why-she-cannot.

## Old checks with no counterpart yet

The old "admin adds a member by handle" (the walk's members page has no add-by-handle; asking and
approving is used), and carol's members page.

## Steps with no old counterpart

link: member-links-the-group-and-can-do-little, lowered-role-refuses-the-save,
event-writer-role-links-and-posts, plain-member-beside-the-role-cannot-post, the host-side live checks
(client metadata, token exchange, delegation and credential calls), unlink-revokes-at-host.
private: private-at-host, public-again-at-host, roles-removed-ends-the-link,
revoke-at-host-shows-link-again.
create: allow-making-groups, unlisted-group-has-no-declaration, same-address-again-is-taken,
unfinished-group-can-be-finished.
join: bob-allows-joining-groups, bob-cancels-and-asks-again, your-groups-lists-it, open-group-admits-at-once,
invitation-only-group-says-so, dana-on-the-other-spaces-pds-asks-and-is-admitted.
roster: deny-mallorys-request, approving-a-request-already-gone.
flags: index-endpoints-answer, admin-approval-page-asks-nothing-held-back. Of the members space, the
group's link asks only to read the group's index of spaces (`org.atgrp.space`), which the approval
page lists as read only. wrap: groups-page-needs-no-missing-tables, console-approval-page-works.

## Skipped steps, and why

create/todo-approve-again-for-an-old-link, roster/todo-approve-again-on-the-members-page: need a link
whose asked scope is out of date, which a fresh database cannot hold.
roster/todo-last-admin-sentence: no click reaches it. flags/off-state: needs a server without the host.
private/todo-lowered-role-gives-visitor-page.
In this build: the create steps for making a group from the app and its settings, and the roster
section but its first step, held back in this build (see above).
