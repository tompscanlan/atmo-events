// The one record a group publishes to the ANONYMOUS web.
//
// Every other record a group owns lives in a space, and a space refuses an
// anonymous reader even under a public policy — measured against the reference
// PDS, which answers `AuthMissing` to an unauthenticated `describeSpace` on a
// space provisioned publicRead. So a peer app that has never heard of us can
// see that a DID is a group, and follow a pointer to where the rest lives, only
// because this one record sits in the group's PUBLIC repo, where it is
// anonymously readable and carried on the firehose for free.
//
// It is a pointer and nothing else: no name, no avatar, no member count. A peer
// that wants the group's name asks the about space and is refused. That is the
// design rather than a gap, and no UI may promise anonymous name rendering.
// (Spec: FR-003.)
//
// NOT WRITTEN FOR A PRIVATE GROUP. Since a members-only group narrows at the
// protocol layer, this record is the only cross-app artifact that distinguishes
// a group anyone may discover from one nobody may, so its presence or absence
// IS that switch. What it does not buy: the group's DID and handle are both
// published to the PLC audit log at genesis, so a private group's existence and
// address remain enumerable by anyone willing to read that log.
//
// Pure, like ./about-record.ts and ./event-record.ts: shape only, no D1 and no
// PDS, so the builder and the predicate can be asserted without a request.
// Permission, authorship and transport live in ./server/declaration-writer.ts.
import type { GroupRow } from './types';

/** The collection, and only here — a prefix change is one edit. Ours rather
 *  than the draft's `community.opensocial.declaration` for the reason every
 *  other group record is: that prefix resolves to a domain someone else holds,
 *  and the leaf matches so a settled standard is a rename plus a replay. */
export const GROUP_DECLARATION_COLLECTION = 'net.openmeet.group.declaration';

/** A singleton, keyed like every other atproto singleton: a DID is one group,
 *  so a second declaration under the same repo would be a contradiction rather
 *  than a second group. */
export const GROUP_DECLARATION_RKEY = 'self';

export interface GroupDeclarationInput {
	/** `at://<group did>/space/<about type>/self` — the deterministic URI of the
	 *  space the pointer resolves to. */
	aboutSpaceUri: string;
	/** Carried across a rewrite so a group that flips private and back does not
	 *  claim it was declared today. */
	createdAt?: string | null;
}

/**
 * The record. `{ aboutSpace, createdAt }` and nothing else.
 *
 * THE FIELD NAME IS PROVISIONAL, like every field name in this iteration: the
 * source describes this record in prose and publishes no lexicon, so `aboutSpace`
 * is our guess with exactly one builder behind it. When a real lexicon lands,
 * this function changes and nothing else does — which is why no route, column or
 * test may spell the field itself.
 *
 * There is deliberately no parser beside it. Nothing in the app reads a group's
 * own declaration — it exists for strangers — and the live probe asserts the raw
 * JSON a stranger actually receives rather than running it back through our
 * shaping code, which would only prove we agree with ourselves.
 */
export function groupDeclarationRecord(input: GroupDeclarationInput): Record<string, unknown> {
	// `$type` is stamped by the writer, which owns the collection name.
	return {
		aboutSpace: input.aboutSpaceUri,
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/**
 * Whether this group publishes a declaration at all.
 *
 * A private group does not; a public group does. With a members-only group
 * narrowing at the protocol layer, the declaration is the only artifact an
 * anonymous peer can read about a group, so withholding it is what "not
 * discoverable" means — and publishing it is the whole of what makes a public
 * group discoverable off our own index.
 *
 * One predicate rather than a visibility check at each call site, because this
 * is the clause most likely to change: whether `private` survives as a
 * group-level value at all is an open decision, and when it is answered this
 * function is the only thing that moves. (Spec: FR-003.)
 */
export function declarationRequired(group: Pick<GroupRow, 'visibility'>): boolean {
	return group.visibility !== 'private';
}
