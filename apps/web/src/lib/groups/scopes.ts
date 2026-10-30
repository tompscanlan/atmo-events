// What a person's own sign-in needs for groups, asked for at their first group action and
// never at sign-in. Values and pure checks only, so the OAuth config can import them.
import {
	CALENDAR_SPACE_TYPE,
	GROUP_ACCEPTANCE_COLLECTION,
	GROUP_RSVP_COLLECTION,
	MEMBERS_SPACE_TYPE,
	META_SPACE_TYPE
} from './ids';

/** The proposal's set for personal sessions: read groups, join, leave, confirm. */
export const PARTICIPATE_SCOPE = 'include:group.opensocial.participate';

/** Lists the group spaces a person has written into, for "your groups". `listSpaces` asks
 *  for any space key, which the set's members grant (key `self`) does not match. */
export const LIST_GROUP_SPACES_SCOPE = `space:${MEMBERS_SPACE_TYPE}?authority=*&action=read_self`;

/** A member's RSVPs in any group's calendar space; with it their PDS also lets them read the
 *  space, so it is what shows them members-only events. */
export const CALENDAR_RSVP_SCOPE = `space:${CALENDAR_SPACE_TYPE}?authority=*&collection=${GROUP_RSVP_COLLECTION}&action=read&action=create&action=update&action=delete`;

export const GROUP_PERSON_SCOPES: readonly string[] = [
	PARTICIPATE_SCOPE,
	LIST_GROUP_SPACES_SCOPE,
	CALENDAR_RSVP_SCOPE
];

// A PDS hands an `include:` back expanded and drops each parameter left at its default:
// no `action` is all four, no `authority` the signer's own repo, never a group's, and no
// `collection` allows reads only, which are collection-independent.
const DEFAULT_ACTIONS: readonly string[] = ['read', 'create', 'update', 'delete'];

/** Grants for any group, or for `groupDid` when given. */
function spaceGrants(scope: string, spaceType: string, groupDid?: string): URLSearchParams[] {
	return scope
		.split(' ')
		.filter((token) => token.startsWith(`space:${spaceType}?`) || token.startsWith('space:*?'))
		.map((token) => new URLSearchParams(token.slice(token.indexOf('?') + 1)))
		.filter((params) => {
			const authority = params.get('authority');
			return authority === '*' || (groupDid !== undefined && authority === groupDid);
		});
}

function actionsOf(params: URLSearchParams): readonly string[] {
	const actions = params.getAll('action');
	return actions.length > 0 ? actions : DEFAULT_ACTIONS;
}

/** Any group's meta space. A stock PDS drops a space grant it does not know, so this also
 *  says the person's PDS supports spaces. */
export function holdsMetaRead(scope: string): boolean {
	return spaceGrants(scope, META_SPACE_TYPE).some((p) => actionsOf(p).includes('read'));
}

export function holdsSpaceList(scope: string): boolean {
	return spaceGrants(scope, MEMBERS_SPACE_TYPE).some((p) => {
		const actions = actionsOf(p);
		const anyKey = (p.get('skey') ?? '*') === '*';
		return anyKey && (actions.includes('read') || actions.includes('read_self'));
	});
}

export function holdsGroupScopes(scope: string): boolean {
	return holdsMetaRead(scope) && holdsSpaceList(scope) && holdsCalendarGrant(scope, 'read');
}

/** The member's RSVPs in a group's calendar space, any group's when `groupDid` is absent. A
 *  read needs only the action, since reads are collection-independent. */
export function holdsCalendarGrant(
	scope: string,
	action: 'read' | 'create' | 'delete',
	groupDid?: string
): boolean {
	return spaceGrants(scope, CALENDAR_SPACE_TYPE, groupDid).some((p) => {
		const collections = p.getAll('collection');
		return (
			actionsOf(p).includes(action) &&
			(action === 'read' ||
				collections.includes('*') ||
				collections.includes(GROUP_RSVP_COLLECTION))
		);
	});
}

/** The set's grant for the member's own acceptance in the group's members space. */
export function holdsAcceptanceGrant(
	scope: string,
	groupDid: string,
	action: 'create' | 'delete'
): boolean {
	return spaceGrants(scope, MEMBERS_SPACE_TYPE, groupDid).some((p) => {
		const collections = p.getAll('collection');
		return (
			actionsOf(p).includes(action) &&
			(collections.includes('*') || collections.includes(GROUP_ACCEPTANCE_COLLECTION))
		);
	});
}
