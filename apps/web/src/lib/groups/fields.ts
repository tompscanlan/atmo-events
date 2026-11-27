// A group's fields as people type them, checked as the spec's lexicons bound them
// (org.atgrp.about, org.atgrp.config). Values and pure checks only, so the forms can import them.
import { GROUP_JOIN_POLICIES, type GroupJoinPolicy } from './ids';

/** A request to join's message. The spec's bound is 2000 graphemes, which 2000 characters never
 *  pass. */
export const JOIN_MESSAGE_MAX = 2000;

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
