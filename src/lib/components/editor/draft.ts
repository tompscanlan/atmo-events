import type { EventDraft } from './types';

const OLD_DRAFT_KEY = 'blento-event-draft';

export function draftKeyFor(rkey: string): string {
	return `blento-event-edit-${rkey}`;
}

/** Promote any pre-existing shared "new event" draft into a per-rkey draft. */
export function migrateLegacyDraft(rkey: string): void {
	const key = draftKeyFor(rkey);
	const old = localStorage.getItem(OLD_DRAFT_KEY);
	if (old && !localStorage.getItem(key)) {
		localStorage.setItem(key, old);
		localStorage.removeItem(OLD_DRAFT_KEY);
	}
}

export function readDraft(rkey: string): EventDraft | null {
	const saved = localStorage.getItem(draftKeyFor(rkey));
	if (!saved) return null;
	try {
		return JSON.parse(saved) as EventDraft;
	} catch {
		localStorage.removeItem(draftKeyFor(rkey));
		return null;
	}
}

export function writeDraft(rkey: string, draft: EventDraft): void {
	localStorage.setItem(draftKeyFor(rkey), JSON.stringify(draft));
}

export function clearDraft(rkey: string): void {
	localStorage.removeItem(draftKeyFor(rkey));
}
