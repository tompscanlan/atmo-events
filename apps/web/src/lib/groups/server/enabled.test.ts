import { afterEach, describe, expect, it, vi } from 'vitest';
import { env } from 'cloudflare:workers';
import { parseGroupHostUrl } from '../host-url';
import { groupHostUrl, groupsEnabled } from './enabled';
import { atGroupHost, groupHostOrigin } from './group';

afterEach(() => {
	Reflect.deleteProperty(env, 'GROUP_HOST_URL');
	vi.restoreAllMocks();
});

describe('the groups switch', () => {
	it('is on for an http(s) URL, as its origin', () => {
		Object.assign(env, { GROUP_HOST_URL: ' https://host.example/path ' });
		expect(groupsEnabled()).toBe(true);
		expect(groupHostOrigin()).toBe('https://host.example');
	});

	it('is off, never a broken page, for a setting that is not an http(s) URL, and says so once', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const value of ['host.example', 'not a url', 'ftp://host.example', 'https://']) {
			Object.assign(env, { GROUP_HOST_URL: value });
			expect(groupsEnabled(), value).toBe(false);
			expect(groupHostOrigin(), value).toBeNull();
			expect(atGroupHost({ pds: 'https://host.example' }), value).toBe(false);
			expect(groupHostUrl(), value).toBeNull();
		}
		// Once for each value, however often it is read.
		expect(logged).toHaveBeenCalledTimes(4);
		expect(String(logged.mock.calls[0][0])).toContain('GROUP_HOST_URL');
	});

	it('is off, quietly, with no group host named', () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		for (const value of [undefined, '', '   ']) {
			Object.assign(env, { GROUP_HOST_URL: value });
			expect(groupsEnabled()).toBe(false);
		}
		expect(logged).not.toHaveBeenCalled();
	});

	it('takes http as well as https, and no other scheme', () => {
		expect(parseGroupHostUrl('http://localhost:2583')?.origin).toBe('http://localhost:2583');
		expect(parseGroupHostUrl('mailto:x@host.example')).toBeNull();
		expect(parseGroupHostUrl(undefined)).toBeNull();
	});
});
