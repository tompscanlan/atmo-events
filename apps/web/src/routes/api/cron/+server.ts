import { contrail, ensureInit } from '$lib/contrail/index';
import { processBotMentions } from '$lib/bot/process-mentions';
import { runNotifications } from '$lib/notify/process';
import type { RequestHandler } from './$types';

export const POST: RequestHandler = async ({ request, platform }) => {
	const secret = request.headers.get('X-Cron-Secret');
	if (secret !== platform!.env.CRON_SECRET) {
		return new Response('Unauthorized', { status: 401 });
	}

	const db = platform!.env.DB;

	// Reply bot runs first and is fully isolated: it must not be starved or
	// aborted by the heavier ingest below, which can throw (e.g. D1 CPU limits
	// while catching up a backlog). The bot relies on its own queries +
	// notifyOfUpdate, so it works even when firehose ingest is behind.
	try {
		await processBotMentions(platform!.env, db);
	} catch (e) {
		console.error('[bot] processBotMentions failed:', e);
	}

	// Firehose ingest — guarded so an over-budget cycle can't 500 the whole tick
	// (which previously also took the bot down with it).
	try {
		const env = platform!.env;
		await ensureInit(db, env);
		if (env.JETSTREAM_URLS) {
			(contrail.config as any).jetstreams = env.JETSTREAM_URLS.split(',').filter(Boolean);
		}
		if (env.PLC_URL && !contrail.config.networkOverrides?.resolver) {
			const { CompositeDidDocumentResolver, PlcDidDocumentResolver, WebDidDocumentResolver } =
				await import('@atcute/identity-resolver');
			(contrail.config as any).networkOverrides = {
				...contrail.config.networkOverrides,
				resolver: new CompositeDidDocumentResolver({
					methods: {
						plc: new PlcDidDocumentResolver({ apiUrl: env.PLC_URL }),
						web: new WebDidDocumentResolver()
					}
				})
			};
		}
		// Two deliberately-split budgets. contrail saves the jetstream cursor LAST in
		// runIngestCycle — after the drain, applyEvents, and the per-DID
		// refreshStaleIdentities network tail. If this handler aborts before that
		// save runs, the cursor never advances and the next tick re-replays the same
		// window forever (the "redoing the same work" loop). A backlogged stream made
		// this certain: a 30s drain consumed the whole budget, leaving <5s for a tail
		// that needs more, so the old INGEST_TIMEOUT_MS+5s race rejected before the
		// cursor was persisted.
		//   DRAIN — contrail's internal deadline; how long we pull from jetstream.
		//           Kept well under the hard cap so the tail (incl. saveCursor) fits.
		//   HARD  — backstop only, for a genuine hang (e.g. a DID resolution that
		//           never returns). Sized never to pre-empt the cursor save in a
		//           normal cycle, and under the 60s cron interval so ticks don't
		//           overlap. Scheduled invocations get ~15min wall-clock and this is
		//           I/O-bound, so the tail has ample room.
		const DRAIN_TIMEOUT_MS = 20_000;
		const HARD_TIMEOUT_MS = 55_000;
		await Promise.race([
			contrail.ingest({ timeoutMs: DRAIN_TIMEOUT_MS }, db),
			new Promise((_, reject) =>
				setTimeout(() => reject(new Error('ingest hard timeout')), HARD_TIMEOUT_MS)
			)
		]);
	} catch (e) {
		console.error('[cron] contrail.ingest failed:', e);
	}

	// atmo.pub notifications: event reminders + host RSVP alerts. Runs after
	// ingest so it sees the freshest records; isolated so a failure can't 500
	// the tick. No-ops when notifications aren't configured.
	try {
		await runNotifications(platform!.env, db);
	} catch (e) {
		console.error('[cron] runNotifications failed:', e);
	}

	return new Response('OK');
};
