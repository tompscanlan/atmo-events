// Fires atmo's every-minute timer, which wrangler's local runtime does not fire itself.
// Runs beside run.sh in the same pod: node /app/deploy/snowglobe/cron.mjs
const url = process.env.ATMO_SCHEDULED_URL ?? 'http://127.0.0.1:8787/__scheduled?cron=*+*+*+*+*';

async function tick() {
	try {
		const res = await fetch(url, { signal: AbortSignal.timeout(50_000) });
		if (!res.ok) console.error(`cron: ${res.status}`);
	} catch (e) {
		console.error(`cron: ${e instanceof Error ? e.message : e}`);
	}
}

setInterval(tick, 60_000);
