// A group's fields as people type them, checked as the spec's lexicons bound them
// (org.atgrp.about, org.atgrp.config) and as the group host takes an address. Values and pure
// checks only, so the forms can import them.
import { GROUP_JOIN_POLICIES, type GroupJoinPolicy } from './ids';

export const GROUP_NAME_MAX = 64;
export const GROUP_DESCRIPTION_MAX = 2000;
/** One DNS label: the host gives each group a name one label under its own domain. */
export const GROUP_ADDRESS_MAX = 63;

const graphemes = new Intl.Segmenter();
const length = (value: string) => [...graphemes.segment(value)].length;
const bytes = (value: string) => new TextEncoder().encode(value).length;

/** `displayName`: more than spaces, at most 64 graphemes and 640 bytes. */
export function groupName(value: unknown): string | null {
	const name = typeof value === 'string' ? value.trim() : '';
	return name && length(name) <= GROUP_NAME_MAX && bytes(name) <= 640 ? name : null;
}

/** `description`: at most 2000 graphemes and 20000 bytes; empty is none. `undefined` when too long. */
export function groupDescription(value: unknown): string | null | undefined {
	const description = typeof value === 'string' ? value.trim() : '';
	if (!description) return null;
	return length(description) <= GROUP_DESCRIPTION_MAX && bytes(description) <= 20000
		? description
		: undefined;
}

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

/** The label a group's address starts with, lowercased: letters, digits and inner hyphens. */
export function groupAddressLabel(value: unknown): string | null {
	const label = typeof value === 'string' ? value.trim().toLowerCase() : '';
	return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label) ? label : null;
}
