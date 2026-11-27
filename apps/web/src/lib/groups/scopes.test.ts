import { describe, expect, it } from 'vitest';
import { grantsRepoWrites, groupAbilities } from './scopes';

const GROUP = 'did:plc:group';
const META_READ = `space:org.atgrp.meta?authority=${GROUP}&skey=self&action=read`;
const REPO = 'repo?collection=community.lexicon.calendar.event';

describe('what a group session may do, by the scope its host granted', () => {
	it("lets an admin's session, which keeps every grant asked, post", () => {
		const scope = ['atproto', META_READ, REPO, 'blob?accept=image/*'].join(' ');
		expect(groupAbilities(scope)).toEqual({
			post: true
		});
	});

	it("lets a member's session, which keeps only reads, do none of it", () => {
		expect(groupAbilities(`atproto ${META_READ}`)).toEqual({
			post: false
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

	it('needs every write a post makes: create, update and delete', () => {
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
