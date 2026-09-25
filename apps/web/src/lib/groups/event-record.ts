// Group event form data -> the `community.lexicon.calendar.event` record that
// gets signed by the group DID. Kept apart from groups.remote.ts so the shape a
// form produces can be tested without a request: event-record.test.ts and
// scripts/groups-e2e.worker.ts call this function, not a copy of it.
//
// Everything here is record shape. Permission, authorship and lexicon
// validation stay in ./server/event-writer.ts, which refuses an invalid record
// before it can reach a PDS.

/** The form's fields, already parsed: `startsAt`/`endsAt` are ISO instants (the
 *  route resolves `datetime-local` to UTC first), the rest is raw text. */
export interface GroupEventFormInput {
	name: string;
	description?: string;
	/** ISO instant. */
	startsAt: string;
	/** ISO instant, or nothing. */
	endsAt?: string | null;
	locationName?: string;
	/** ISO 3166 country code. Required by the address lexicon (see below). */
	locationCountry?: string;
	/** Preserved across an edit so an edit does not restamp the record. */
	createdAt?: string;
}

export const ADDRESS_TYPE = 'community.lexicon.location.address';

/**
 * THE ADDRESS RULE. `community.lexicon.location.address` requires `country`
 * (2 to 10 characters), so a location with no country is not an address and
 * must not be written: `writeGroupEvent` validates the whole record and would
 * refuse it, taking the event with it.
 *
 * So an entry is built only when it satisfies the lexicon, and `locations` is
 * omitted rather than left empty. The app's own event editor follows the same
 * "include only what exists" rule (packages/ui/src/editor/LocationSection.svelte
 * spreads `...(country && { country })`). A location name with no country is
 * dropped, which is why the form says so next to the field.
 */
export function groupEventRecord(input: GroupEventFormInput): Record<string, unknown> {
	// `$type` is stamped by writeGroupEvent, which owns the collection name.
	const record: Record<string, unknown> = {
		name: input.name,
		createdAt: input.createdAt || new Date().toISOString(),
		startsAt: input.startsAt,
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled'
	};
	if (input.description) record.description = input.description;
	if (input.endsAt) record.endsAt = input.endsAt;

	const country = input.locationCountry?.trim();
	const name = input.locationName?.trim();
	if (country) {
		record.locations = [{ $type: ADDRESS_TYPE, ...(name && { name }), country }];
	}
	return record;
}
