// Which parts of groups are in this build. A part left out stays in the tree, but nothing asks for
// it, links to it or depends on it, and its addresses match no route (./reroute.ts). Turning one on
// is its one line.

/** On brings back making a group here, with its "Finish setting up" and the person's permission. */
export const CREATE_IN_THIS_BUILD: boolean = false;
