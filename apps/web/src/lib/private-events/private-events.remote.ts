import { command } from '$app/server';
import * as v from 'valibot';
import { RSVP_STATUSES } from './ids';
import { asCaller } from './server/command';
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

export const savePrivateEvent = command(
	v.object({ rkey: rkeySchema, record: v.record(v.string(), v.unknown()) }),
	(input) => asCaller((caller) => saveEvent(caller, input))
);

export const cancelPrivateEvent = command(v.object({ rkey: rkeySchema }), ({ rkey }) =>
	asCaller((caller) => cancelEvent(caller, rkey))
);

export const rsvpToPrivateEvent = command(
	v.object({
		host: didSchema,
		rkey: rkeySchema,
		status: v.picklist(RSVP_STATUSES),
		cid: v.nullable(v.string())
	}),
	({ host, ...input }) => asCaller((caller) => putPrivateRsvp(caller, host, input))
);

export const cancelPrivateRsvp = command(
	v.object({ host: didSchema, rkey: rkeySchema }),
	({ host, rkey }) => asCaller((caller) => deletePrivateRsvp(caller, host, rkey))
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
