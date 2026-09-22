// Field schemas shared by the group forms, kept OUT of `groups.remote.ts` for
// the reason `./create-group.ts` names: the Vite plugin rejects non-remote
// exports from `*.remote.ts`, so anything declared there cannot be imported by
// a test. A field whose parsing has already been wrong once belongs where it is
// assertable.
import * as v from 'valibot';

/** An HTML checkbox sends `on` when ticked and NOTHING AT ALL when not, so
 *  presence is the value.
 *
 *  THE DEFAULT IS LOAD-BEARING, and its absence was a live bug (found
 *  2026-09-22 in the T023 browser walk, `om-6kci0`). The field used to be
 *  `v.pipe(v.optional(v.string()), v.transform(…))`: with no default, valibot
 *  treats the OBJECT ENTRY as optional and skips it when the key is missing, so
 *  the transform never ran and an unticked box parsed to `undefined` rather
 *  than `false`.
 *
 *  Both consumers then read "not supplied" instead of "off", in opposite
 *  directions:
 *    * `createGroup` (`./server/repo.ts`, `requireApproval === false ? 0 : 1`)
 *      fell back to `require_approval = 1` — an open-join group could not be
 *      created at all, at any visibility.
 *    * `updateGroup` skips a column whose input is `undefined`, so the ROW kept
 *      its old value, while the `profile` RECORD — derived from the same
 *      variable through `data.requireApproval ? 1 : 0` — was written `open`.
 *      The group page renders the record's `joinPolicy` and the join gate reads
 *      the row (`requestJoin`), so the group advertised open joining while
 *      still queueing approvals.
 *
 *  Defaulting to `''` keeps the entry present, so the transform always runs and
 *  the output is `boolean` rather than `boolean | undefined`. */
export const checkboxField = v.pipe(
	v.optional(v.string(), ''),
	v.transform((value) => value !== '')
);
