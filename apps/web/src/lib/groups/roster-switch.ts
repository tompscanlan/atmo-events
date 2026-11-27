// Whether the members page and its admin actions are part of this build: the roster of a group, its
// requests to join, and admitting, denying, giving roles and removing members, all as the group.
// A group's host already does all of that for its admins, so for now this site leaves it there.
//
// Off, nothing asks for them: the group sign-in asks for none of the roster's scopes, a link's
// abilities hold none of its acts, the group page does not link to the members page, its address
// matches no route (./reroute.ts), and its commands refuse. Turning it on is this one line.
export const ROSTER_IN_THIS_BUILD: boolean = false;
