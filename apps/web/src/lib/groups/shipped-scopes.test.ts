// What this build asks for, as it ships, so a scope that grows changes what is asked of every group
// host, and this test with it.
import { describe, expect, it } from 'vitest';
import { GROUP_SESSION_SCOPE } from './server/sign-in';

describe('the permissions this build asks for', () => {
	it('asks a group host for exactly this, signed in as a group', () => {
		expect(GROUP_SESSION_SCOPE).toBe(
			[
				'atproto',
				'space:org.atgrp.meta?authority=self&skey=self&action=read',
				'repo?collection=community.lexicon.calendar.event',
				'blob?accept=image/*',
				'space:community.lexicon.calendar.collection?authority=self&manage=create',
				'space:community.lexicon.calendar.collection?authority=self&collection=community.lexicon.calendar.event&action=read&action=create&action=update&action=delete',
				'space:org.atgrp.members?authority=self&skey=self&collection=org.atgrp.space&action=read'
			].join(' ')
		);
	});
});
