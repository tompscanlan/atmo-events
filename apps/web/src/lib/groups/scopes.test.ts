import { describe, expect, it, vi } from 'vitest';

// Tested with the settings page and making groups here in the build; each check of a build without
// one names it.
vi.mock('./build', async (importOriginal) => ({
	...(await importOriginal<typeof import('./build')>()),
	CREATE_IN_THIS_BUILD: true,
	SETTINGS_IN_THIS_BUILD: true
}));

import {
	CREATE_GROUP_SCOPE,
	GROUP_PERSON_SCOPES,
	groupPersonScopes,
	grantsRepoWrites,
	grantsSettings,
	GROUP_SETTINGS_SCOPES,
	groupAbilities,
	holdsConfirmationGrant,
	holdsEveryAbility,
	holdsCreateGroup,
	holdsMetaRead,
	holdsParticipate,
	grantsRoster,
	holdsRpc,
	MEMBERS_ONLY_SCOPES,
	JOIN_SCOPES,
	PARTICIPATE_SCOPES,
	ROSTER_SCOPES,
	YOUR_GROUPS_SCOPE
} from './scopes';
import { GUEST_SCOPE } from '#lib/private-events/scopes.js';

const GROUP = 'did:plc:group';
const META_READ = `space:org.atgrp.meta?authority=${GROUP}&skey=self&action=read`;
const REPO = 'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event';
/** The settings scopes as the host gives them back: `authority=self` made the group's DID. */
const SETTINGS = GROUP_SETTINGS_SCOPES.map((s) =>
	s.replace('authority=self', `authority=${GROUP}`)
);
/** The members page's scopes, as the host gives them back. */
const ROSTER = ROSTER_SCOPES.map((s) => s.replace('authority=self', `authority=${GROUP}`));
/** Members-only events' scopes, as the host gives them back once the calendar space is there. */
const MEMBERS_ONLY = MEMBERS_ONLY_SCOPES.map((s) =>
	s.replace('authority=self', `authority=${GROUP}`)
);

describe('what a group session may do, by the scope its host granted', () => {
	it("lets an admin's session, which keeps every grant asked, post, list, change settings and manage members", () => {
		const scope = [
			'atproto',
			META_READ,
			REPO,
			'blob?accept=image/*',
			...SETTINGS,
			...ROSTER,
			...MEMBERS_ONLY
		].join(' ');
		// With the members page in the build.
		expect(groupAbilities(scope, GROUP, true)).toEqual({
			post: true,
			list: true,
			settings: true,
			admit: true,
			assign: true,
			remove: true,
			turnOnMembersOnly: true,
			membersOnly: true
		});
	});

	it('gives no member controls, whatever the scope grants, in a build without the members page', () => {
		const scope = ['atproto', META_READ, REPO, ...SETTINGS, ...ROSTER, ...MEMBERS_ONLY].join(' ');
		expect(groupAbilities(scope, GROUP, false)).toEqual({
			post: true,
			list: true,
			settings: true,
			admit: false,
			assign: false,
			remove: false,
			turnOnMembersOnly: true,
			membersOnly: true
		});
	});

	it("counts a link as holding everything by what the build offers, the members page's acts only with it", () => {
		const all = ['atproto', META_READ, REPO, ...SETTINGS, ...ROSTER, ...MEMBERS_ONLY].join(' ');
		const allButRoster = ['atproto', META_READ, REPO, ...SETTINGS, ...MEMBERS_ONLY].join(' ');
		expect(holdsEveryAbility(groupAbilities(all, GROUP, true), true)).toBe(true);
		expect(holdsEveryAbility(groupAbilities(allButRoster, GROUP, true), true)).toBe(false);
		expect(holdsEveryAbility(groupAbilities(allButRoster, GROUP, false), false)).toBe(true);
		// Whatever else it may do, a link that cannot post is short of something either way.
		const noPosting = ['atproto', META_READ, ...SETTINGS, ...ROSTER, ...MEMBERS_ONLY].join(' ');
		expect(holdsEveryAbility(groupAbilities(noPosting, GROUP, false), false)).toBe(false);
	});

	it("lets a member's session, which keeps only reads, do none of it", () => {
		// The host keeps of the calendar grant only what the space's policy gives a member: a read.
		const eventsRead = `space:community.lexicon.calendar.collection?authority=${GROUP}&skey=self&collection=community.lexicon.calendar.event&action=read`;
		expect(groupAbilities(`atproto ${META_READ} ${eventsRead}`, GROUP)).toEqual({
			post: false,
			list: false,
			settings: false,
			admit: false,
			assign: false,
			remove: false,
			turnOnMembersOnly: false,
			membersOnly: false
		});
	});

	it('offers no settings to a link approved before they were asked for, nor to one that cannot list the group', () => {
		// Making a group public or private moves its listing too.
		expect(groupAbilities(['atproto', META_READ, ...SETTINGS].join(' '), GROUP).settings).toBe(
			false
		);
		const scope = `atproto ${META_READ} ${REPO} blob?accept=image/*`;
		expect(groupAbilities(scope, GROUP)).toEqual({
			post: true,
			list: true,
			settings: false,
			admit: false,
			assign: false,
			remove: false,
			turnOnMembersOnly: false,
			membersOnly: false
		});
	});

	it('offers no settings, whatever the scope grants, in a build without the settings page', () => {
		const scope = ['atproto', META_READ, REPO, ...SETTINGS, ...ROSTER, ...MEMBERS_ONLY].join(' ');
		expect(groupAbilities(scope, GROUP, true, false)).toEqual({
			post: true,
			list: true,
			settings: false,
			admit: true,
			assign: true,
			remove: true,
			turnOnMembersOnly: true,
			membersOnly: true
		});
		expect(groupAbilities(scope, GROUP, false, false)).toMatchObject({
			list: true,
			settings: false,
			admit: false
		});
	});

	it('counts the settings toward holding everything only in a build with the settings page', () => {
		const allButSettings = ['atproto', META_READ, REPO, ...ROSTER, ...MEMBERS_ONLY].join(' ');
		expect(holdsEveryAbility(groupAbilities(allButSettings, GROUP, true, true), true, true)).toBe(
			false
		);
		expect(holdsEveryAbility(groupAbilities(allButSettings, GROUP, true, false), true, false)).toBe(
			true
		);
		// Neither the roster's nor the settings': all that is left is posting, listing and members-only.
		const neither = ['atproto', META_READ, REPO, ...MEMBERS_ONLY].join(' ');
		expect(holdsEveryAbility(groupAbilities(neither, GROUP, false, false), false, false)).toBe(
			true
		);
		const noListing = ['atproto', META_READ, ...MEMBERS_ONLY].join(' ');
		expect(holdsEveryAbility(groupAbilities(noListing, GROUP, false, false), false, false)).toBe(
			false
		);
	});

	it('lists a group by its repo grant for the declaration alone, with no settings scope', () => {
		const scope = ['atproto', META_READ, REPO].join(' ');
		expect(groupAbilities(scope, GROUP, false, false)).toMatchObject({
			list: true,
			settings: false
		});
		expect(grantsRepoWrites(scope, 'org.atgrp.declaration')).toBe(true);
	});

	it('offers no member controls to a link approved before they were asked for', () => {
		const scope = ['atproto', META_READ, REPO, 'blob?accept=image/*', ...SETTINGS].join(' ');
		expect(groupAbilities(scope, GROUP)).toEqual({
			post: true,
			list: true,
			settings: true,
			admit: false,
			assign: false,
			remove: false,
			turnOnMembersOnly: false,
			membersOnly: false
		});
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

describe('the settings a group session may change', () => {
	it('needs the about and config writes and the meta policy, for this group', () => {
		expect(grantsSettings(SETTINGS.join(' '), GROUP)).toBe(true);
		for (const left of SETTINGS) {
			const rest = SETTINGS.filter((s) => s !== left).join(' ');
			expect(grantsSettings(rest, GROUP)).toBe(false);
		}
		expect(grantsSettings(SETTINGS.join(' '), 'did:plc:other')).toBe(false);
	});

	it('takes the same writes from a wider grant, as a permission set expands to', () => {
		const wide = [
			`space:org.atgrp.meta?authority=${GROUP}&skey=self&collection=org.atgrp.about&collection=org.atgrp.config&collection=com.atproto.label.record&action=read&action=create&action=update&action=delete`,
			`space:org.atgrp.meta?authority=${GROUP}&skey=self&action=read&manage=update`
		].join(' ');
		expect(grantsSettings(wide, GROUP)).toBe(true);
	});

	it('asks for nothing wider than the settings write', () => {
		for (const scope of GROUP_SETTINGS_SCOPES) {
			expect(scope).toMatch(/^space:org\.atgrp\.meta\?authority=self&skey=self&/);
			expect(scope).not.toContain('delete');
			// The host makes the about record and config with the group; a put of either is an update.
			expect(scope).not.toContain('action=create');
		}
	});

	it('still takes a link approved when the settings asked for create too', () => {
		const older = SETTINGS.map((s) => s.replace('action=update', 'action=create&action=update'));
		expect(grantsSettings(older.join(' '), GROUP)).toBe(true);
		const createOnly = SETTINGS.map((s) => s.replace('action=update', 'action=create'));
		expect(grantsSettings(createOnly.join(' '), GROUP)).toBe(false);
	});
});

describe('the member controls a group session may offer', () => {
	const [CREATE, UPDATE, DELETE, LIST, DENY] = ROSTER;

	it('admits with a membership create and both join-request methods', () => {
		expect(grantsRoster(`${CREATE} ${LIST} ${DENY}`, GROUP)).toEqual({
			admit: true,
			assign: false,
			remove: false
		});
		expect(grantsRoster(`${CREATE} ${LIST}`, GROUP).admit).toBe(false);
		expect(grantsRoster(`${LIST} ${DENY}`, GROUP).admit).toBe(false);
	});

	it('changes roles with an update, and removes with a delete, each kept or dropped alone', () => {
		expect(grantsRoster(UPDATE, GROUP)).toEqual({ admit: false, assign: true, remove: false });
		expect(grantsRoster(DELETE, GROUP)).toEqual({ admit: false, assign: false, remove: true });
	});

	it("counts only this group's memberships", () => {
		const all = ROSTER.join(' ');
		expect(grantsRoster(all, 'did:plc:other')).toEqual({
			admit: false,
			assign: false,
			remove: false
		});
		expect(grantsRoster(all.replaceAll('org.atgrp.membership', 'org.atgrp.role'), GROUP)).toEqual({
			admit: false,
			assign: false,
			remove: false
		});
	});

	it("takes the same from the spec's set, as the host expands it", () => {
		const expanded = [
			`space:org.atgrp.members?authority=${GROUP}&skey=self&collection=org.atgrp.membership&action=read&action=create&action=update&action=delete`,
			'rpc:org.atgrp.listJoinRequests?aud=*',
			'rpc:org.atgrp.denyJoinRequest?aud=*'
		].join(' ');
		expect(grantsRoster(expanded, GROUP)).toEqual({ admit: true, assign: true, remove: true });
	});

	it('asks for nothing of invites or roles, nor any space but the members space', () => {
		for (const scope of ROSTER_SCOPES.filter((s) => s.startsWith('space:'))) {
			expect(scope).toMatch(
				/^space:org\.atgrp\.members\?authority=self&skey=self&collection=org\.atgrp\.membership&action=read&action=(create|update|delete)$/
			);
		}
		expect(ROSTER_SCOPES.join(' ')).not.toContain('include:');
		expect(ROSTER_SCOPES.join(' ')).not.toContain('invite');
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
