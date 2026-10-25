import { describe, it, expect } from 'vitest';
import {
	groupFace,
	groupProfileRecord,
	groupRuleRecord,
	parseGroupProfile,
	parseGroupRule,
	splitRuleLines
} from './about-record';

const BANNER = {
	$type: 'blob',
	ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
	mimeType: 'image/png',
	size: 70
};

describe('parseGroupProfile', () => {
	it('reads an unknown or missing joinPolicy as invite, never open', () => {
		expect(parseGroupProfile({ displayName: 'Kona', joinPolicy: 'everyone' })?.joinPolicy).toBe(
			'invite'
		);
		expect(parseGroupProfile({ displayName: 'Kona' })?.joinPolicy).toBe('invite');
	});

	it('keeps the record as read', () => {
		const value = { displayName: 'Kona', joinPolicy: 'open', url: 'https://kona.example' };
		expect(parseGroupProfile(value)?.record).toBe(value);
	});

	it.each([{ displayName: '   ' }, { description: 'no name' }, null, 'Kona'])(
		'rejects %j, which has no usable displayName',
		(value) => expect(parseGroupProfile(value)).toBeNull()
	);
});

describe('groupProfileRecord', () => {
	it("keeps the base record's other fields and drops its $type", () => {
		const base = {
			$type: 'group.opensocial.profile',
			displayName: 'Old',
			description: 'Old text',
			avatar: BANNER,
			banner: BANNER,
			url: 'https://kona.example'
		};
		expect(groupProfileRecord({ name: 'Kona', joinPolicy: 'approval', base })).toEqual({
			displayName: 'Kona',
			joinPolicy: 'approval',
			avatar: BANNER,
			banner: BANNER,
			url: 'https://kona.example'
		});
	});
});

describe('groupFace', () => {
	const row = { name: 'STALE ROW', description: 'STALE DESCRIPTION' };

	it("renders a record's null description as null, not the row's", () => {
		const profile = parseGroupProfile({ displayName: 'Kona', joinPolicy: 'open' });
		expect(groupFace(profile, row)).toEqual({
			name: 'Kona',
			description: null,
			joinPolicy: 'open'
		});
	});

	it('falls back to the row with no join policy when there is no record', () => {
		expect(groupFace(null, row)).toEqual({ ...row, joinPolicy: null });
	});
});

describe('rules', () => {
	it('splits one trimmed rule per non-empty line', () => {
		expect(splitRuleLines(' Be kind \n\n  No spam\n')).toEqual(['Be kind', 'No spam']);
		expect(splitRuleLines(undefined)).toEqual([]);
	});

	it('titles a rule by graphemes, so an emoji is never split', () => {
		const thumbsUp = '\u{1F44D}\u{1F3FD}';
		expect(groupRuleRecord({ text: thumbsUp.repeat(70), order: 0 }).title).toBe(
			thumbsUp.repeat(64)
		);
	});

	it('stops the title before it would pass 640 bytes', () => {
		const heavy = `e${'́'.repeat(10)}`;
		const title = groupRuleRecord({ text: heavy.repeat(64), order: 0 }).title as string;
		expect(title).toBe(heavy.repeat(Math.floor(640 / new TextEncoder().encode(heavy).length)));
	});

	it('reads a rule with no text as none, and a bad order as 0', () => {
		expect(parseGroupRule({ text: '  ' })).toBeNull();
		expect(parseGroupRule({ text: 'Be kind', order: 'first' })).toEqual({
			text: 'Be kind',
			order: 0
		});
	});
});
