// A group's fields, checked as the spec's lexicons bound them (org.atgrp.about, org.atgrp.config).
// Values and pure checks only, so the pages can import them.
import { GROUP_JOIN_POLICIES, type GroupJoinPolicy } from './ids';

/** `website`: an http or https URL, as the host requires; empty is none. `undefined` when it is
 *  not one. */
export function groupWebsite(value: unknown): string | null | undefined {
	const website = typeof value === 'string' ? value.trim() : '';
	if (!website) return null;
	try {
		const url = new URL(website);
		return /^https?:$/.test(url.protocol) ? url.href : undefined;
	} catch {
		return undefined;
	}
}

export function groupJoinPolicy(value: unknown): GroupJoinPolicy | null {
	return (GROUP_JOIN_POLICIES as readonly unknown[]).includes(value)
		? (value as GroupJoinPolicy)
		: null;
}
