import { describe, expect, it } from 'vitest';
import { CREATE_GROUP_SCOPE, grantsRepoWrites, groupAbilities, holdsCreateGroup } from './scopes';

const GROUP = 'did:plc:group';
const META_READ = `space:org.atgrp.meta?authority=${GROUP}&action=read`;
const REPO = 'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event';

describe('what a group session may do, by the scope its host granted', () => {
	it("lets an admin's session, which keeps the repo grant, post and list", () => {
		const scope = `atproto ${META_READ} ${REPO} blob?accept=image/*`;
		expect(groupAbilities(scope)).toEqual({ post: true, list: true });
	});

	it("lets a member's session, which keeps only the meta read, do neither", () => {
		expect(groupAbilities(`atproto ${META_READ}`)).toEqual({ post: false, list: false });
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
	it('is the rpc grant for the host’s createGroup, for any audience', () => {
		expect(CREATE_GROUP_SCOPE).toBe('rpc:org.atgrp.internal.createGroup?aud=*');
		expect(holdsCreateGroup(`atproto ${CREATE_GROUP_SCOPE}`)).toBe(true);
		expect(
			holdsCreateGroup('rpc?lxm=org.atgrp.internal.createGroup&aud=did:web:host.example')
		).toBe(true);
	});

	it('is not held without it, or for another method', () => {
		expect(holdsCreateGroup('atproto include:community.lexicon.calendar.authFull')).toBe(false);
		expect(holdsCreateGroup('rpc:org.atgrp.requestJoin?aud=*')).toBe(false);
		expect(holdsCreateGroup('rpc:org.atgrp.internal.createGroup')).toBe(false);
	});
});
