import { describe, expect, it, vi } from 'vitest';

// Tested with making groups here in the build; each check of a build without it names it.
vi.mock('./build', async (importOriginal) => ({
	...(await importOriginal<typeof import('./build')>()),
	CREATE_IN_THIS_BUILD: true
}));

import {
	CREATE_GROUP_SCOPE,
	GROUP_PERSON_SCOPES,
	groupPersonScopes,
	grantsRepoWrites,
	groupAbilities,
	holdsConfirmationGrant,
	holdsEveryAbility,
	holdsCreateGroup,
	holdsMetaRead,
	holdsParticipate,
	holdsRpc,
	MEMBERS_ONLY_SCOPES,
	JOIN_SCOPES,
	PARTICIPATE_SCOPES,
	YOUR_GROUPS_SCOPE
} from './scopes';
import { GUEST_SCOPE } from '#lib/private-events/scopes.js';

const GROUP = 'did:plc:group';
const META_READ = `space:org.atgrp.meta?authority=${GROUP}&skey=self&action=read`;
const REPO = 'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event';
/** Members-only events' scopes, as the host gives them back once the calendar space is there. */
const MEMBERS_ONLY = MEMBERS_ONLY_SCOPES.map((s) =>
	s.replace('authority=self', `authority=${GROUP}`)
);

describe('what a group session may do, by the scope its host granted', () => {
	it("lets an admin's session, which keeps every grant asked, post and list", () => {
		const scope = ['atproto', META_READ, REPO, 'blob?accept=image/*', ...MEMBERS_ONLY].join(' ');
		expect(groupAbilities(scope, GROUP)).toEqual({
			post: true,
			list: true,
			turnOnMembersOnly: true,
			membersOnly: true,
			readSpaceIndex: true
		});
	});

	it("lets a member's session, which keeps only reads, do none of it", () => {
		// The host keeps of the calendar grant only what the space's policy gives a member: a read.
		const eventsRead = `space:community.lexicon.calendar.collection?authority=${GROUP}&skey=self&collection=community.lexicon.calendar.event&action=read`;
		expect(groupAbilities(`atproto ${META_READ} ${eventsRead}`, GROUP)).toEqual({
			post: false,
			list: false,
			turnOnMembersOnly: false,
			membersOnly: false,
			readSpaceIndex: false
		});
	});

	it("recognises the calendar's grants when the host names them to the calendar's own key", () => {
		const keyed = MEMBERS_ONLY.map((token) =>
			token.startsWith('space:community.lexicon.calendar.collection?')
				? token.replace('authority=', 'skey=3lwikicalendar&authority=')
				: token
		);
		expect(keyed.join(' ')).toContain('skey=3lwikicalendar');
		expect(groupAbilities(['atproto', META_READ, ...keyed].join(' '), GROUP)).toMatchObject({
			turnOnMembersOnly: true,
			membersOnly: true
		});
		// Another group's calendar, at any key, is still none of this group's.
		const theirs = keyed.map((token) =>
			token.replace(`authority=${GROUP}`, 'authority=did:plc:other')
		);
		expect(groupAbilities(['atproto', ...theirs].join(' '), GROUP)).toMatchObject({
			turnOnMembersOnly: false,
			membersOnly: false
		});
	});

	it('counts a link as holding everything only with every ability', () => {
		const all = ['atproto', META_READ, REPO, ...MEMBERS_ONLY].join(' ');
		expect(holdsEveryAbility(groupAbilities(all, GROUP))).toBe(true);
		const noListing = ['atproto', META_READ, ...MEMBERS_ONLY].join(' ');
		expect(holdsEveryAbility(groupAbilities(noListing, GROUP))).toBe(false);
	});

	it('lists a group by its repo grant for the declaration alone', () => {
		const scope = ['atproto', META_READ, REPO].join(' ');
		expect(groupAbilities(scope, GROUP)).toMatchObject({ list: true });
		expect(grantsRepoWrites(scope, 'org.atgrp.declaration')).toBe(true);
	});

	it('reads each form a repo grant takes', () => {
		const event = 'community.lexicon.calendar.event';
		expect(grantsRepoWrites(`repo:${event}`, event)).toBe(true);
		expect(grantsRepoWrites('repo:*', event)).toBe(true);
		expect(grantsRepoWrites(`repo?collection=${event}`, event)).toBe(true);
		expect(grantsRepoWrites(`repo:${encodeURIComponent(event)}`, event)).toBe(true);
		expect(grantsRepoWrites(`repo:org.atgrp.declaration`, event)).toBe(false);
	});

	it('needs every write a post or a listing makes: create, update and delete', () => {
		const event = 'community.lexicon.calendar.event';
		expect(grantsRepoWrites(`repo:${event}?action=create&action=update`, event)).toBe(false);
		expect(
			grantsRepoWrites(
				`repo:${event}?action=create&action=update repo:${event}?action=delete`,
				event
			)
		).toBe(true);
	});

	it('counts no other kind of grant', () => {
		const event = 'community.lexicon.calendar.event';
		expect(
			grantsRepoWrites(`atproto space:x.y?collection=${event} rpc:${event}?aud=*`, event)
		).toBe(false);
		expect(grantsRepoWrites('', event)).toBe(false);
	});
});

describe("the person's own permission to make a group", () => {
	const HOST = 'did:web:host.example';

	it('is the rpc grant for the host’s createGroup, for any audience or the host', () => {
		expect(CREATE_GROUP_SCOPE).toBe('rpc:org.atgrp.internal.createGroup?aud=*');
		expect(holdsCreateGroup(`atproto ${CREATE_GROUP_SCOPE}`, HOST)).toBe(true);
		expect(
			holdsCreateGroup('rpc?lxm=org.atgrp.internal.createGroup&aud=did:web:host.example', HOST)
		).toBe(true);
	});

	it('is not held without it, for another method, or for another audience', () => {
		expect(holdsCreateGroup('atproto include:community.lexicon.calendar.authFull', HOST)).toBe(
			false
		);
		expect(holdsCreateGroup('rpc:org.atgrp.requestJoin?aud=*', HOST)).toBe(false);
		expect(holdsCreateGroup('rpc:org.atgrp.internal.createGroup', HOST)).toBe(false);
		expect(
			holdsCreateGroup('rpc?lxm=org.atgrp.internal.createGroup&aud=did:web:other.example', HOST)
		).toBe(false);
	});
});

describe("a person's group permissions, as asked", () => {
	it('are exactly what the code calls, for any group host', () => {
		expect(PARTICIPATE_SCOPES).toEqual([
			'space:org.atgrp.meta?authority=*&skey=self&action=read',
			'space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation&action=read&action=create&action=delete',
			'rpc?lxm=org.atgrp.requestJoin&lxm=org.atgrp.cancelJoinRequest&lxm=org.atgrp.leaveGroup&aud=*',
			'rpc:org.atgrp.internal.getActorGroups?aud=*'
		]);
		expect(JOIN_SCOPES).toEqual([...PARTICIPATE_SCOPES, GUEST_SCOPE]);
		const all = [CREATE_GROUP_SCOPE, ...JOIN_SCOPES].join(' ');
		expect(all).not.toContain('include:');
		expect(all).not.toContain('inbox');
		expect(all).not.toContain('org.atgrp.mod.');
		expect(PARTICIPATE_SCOPES.join(' ')).not.toContain('action=update');
	});

	it('are held as asked', () => {
		const all = ['atproto', ...JOIN_SCOPES].join(' ');
		expect(holdsParticipate(all)).toBe(true);
		// Each method of the membership grant too, not only the grant as a whole.
		for (const method of ['requestJoin', 'cancelJoinRequest', 'leaveGroup']) {
			expect(holdsParticipate(all.replace(`lxm=org.atgrp.${method}&`, '')), method).toBe(false);
		}
		for (const left of PARTICIPATE_SCOPES) {
			const rest = PARTICIPATE_SCOPES.filter((scope) => scope !== left);
			expect(holdsParticipate(['atproto', ...rest].join(' ')), left).toBe(false);
		}
	});
});

// The spec's org.atgrp.authParticipate as a PDS hands it back expanded, each parameter left at its
// default dropped (all four actions, here), with "your groups" as asked.
const PARTICIPATE_EXPANDED = [
	'atproto',
	'space:org.atgrp.meta?authority=*&skey=self&action=read',
	'space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation',
	'space:org.atgrp.inbox?skey=self&action=read&manage=create',
	'rpc?lxm=org.atgrp.requestJoin&lxm=org.atgrp.cancelJoinRequest&lxm=org.atgrp.leaveGroup&lxm=org.atgrp.mod.submitReport&lxm=org.atgrp.mod.submitAppeal&lxm=org.atgrp.mod.querySelfHistory&aud=*',
	YOUR_GROUPS_SCOPE
].join(' ');

describe("a person's group permissions, as their PDS granted them", () => {
	it('reads the expanded participate set and "your groups" as all a group page needs', () => {
		expect(holdsParticipate(PARTICIPATE_EXPANDED)).toBe(true);
		expect(holdsParticipate(PARTICIPATE_EXPANDED.replace(YOUR_GROUPS_SCOPE, ''))).toBe(false);
		expect(holdsParticipate('atproto include:community.lexicon.calendar.authFull')).toBe(false);
	});

	it('reads a PDS that dropped the space grants, having no spaces, as not enough', () => {
		const noSpaces = PARTICIPATE_EXPANDED.split(' ')
			.filter((token) => !token.startsWith('space:'))
			.join(' ');
		expect(holdsRpc(noSpaces, 'org.atgrp.requestJoin')).toBe(true);
		expect(holdsMetaRead(noSpaces)).toBe(false);
		expect(holdsParticipate(noSpaces)).toBe(false);
	});

	it("needs a meta read for any group, not the signer's own", () => {
		expect(holdsMetaRead('space:org.atgrp.meta?action=read')).toBe(false);
		expect(holdsMetaRead('space:org.atgrp.meta?authority=*&action=read')).toBe(true);
		expect(holdsMetaRead('space:org.atgrp.meta?authority=*&skey=other&action=read')).toBe(false);
		expect(holdsMetaRead('space:org.atgrp.meta?authority=*&action=create')).toBe(false);
	});

	it("needs a grant naming the confirmation for the person's own, for any group or this one", () => {
		const anyGroup = 'space:org.atgrp.members?authority=*&collection=org.atgrp.confirmation';
		expect(holdsConfirmationGrant(anyGroup, 'create')).toBe(true);
		expect(holdsConfirmationGrant(anyGroup, 'delete', GROUP)).toBe(true);
		const oneGroup = anyGroup.replace('authority=*', `authority=${GROUP}`);
		expect(holdsConfirmationGrant(oneGroup, 'create', GROUP)).toBe(true);
		expect(holdsConfirmationGrant(oneGroup, 'create')).toBe(false);
		expect(holdsConfirmationGrant(oneGroup, 'create', 'did:plc:other')).toBe(false);
		const readOnly = 'space:org.atgrp.members?authority=*&action=read';
		expect(holdsConfirmationGrant(readOnly, 'create')).toBe(false);
		const membership = anyGroup.replace('org.atgrp.confirmation', 'org.atgrp.membership');
		expect(holdsConfirmationGrant(membership, 'create')).toBe(false);
	});

	it('reads an rpc grant in either form, for any audience, for that method alone', () => {
		expect(holdsRpc(YOUR_GROUPS_SCOPE, 'org.atgrp.internal.getActorGroups')).toBe(true);
		expect(holdsRpc('rpc?lxm=org.atgrp.leaveGroup&aud=*', 'org.atgrp.leaveGroup')).toBe(true);
		expect(holdsRpc('rpc?lxm=org.atgrp.leaveGroup', 'org.atgrp.leaveGroup')).toBe(false);
		expect(holdsRpc(YOUR_GROUPS_SCOPE, 'org.atgrp.requestJoin')).toBe(false);
	});
});

describe("the person's permissions for groups", () => {
	it('include making a group only in a build that makes groups here', () => {
		expect(GROUP_PERSON_SCOPES).toEqual(groupPersonScopes(true));
		expect(groupPersonScopes(true)).toEqual([
			CREATE_GROUP_SCOPE,
			...PARTICIPATE_SCOPES,
			GUEST_SCOPE
		]);
		expect(groupPersonScopes(false)).toEqual([...PARTICIPATE_SCOPES, GUEST_SCOPE]);
	});
});
