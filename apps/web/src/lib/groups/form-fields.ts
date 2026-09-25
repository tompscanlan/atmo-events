// Field schemas shared by the group forms. They live outside
// `groups.remote.ts` because the Vite plugin rejects non-remote exports from
// `*.remote.ts`, so anything declared there cannot be imported by a test.
import * as v from 'valibot';

/** An HTML checkbox sends `on` when ticked and nothing at all when not, so
 *  presence is the value.
 *
 *  The `''` default is required. Without a default, valibot treats the object
 *  entry as optional and skips it when the key is missing, so the transform
 *  never runs and an unticked box parses to `undefined` instead of `false`.
 *  Both group forms would then read "not supplied" instead of "off":
 *    * `createGroup` (`./server/repo.ts`, `requireApproval === false ? 0 : 1`)
 *      would store `require_approval = 1`, so an open-join group could not be
 *      created at all.
 *    * `updateGroup` skips a column whose input is `undefined`, so the row
 *      would keep its old value, while the `profile` record (derived through
 *      `data.requireApproval ? 1 : 0`) would be written `open`. The group page
 *      renders the record's `joinPolicy` and the join gate reads the row, so
 *      the group would advertise open joining while still queueing approvals.
 *
 *  With the default the entry is always present, the transform always runs,
 *  and the output is `boolean` rather than `boolean | undefined`. */
export const checkboxField = v.pipe(
	v.optional(v.string(), ''),
	v.transform((value) => value !== '')
);
