import { error } from '@sveltejs/kit';
import { command, getRequestEvent, query } from '$app/server';
import * as v from 'valibot';
import { calendarEvent, RSVP_STATUSES, singleEvent } from './ids';
import { asCaller } from './server/command';
import { privateEventsBetaOn } from './beta';
import { BetaNotSaved, canSaveBeta, readBetaRecord, saveBeta } from './server/beta';
import { privateEventsEnabled } from './server/enabled';
import {
	addPersonToCalendar as addPerson,
	createCalendar as makeCalendar,
	deleteCalendar as removeCalendar,
	removePersonFromCalendar as removePerson,
	renameCalendar as nameCalendar
} from './server/calendars';
import {
	addGuest as addGuestToEvent,
	cancelPrivateEvent as cancelEvent,
	deletePrivateRsvp,
	putPrivateRsvp,
	removeGuest as removeGuestFromEvent,
	savePrivateEvent as saveEvent
} from './server/events';

const didSchema = v.pipe(v.string(), v.regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]{1,2048}$/));
const rkeySchema = v.pipe(v.string(), v.regex(/^[a-zA-Z0-9._:~-]{1,512}$/));
/** A shared calendar's key, which also says which space an event on it is in. */
const calendarSchema = v.pipe(v.string(), v.regex(/^cal-[a-zA-Z0-9._:~-]{1,508}$/));
const nameSchema = v.pipe(v.string(), v.minLength(1), v.maxLength(640));

const addressOf = (host: string, rkey: string, calendar: string | undefined) =>
	calendar ? calendarEvent(host, calendar, rkey) : singleEvent(host, rkey);

/** Always into the caller's own space: a calendar named here is one of their own. */
export const savePrivateEvent = command(
	v.object({
		rkey: rkeySchema,
		record: v.record(v.string(), v.unknown()),
		calendar: v.optional(calendarSchema)
	}),
	(input) => asCaller((caller) => saveEvent(caller, input))
);

export const cancelPrivateEvent = command(
	v.object({ rkey: rkeySchema, calendar: v.optional(calendarSchema) }),
	({ rkey, calendar }) =>
		asCaller((caller) => cancelEvent(caller, { spaceKey: calendar ?? rkey, rkey }))
);

export const rsvpToPrivateEvent = command(
	v.object({
		host: didSchema,
		rkey: rkeySchema,
		calendar: v.optional(calendarSchema),
		status: v.picklist(RSVP_STATUSES),
		cid: v.nullable(v.string())
	}),
	({ host, rkey, calendar, ...input }) =>
		asCaller((caller) => putPrivateRsvp(caller, addressOf(host, rkey, calendar), input))
);

export const cancelPrivateRsvp = command(
	v.object({ host: didSchema, rkey: rkeySchema, calendar: v.optional(calendarSchema) }),
	({ host, rkey, calendar }) =>
		asCaller((caller) => deletePrivateRsvp(caller, addressOf(host, rkey, calendar)))
);

export const createCalendar = command(v.object({ name: nameSchema }), (input) =>
	asCaller((caller) => makeCalendar(caller, input))
);

export const renameCalendar = command(
	v.object({ key: calendarSchema, name: nameSchema }),
	(input) => asCaller((caller) => nameCalendar(caller, input))
);

export const deleteCalendar = command(v.object({ key: calendarSchema }), ({ key }) =>
	asCaller((caller) => removeCalendar(caller, key))
);

export const addPersonToCalendar = command(
	v.object({
		key: calendarSchema,
		handleOrDid: v.pipe(v.string(), v.minLength(3), v.maxLength(2048))
	}),
	(input) => asCaller((caller) => addPerson(caller, input))
);

export const removePersonFromCalendar = command(
	v.object({ key: calendarSchema, did: didSchema }),
	(input) => asCaller((caller) => removePerson(caller, input))
);

export const addGuest = command(
	v.object({
		rkey: rkeySchema,
		handleOrDid: v.pipe(v.string(), v.minLength(3), v.maxLength(2048))
	}),
	(input) => asCaller((caller) => addGuestToEvent(caller, input))
);

export const removeGuest = command(v.object({ rkey: rkeySchema, did: didSchema }), (input) =>
	asCaller((caller) => removeGuestFromEvent(caller, input))
);

/** The signed-in person, for the beta switch, which lives in their public repo, not in a space. */
function betaCaller() {
	if (!privateEventsEnabled()) error(404, 'Not found');
	const { locals } = getRequestEvent();
	if (!locals.client || !locals.did) error(401, 'Sign in first');
	return { client: locals.client, did: locals.did };
}

export const getPrivateEventsBeta = query(async () => {
	const { client, did } = betaCaller();
	const [canSave, found] = await Promise.all([
		canSaveBeta(),
		readBetaRecord(client, did, AbortSignal.timeout(5_000))
	]);
	return { canSave, on: privateEventsBetaOn(found?.record) };
});

export const setPrivateEventsBeta = command(v.object({ on: v.boolean() }), async ({ on }) => {
	const { client, did } = betaCaller();
	if (!(await canSaveBeta())) error(403, 'Authorize atmo to save this setting first.');
	try {
		await saveBeta(client, did, on);
	} catch (e) {
		error(
			e instanceof BetaNotSaved ? 409 : 502,
			e instanceof BetaNotSaved ? e.message : 'Could not reach your data server. Try again.'
		);
	}
	// The page asks for the setting with the save (.updates), which needs the refresh to be done here.
	await getPrivateEventsBeta().refresh();
	return { on };
});
