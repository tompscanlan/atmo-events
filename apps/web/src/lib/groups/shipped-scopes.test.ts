// What this build asks for, as it ships: with its own switches (./build.ts), none of them mocked,
// so a switch turned on, or a scope that grows, changes what is asked of every group host and every
// person, and this test with it.
import { describe, expect, it } from 'vitest';
import { CREATE_IN_THIS_BUILD, ROSTER_IN_THIS_BUILD, SETTINGS_IN_THIS_BUILD } from './build';
import { GROUP_PERSON_SCOPES } from './scopes';
import { GROUP_SESSION_SCOPE } from './server/sign-in';

describe('the permissions this build asks for', () => {
	it('leaves the members page, making groups and the settings out', () => {
		expect({
			roster: ROSTER_IN_THIS_BUILD,
			create: CREATE_IN_THIS_BUILD,
			settings: SETTINGS_IN_THIS_BUILD
		}).toEqual({ roster: false, create: false, settings: false });
	});

	it('asks a group host for exactly this, signed in as a group', () => {
		expect(GROUP_SESSION_SCOPE).toBe(
			[
				'atproto',
				'space:org.atgrp.meta?authority=self&skey=self&action=read',
				'repo?collection=org.atgrp.declaration&collection=community.lexicon.calendar.event',
				'blob?accept=image/*',
				'space:community.lexicon.calendar.collection?authority=self&manage=create',
				'space:community.lexicon.calendar.collection?authority=self&collection=community.lexicon.calendar.event&action=read&action=create&action=update&action=delete',
				'space:org.atgrp.members?authority=self&skey=self&collection=org.atgrp.space&action=read'
			].join(' ')
		);
	});

	it("adds exactly this to a person's sign-in while groups are on", () => {
		expect(GROUP_PERSON_SCOPES).toEqual([
			'space:org.atgrp.meta?authority=*&skey=self&action=read',
			'space:org.atgrp.members?authority=*&skey=self&collection=org.atgrp.confirmation&action=read&action=create&action=delete',
			'rpc?lxm=org.atgrp.requestJoin&lxm=org.atgrp.cancelJoinRequest&lxm=org.atgrp.leaveGroup&aud=*',
			'rpc:org.atgrp.internal.getActorGroups?aud=*',
			'space:community.lexicon.calendar.collection?authority=*&collection=community.lexicon.calendar.rsvp&action=read&action=create&action=update&action=delete'
		]);
	});
});
