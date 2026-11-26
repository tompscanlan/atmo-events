# What each step of the groups walk covers, against the old groups e2e

The old script is `apps/web/scripts/groups-e2e.mjs` on `test/groups-port-e2e-5` (44 numbered checks,
one linear run). The walk is `apps/web/e2e/groups.walk.mjs`: named steps in sections, run all or by
name or section (`WALK_ONLY=join`). The old checks are quoted from its labels.

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
| an event the new admin posts lands in the group's repo                                | none yet (the admin's posting is covered for the founder)                                               |
| made a member again, they lose the roster controls                                    | roster/make-bob-admin-and-back (back to member), roster/a-plain-member-sees-the-roster-without-controls |
| an event posted through their old link is refused and never reaches the group         | link/lowered-role-refuses-the-save                                                                      |
| the owner removes them, and the roster drops them                                     | roster/remove-a-member                                                                                  |
| a removed member is not a member on their next visit                                  | roster/remove-a-member                                                                                  |
| they see the public group as anyone does                                              | roster/remove-a-member (the page offers "Ask to join" again)                                            |
| asked for group permissions, their server returns without them, and the page explains | join/carol-without-spaces-gets-an-explanation                                                           |
| their members page explains too, and names a server with spaces support               | none yet (the group page names it; the members page is not visited by carol)                            |
| an admin adds them by handle, and they wait under not confirmed yet                   | roster/carol-admitted-shows-as-not-confirmed (through a request, not "by handle")                       |
| after their visit they are still not confirmed, and the group still loads             | none yet                                                                                                |

## Old checks with no counterpart yet

The members-only layer (members-only events: posting, who sees them, a removed member no longer
sees them) is a later section: old checks "a members-only event stays out of the group's public
repo", "the member sees the members-only event", "never sees the members-only event", "still sees
it, members-only event included" and "no longer sees the members-only event". Also the old
"admin adds a member by handle" (the walk's members page has no add-by-handle; asking and approving
is used), "an event the new admin posts", and carol's members page.

## Steps with no old counterpart

link: member-links-the-group-and-can-do-little, lowered-role-refuses-the-save, the host-side live checks
(client metadata, token exchange, delegation and credential calls), unlink-revokes-at-host.
private: private-at-host, private-group-cannot-be-listed, public-again-at-host, roles-removed-ends-the-link,
revoke-at-host-shows-link-again.
create: allow-making-groups, unlisted-group-has-no-declaration, same-address-again-is-taken,
unfinished-group-can-be-finished.
join: bob-allows-joining-groups, bob-cancels-and-asks-again, your-groups-lists-it, open-group-admits-at-once,
invitation-only-group-says-so, dana-on-the-other-spaces-pds-asks-and-is-admitted.
roster: deny-mallorys-request, approving-a-request-already-gone.
flags: index-endpoints-answer. wrap: groups-page-needs-no-missing-tables, console-approval-page-works.

## Skipped steps, and why

create/todo-approve-again-for-an-old-link, roster/todo-approve-again-on-the-members-page: need a link
whose asked scope is out of date, which a fresh database cannot hold.
roster/todo-last-admin-sentence: no click reaches it. flags/off-state: needs a server without the host.
private/todo-lowered-role-gives-visitor-page.
