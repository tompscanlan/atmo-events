import { describe, expect, it } from 'vitest';
import {
	grantsRepoWrites,
	groupAbilities,
	holdsConfirmationGrant,
	holdsEveryAbility,
	holdsMetaRead,
	holdsParticipate,
	holdsRpc,
	PARTICIPATE_SCOPES,
	YOUR_GROUPS_SCOPE
} from './scopes';

const GROUP = 'did:plc:group';
const META_READ = `space:org.atgrp.meta?authority=${GROUP}&skey=self&action=read`;
const REPO = 'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event';

describe('what a group session may do, by the scope its host granted', () => {
	it("lets an admin's session, which keeps every grant asked, post and list", () => {
		const scope = ['atproto', META_READ, REPO, 'blob?accept=image/*'].join(' ');
		expect(groupAbilities(scope)).toEqual({
			post: true,
			list: true
		});
	});

	it("lets a member's session, which keeps only reads, do none of it", () => {
		expect(groupAbilities(`atproto ${META_READ}`)).toEqual({
			post: false,
			list: false
		});
	});

	it('counts a link as holding everything only with every ability', () => {
		const all = ['atproto', META_READ, REPO].join(' ');
		expect(holdsEveryAbility(groupAbilities(all))).toBe(true);
		const noListing = ['atproto', META_READ].join(' ');
		expect(holdsEveryAbility(groupAbilities(noListing))).toBe(false);
	});

	it('lists a group by its repo grant for the declaration alone', () => {
		const scope = ['atproto', META_READ, REPO].join(' ');
		expect(groupAbilities(scope)).toMatchObject({ list: true });
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

describe("a person's group permissions, as asked", () => {
	it('are exactly what the code calls, for any group host', () => {
		expect(PARTICIPATE_SCOPES).toEqual([
			'space:org.atgrp.meta?authority=*&skey=self&action=read',
			'space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation&action=read&action=create&action=delete',
			'rpc?lxm=org.atgrp.requestJoin&lxm=org.atgrp.cancelJoinRequest&lxm=org.atgrp.leaveGroup&aud=*',
			'rpc:org.atgrp.internal.getActorGroups?aud=*'
		]);
		const all = PARTICIPATE_SCOPES.join(' ');
		expect(all).not.toContain('include:');
		expect(all).not.toContain('inbox');
		expect(all).not.toContain('org.atgrp.mod.');
		expect(PARTICIPATE_SCOPES.join(' ')).not.toContain('action=update');
	});

	it('are held as asked', () => {
		const all = ['atproto', ...PARTICIPATE_SCOPES].join(' ');
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
