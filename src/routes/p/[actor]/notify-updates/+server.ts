import { error, json } from '@sveltejs/kit';
import { getActor } from '$lib/actor';
import { isActorIdentifier, type ResourceUri } from '@atcute/lexicons/syntax';
import { contrail, listEventRecordsFromContrail } from '$lib/contrail';

export async function GET({ params }) {
	if (!isActorIdentifier(params.actor)) {
		throw error(404, 'Not found');
	}

	const did = await getActor(params.actor);

	if (!did) {
		throw error(404, 'Not found');
	}

	// Paginate through all events
	const uris: string[] = [];
	let cursor: string | undefined;

	do {
		const response = await listEventRecordsFromContrail({
			actor: params.actor,
			limit: 100,
			cursor
		});

		if (!response) {
			if (uris.length === 0) throw error(500, 'Failed to list events');
			break;
		}

		uris.push(...response.records.map((r) => r.uri));
		cursor = response.cursor ?? undefined;
	} while (cursor);

	let totalIndexed = 0;
	let totalDeleted = 0;
	const allErrors: string[] = [];

	// Batch in groups of 25 (API limit)
	for (let i = 0; i < uris.length; i += 25) {
		const batch = uris.slice(i, i + 25);
		try {
			const result = await contrail.post('rsvp.atmo.notifyOfUpdate', {
				input: { uris: batch as ResourceUri[] }
			});
			if (result.ok) {
				totalIndexed += result.data.indexed;
				totalDeleted += result.data.deleted;
				if (result.data.errors) allErrors.push(...result.data.errors);
			}
		} catch {
			allErrors.push(`Batch starting at index ${i} failed`);
		}
	}

	return json({
		total: uris.length,
		indexed: totalIndexed,
		deleted: totalDeleted,
		errors: allErrors.length > 0 ? allErrors : undefined
	});
}
