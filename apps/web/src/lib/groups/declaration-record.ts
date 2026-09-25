// The one record a group publishes to the anonymous web.
//
// Every other record a group owns lives in a space, and a space refuses an
// anonymous reader even under a public policy: the reference PDS answers
// `AuthMissing` to an unauthenticated `describeSpace` on a public-read space.
// This record sits in the group's public repo instead, where anyone can read it
// and it is carried on the firehose for free. So a peer app that has never
// heard of us can see that a DID is a group, and follow a pointer to where the
// rest lives.
//
// It is a pointer and nothing else: no name, no avatar, no member count. A peer
// that wants the group's name asks the about space and is refused. That is by
// design, so no UI may promise that an anonymous reader can see a group's name.
//
// NOT WRITTEN FOR A PRIVATE GROUP. This record is the only cross-app artifact
// that tells a group anyone may discover from one nobody may, so its presence
// or absence is that switch. It does not hide the group completely: the
// group's DID and handle are both published to the PLC audit log at genesis, so
// a private group's existence and address stay findable by anyone who reads
// that log.
//
// Pure, like ./about-record.ts and ./event-record.ts: shape only, no D1 and no
// PDS, so the builder and the predicate can be tested without a request.
// Permission, authorship and transport live in ./server/declaration-writer.ts.
import type { GroupRow } from './types';

/** The collection, and only here, so a prefix change is one edit. Ours rather
 *  than the draft's `community.opensocial.declaration` for the same reason as
 *  every other group record: that prefix resolves to a domain someone else
 *  holds. The leaf matches, so a settled standard is a rename plus a replay. */
export const GROUP_DECLARATION_COLLECTION = 'net.openmeet.group.declaration';

/** A singleton, keyed like every other atproto singleton: a DID is one group,
 *  so a second declaration under the same repo would be a contradiction rather
 *  than a second group. */
export const GROUP_DECLARATION_RKEY = 'self';

export interface GroupDeclarationInput {
	/** `at://<group did>/space/<about type>/self`: the deterministic URI of the
	 *  space the pointer resolves to. */
	aboutSpaceUri: string;
	/** Carried across a rewrite so a group that flips private and back does not
	 *  claim it was declared today. */
	createdAt?: string | null;
}

/**
 * The record: `{ aboutSpace, createdAt }` and nothing else.
 *
 * The field name is provisional. The draft describes this record in prose and
 * publishes no lexicon, so `aboutSpace` is our choice until a real lexicon
 * exists, and this builder is the one place that writes it.
 *
 * There is no parser beside it on purpose. The app never reads a declaration's
 * pointer back (the record exists for strangers), and
 * scripts/group-declaration.mjs checks the raw JSON a stranger receives rather
 * than running it back through our own shaping code, which would only prove we
 * agree with ourselves.
 */
export function groupDeclarationRecord(input: GroupDeclarationInput): Record<string, unknown> {
	// `$type` is stamped by the writer, which owns the collection name.
	return {
		aboutSpace: input.aboutSpaceUri,
		createdAt: input.createdAt || new Date().toISOString()
	};
}

/**
 * Whether this group publishes a declaration at all: a public group does, a
 * private group does not.
 *
 * The declaration is the only thing an anonymous peer can read about a group,
 * so withholding it is what "not discoverable" means, and publishing it is what
 * makes a public group discoverable outside our own index.
 *
 * One predicate rather than a visibility check at each call site, so that when
 * this rule changes, this function is the only thing that moves.
 */
export function declarationRequired(group: Pick<GroupRow, 'visibility'>): boolean {
	return group.visibility !== 'private';
}
