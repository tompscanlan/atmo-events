import { describe, expect, it } from 'vitest';
import {
	CREATE_GROUP_SCOPE,
	grantsRepoWrites,
	grantsSettings,
	GROUP_SETTINGS_SCOPES,
	groupAbilities,
	holdsCreateGroup
} from './scopes';

const GROUP = 'did:plc:group';
const META_READ = `space:org.atgrp.meta?authority=${GROUP}&action=read`;
const REPO = 'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event';
/** The settings scopes as the host gives them back: `authority=self` made the group's DID. */
const SETTINGS = GROUP_SETTINGS_SCOPES.map((s) =>
	s.replace('authority=self', `authority=${GROUP}`)
);

describe('what a group session may do, by the scope its host granted', () => {
	it("lets an admin's session, which keeps every grant asked, post, list and change settings", () => {
		const scope = ['atproto', META_READ, REPO, 'blob?accept=image/*', ...SETTINGS].join(' ');
		expect(groupAbilities(scope, GROUP)).toEqual({ post: true, list: true, settings: true });
	});

	it("lets a member's session, which keeps only the meta read, do none of it", () => {
		expect(groupAbilities(`atproto ${META_READ}`, GROUP)).toEqual({
			post: false,
			list: false,
			settings: false
		});
	});

	it('offers no settings to a link approved before they were asked for', () => {
		const scope = `atproto ${META_READ} ${REPO} blob?accept=image/*`;
		expect(groupAbilities(scope, GROUP)).toEqual({ post: true, list: true, settings: false });
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
		}
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
