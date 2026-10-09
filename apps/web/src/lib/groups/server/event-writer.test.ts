// The write gate. These cases defend against one mistake: copying
// `repo: locals.did` from $lib/atproto/server/repo.remote.ts into the group
// path. That would look fine, pass every permission check, and silently author
// group events under whichever admin clicked, which is the model this feature
// exists to avoid.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

vi.mock('$lib/atproto/server/oauth', async (importOriginal) => ({
	...(await importOriginal<typeof import('$lib/atproto/server/oauth')>()),
	...(await import('./__fixtures__/linked-oauth-stub')).linkedOAuthStub
}));

import { sqliteD1, type SqliteD1 } from './__fixtures__/d1-sqlite';
import { linkGroups, linkedCredential, unlinkAllGroups } from './__fixtures__/linked-group';
import { stubPds, type StubPdsOptions } from './__fixtures__/stub-pds';
import { addMember, createGroup, recordGroupSpaces } from './repo';
import { pdsProvisioner, provisionGroupSpaces } from './spaces';
import {
	GROUP_EVENT_IMAGE_MAX_BYTES,
	deleteGroupEvent,
	groupBlobUploader,
	uploadGroupEventImage,
	writeGroupEvent,
	type GroupBlobUploader,
	type GroupEventLocator,
	type WriteGroupEventInput
} from './event-writer';
import type { IndexNotifier } from './events-index';
import type { GroupRow } from '../types';

import { GROUP_EVENT_COLLECTION } from '../ids';
import {
	GroupPermissionError,
	GroupRecordError,
	groupWriter,
	type GroupRepoWrite,
	type GroupRepoWriter
} from './group-write';
import { GroupCredentialError } from './session';
const GROUP_DID = 'did:plc:jcwgw6fcnb5vyoid7nz7sl26';
const OWNER = 'did:plc:owner';
/** The admin in every case below: a non-owner who was promoted, exactly the
 *  actor the co-editing requirement is about. */
const ADMIN = 'did:plc:hkymspvcjhy6sbujuydfj7sv';
const MEMBER = 'did:plc:6cz6dldz42itymdbte47ewcv';
const STRANGER = 'did:plc:ib2wrjcp4ulwqu35a7rtlckv';

let harness: SqliteD1;
let db: D1Database;
let group: GroupRow;
let writes: GroupRepoWrite[];
let writer: GroupRepoWriter;
/** URIs the gate handed to the index, in order. Stubbed on every call that
 *  gets as far as a write: the real notifier stands up an appview, which a
 *  unit test should not do. */
let notified: string[];
let notify: IndexNotifier;

// The writer takes an env only to find the group's linked session, and these
// cases inject their own writer, so it is never consulted.
const env = {};

/** For the cases that inject a writer: every event an edit or a delete names is
 *  in the group's public repo, where a public edit expects it. The cases about
 *  placement run against the stub PDS instead (`members-only placement`). */
const inPublicRepo: GroupEventLocator = {
	getSpace: async () => {
		throw new Error('a public write asked for the calendar space');
	},
	has: async (space) => space === null
};

function validRecord(name = 'Kona weekly ride') {
	return {
		name,
		createdAt: '2026-09-01T12:00:00.000Z',
		startsAt: '2026-09-20T18:00:00.000Z',
		mode: 'community.lexicon.calendar.event#inperson',
		status: 'community.lexicon.calendar.event#scheduled'
	};
}

beforeEach(async () => {
	harness = sqliteD1();
	db = harness.db;
	group = await createGroup(db, {
		groupDid: GROUP_DID,
		ownerDid: OWNER,
		name: 'Kona'
	});
	await addMember(db, group.id, ADMIN, 'admin');
	await addMember(db, group.id, MEMBER, 'member');

	writes = [];
	writer = async (write) => {
		writes.push(write);
		return { uri: `at://${write.repo}/${write.collection}/${write.rkey}`, cid: 'bafytest' };
	};

	notified = [];
	notify = async (uri) => {
		notified.push(uri);
	};
});

afterEach(() => harness.close());

describe('authorship', () => {
	// The main requirement: a non-owner admin edits an event they did not
	// create, and the record that lands is the group's.
	it('lets a non-owner admin edit an event the owner created, as the group', async () => {
		const created = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: OWNER,
			space: null,
			intent: 'create',
			record: validRecord(),
			writer,
			notify
		});
		expect(created.repo).toBe(GROUP_DID);

		const edited = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			space: null,
			intent: 'update',
			rkey: created.rkey,
			record: {
				...validRecord('Weekly ride, new time'),
				startsAt: '2026-09-21T18:00:00.000Z'
			},
			writer,
			locator: inPublicRepo,
			notify
		});

		expect(edited.rkey).toBe(created.rkey);
		expect(edited.repo).toBe(GROUP_DID);
		expect(edited.uri).toBe(`at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`);

		// Not the admin's repo, not the owner's, not `locals.did`: the group's.
		expect(writes.map((w) => w.repo)).toEqual([GROUP_DID, GROUP_DID]);
		expect(writes.some((w) => w.repo === ADMIN || w.repo === OWNER)).toBe(false);
		expect(writes[1].intent).toBe('update');
		expect(writes[1].record.name).toBe('Weekly ride, new time');
	});

	it('mints a TID for a create and reuses the given rkey for an update', async () => {
		const created = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			space: null,
			intent: 'create',
			record: validRecord(),
			writer,
			notify
		});
		expect(created.rkey).toMatch(/^[a-z2-7]{13}$/);
		expect(writes[0].intent).toBe('create');

		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: ADMIN,
				space: null,
				intent: 'update',
				record: validRecord(),
				writer,
				locator: inPublicRepo,
				notify
			})
		).rejects.toBeInstanceOf(GroupRecordError);
	});

	// If the transport reports a URI under some other authority, the model has
	// been violated and the caller must not be told the write succeeded.
	// A record that landed under the wrong authority is not this group's, so it
	// must not be pushed into the index either: the refusal has to reach both.
	it('refuses a result whose URI is not in the group repo', async () => {
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: ADMIN,
				space: null,
				intent: 'create',
				record: validRecord(),
				writer: async () => ({ uri: `at://${ADMIN}/${GROUP_EVENT_COLLECTION}/abc`, cid: 'x' }),
				notify
			})
		).rejects.toThrow(/is not did:plc:jcwgw6fcnb5vyoid7nz7sl26's repo/);
		expect(notified).toEqual([]);
	});
});

describe('the permission gate', () => {
	it('refuses a plain member: no CREATE_EVENT, no MANAGE_EVENTS', async () => {
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: MEMBER,
				space: null,
				intent: 'create',
				record: validRecord(),
				writer,
				notify
			})
		).rejects.toMatchObject({ permission: 'CREATE_EVENT' });
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: MEMBER,
				space: null,
				intent: 'update',
				rkey: '3abc',
				record: validRecord(),
				writer,
				locator: inPublicRepo,
				notify
			})
		).rejects.toMatchObject({ permission: 'MANAGE_EVENTS' });
		expect(writes).toEqual([]);
	});

	it('refuses an off-roster DID and an anonymous caller', async () => {
		for (const callerDid of [STRANGER, null]) {
			await expect(
				writeGroupEvent({
					db,
					env,
					group,
					callerDid,
					space: null,
					intent: 'create',
					record: validRecord(),
					writer,
					notify
				})
			).rejects.toBeInstanceOf(GroupPermissionError);
		}
		expect(writes).toEqual([]);
	});

	it('gates deletion on MANAGE_EVENTS and deletes from the group repo', async () => {
		await expect(
			deleteGroupEvent({
				db,
				env,
				group,
				callerDid: MEMBER,
				space: null,
				rkey: '3abc',
				writer,
				locator: inPublicRepo,
				notify
			})
		).rejects.toMatchObject({ permission: 'MANAGE_EVENTS' });

		const deleted = await deleteGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			space: null,
			rkey: '3abc',
			writer,
			locator: inPublicRepo,
			notify
		});
		expect(deleted.repo).toBe(GROUP_DID);
		expect(writes).toEqual([
			{
				repo: GROUP_DID,
				collection: GROUP_EVENT_COLLECTION,
				rkey: '3abc',
				record: {},
				intent: 'delete'
			}
		]);
	});
});

// A refused write must send nothing to the PDS. Every case above injects
// `writer`, so all they prove is that the seam was not called. These go
// through the real one: the group is linked, so `groupWriter` would build a
// PDS client if it were reached, and `fetch` records every request that leaves.
describe('refusal before transport', () => {
	let credentialEnv: ReturnType<typeof linkGroups>;
	let requests: string[];

	beforeEach(() => {
		credentialEnv = linkGroups([GROUP_DID], 'https://pds.test');
		requests = [];
		vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
			requests.push(input instanceof Request ? input.url : String(input));
			throw new Error('the PDS was contacted');
		});
	});

	afterEach(() => {
		vi.unstubAllGlobals();
		unlinkAllGroups();
	});

	// `reader: null` because this group has no members space, so the D1 rows
	// answer. What the gate reads is not what this case is about; what it
	// sends is.
	it("refuses a signed-in non-member's edit and delete without one request to the PDS", async () => {
		await expect(
			writeGroupEvent({
				db,
				env: credentialEnv,
				group,
				callerDid: STRANGER,
				space: null,
				intent: 'update',
				rkey: '3abc',
				record: validRecord(),
				reader: null,
				notify
			})
		).rejects.toBeInstanceOf(GroupPermissionError);
		await expect(
			deleteGroupEvent({
				db,
				env: credentialEnv,
				group,
				callerDid: STRANGER,
				space: null,
				rkey: '3abc',
				reader: null,
				notify
			})
		).rejects.toBeInstanceOf(GroupPermissionError);
		expect(requests).toEqual([]);
		expect(notified).toEqual([]);
	});

	it('does reach the PDS for an admin with the same setup, so the silence above is the gate', async () => {
		await expect(
			writeGroupEvent({
				db,
				env: credentialEnv,
				group,
				callerDid: ADMIN,
				space: null,
				intent: 'update',
				rkey: '3abc',
				record: validRecord(),
				reader: null,
				notify
			})
		).rejects.toThrow();
		expect(requests.length).toBeGreaterThan(0);
	});
});

describe('record validation', () => {
	it('rejects a malformed record before anything reaches the transport', async () => {
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: ADMIN,
				space: null,
				intent: 'create',
				// No `name`, which the lexicon requires.
				record: { createdAt: '2026-09-01T12:00:00.000Z' },
				writer,
				notify
			})
		).rejects.toBeInstanceOf(GroupRecordError);
		expect(writes).toEqual([]);
	});

	it('stamps the collection $type rather than trusting the caller', async () => {
		await writeGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			space: null,
			intent: 'create',
			record: { ...validRecord(), $type: 'app.bsky.feed.post' },
			writer,
			notify
		});
		expect(writes[0].record.$type).toBe(GROUP_EVENT_COLLECTION);
		expect(writes[0].collection).toBe(GROUP_EVENT_COLLECTION);
	});
});

describe('records from the event editor', () => {
	// The shape atmo's EventEditor hands its adapter (buildEventRecord): fields
	// the group form never sent, a location, and a cover image uploaded as a
	// blob. The writer must pass it through its lexicon check unchanged.
	it('accepts the record the event editor builds, image and theme included', async () => {
		const editorRecord = {
			$type: GROUP_EVENT_COLLECTION,
			createdWith: 'https://atmo.rsvp',
			name: 'Kona weekly ride',
			mode: 'community.lexicon.calendar.event#inperson',
			status: 'community.lexicon.calendar.event#scheduled',
			startsAt: '2026-10-04T17:00:00.000Z',
			endsAt: '2026-10-04T19:00:00.000Z',
			timezone: 'Pacific/Honolulu',
			createdAt: '2026-09-30T12:00:00.000Z',
			theme: { name: 'default', accentColor: 'cyan', baseColor: 'stone' },
			description: 'Meet at the pier.',
			uris: [{ uri: 'https://example.com/route', name: 'Route' }],
			locations: [{ $type: 'community.lexicon.location.address', country: 'US', locality: 'Kona' }],
			media: [
				{
					role: 'thumbnail',
					content: {
						$type: 'blob',
						ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
						mimeType: 'image/webp',
						size: 12345
					},
					aspect_ratio: { width: 1200, height: 630 }
				}
			],
			preferences: { showInDiscovery: true }
		};

		const result = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			space: null,
			intent: 'create',
			rkey: '3mwqnkcuf7cnp',
			record: editorRecord,
			writer,
			notify
		});

		expect(result.repo).toBe(GROUP_DID);
		expect(writes[0].record).toEqual(editorRecord);
	});
});

describe('credentials', () => {
	// A group whose owner has not linked its account cannot publish. Only the
	// owner can fix that, so it is reported as its own error, not as a 500 from
	// the PDS.
	it('fails with a not-linked error when the owner has not linked the group', async () => {
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: ADMIN,
				space: null,
				intent: 'create',
				record: validRecord()
			})
		).rejects.toBeInstanceOf(GroupCredentialError);
	});

	it('checks the permission before the credential', async () => {
		// Order matters: a member must be told they lack the permission, not that
		// the group is not linked.
		await expect(
			writeGroupEvent({
				db,
				env,
				group,
				callerDid: MEMBER,
				space: null,
				intent: 'create',
				record: validRecord()
			})
		).rejects.toBeInstanceOf(GroupPermissionError);
	});

	// No password stands in for a missing link: the writer and the uploader both
	// refuse before anything leaves for the PDS.
	describe('for a group nobody has linked', () => {
		let requests: string[];

		beforeEach(() => {
			requests = [];
			vi.stubGlobal('fetch', async (input: RequestInfo | URL) => {
				requests.push(input instanceof Request ? input.url : String(input));
				throw new Error('the PDS was contacted');
			});
		});

		afterEach(() => {
			vi.unstubAllGlobals();
			unlinkAllGroups();
		});

		// Another group is linked, so the sessions namespace exists and answers.
		const unlinked = () => linkGroups(['did:plc:anothergroupaaaaaaaaaaaa']);

		it('refuses to build a writer, and sends nothing', async () => {
			const refusal = groupWriter(unlinked(), group);

			await expect(refusal).rejects.toBeInstanceOf(GroupCredentialError);
			await expect(refusal).rejects.toThrow(/not linked/);
			expect(requests).toEqual([]);
		});

		it('refuses to build an image uploader, and sends nothing', async () => {
			await expect(groupBlobUploader(unlinked(), group)).rejects.toBeInstanceOf(
				GroupCredentialError
			);
			expect(requests).toEqual([]);
		});

		// A created group always has a members space, and without the link the gate
		// cannot read it. Even the owner is told the group is not linked rather
		// than "not allowed", and the injected writer is never reached.
		it('tells the owner of a group with a members space that it is not linked', async () => {
			const spaces = {
				aboutSpaceUri: `at://${GROUP_DID}/space/group.opensocial.meta/self`,
				membersSpaceUri: `at://${GROUP_DID}/space/group.opensocial.members/self`
			};
			await recordGroupSpaces(db, group.id, spaces);
			const provisioned = {
				...group,
				about_space_uri: spaces.aboutSpaceUri,
				members_space_uri: spaces.membersSpaceUri
			};

			await expect(
				writeGroupEvent({
					db,
					env: unlinked(),
					group: provisioned,
					callerDid: OWNER,
					space: null,
					intent: 'create',
					record: validRecord(),
					writer,
					notify
				})
			).rejects.toBeInstanceOf(GroupCredentialError);
			expect(writes).toEqual([]);
			expect(requests).toEqual([]);
		});

		it('refuses an admin’s event through the real writer, and sends nothing', async () => {
			await expect(
				writeGroupEvent({
					db,
					env: unlinked(),
					group,
					callerDid: ADMIN,
					space: null,
					intent: 'create',
					record: validRecord(),
					reader: null,
					notify
				})
			).rejects.toBeInstanceOf(GroupCredentialError);
			expect(requests).toEqual([]);
			expect(notified).toEqual([]);
		});
	});
});

// The events tab is served from the app's index rather than from the group's
// PDS, so a write that does not reach the index is a write nobody can see.
// Discovery is not a substitute: an actor-scoped read backfills a repo once and
// then records that it is done, so everything written after that first read is
// invisible until someone says so.
describe('telling the index', () => {
	it('hands over the URI that landed, on create, on edit and on delete', async () => {
		const created = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: OWNER,
			space: null,
			intent: 'create',
			record: validRecord(),
			writer,
			notify
		});
		await writeGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			space: null,
			intent: 'update',
			rkey: created.rkey,
			record: validRecord('Weekly ride, new time'),
			writer,
			locator: inPublicRepo,
			notify
		});
		await deleteGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			space: null,
			rkey: created.rkey,
			writer,
			locator: inPublicRepo,
			notify
		});

		const uri = `at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`;
		expect(notified).toEqual([uri, uri, uri]);
	});

	// The PDS has already accepted the record by this point. Failing the write
	// would be untrue, and would invite a retry of a write that landed.
	it('reports success when the index is unreachable', async () => {
		const result = await writeGroupEvent({
			db,
			env,
			group,
			callerDid: OWNER,
			space: null,
			intent: 'create',
			record: validRecord(),
			writer,
			notify: async () => {
				throw new Error('D1_ERROR: Network connection lost');
			}
		});
		expect(result.repo).toBe(GROUP_DID);
		expect(writes).toHaveLength(1);
	});
});

describe('event images', () => {
	const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
	let uploaded: Blob[];
	let upload: GroupBlobUploader;

	beforeEach(() => {
		uploaded = [];
		upload = async (blob) => {
			uploaded.push(blob);
			return { $type: 'blob', ref: { $link: 'bafyimage' }, mimeType: blob.type, size: blob.size };
		};
	});

	it("uploads an admin's image into the group's repo, as the write it is for", async () => {
		const ref = await uploadGroupEventImage({
			db,
			env,
			group,
			callerDid: ADMIN,
			intent: 'create',
			bytes: PNG,
			mimeType: 'image/png',
			upload
		});
		expect(ref).toMatchObject({ ref: { $link: 'bafyimage' }, mimeType: 'image/png', size: 4 });
		expect(uploaded).toHaveLength(1);
	});

	it('gates the upload on the permission its write needs', async () => {
		for (const [intent, permission] of [
			['create', 'CREATE_EVENT'],
			['update', 'MANAGE_EVENTS']
		] as const) {
			await expect(
				uploadGroupEventImage({
					db,
					env,
					group,
					callerDid: MEMBER,
					intent,
					bytes: PNG,
					mimeType: 'image/png',
					upload
				})
			).rejects.toMatchObject({ permission });
		}
		await expect(
			uploadGroupEventImage({
				db,
				env,
				group,
				callerDid: null,
				intent: 'create',
				bytes: PNG,
				mimeType: 'image/png',
				upload
			})
		).rejects.toBeInstanceOf(GroupPermissionError);
		expect(uploaded).toEqual([]);
	});

	it('refuses a file that is not an image, or is too large, before the transport', async () => {
		await expect(
			uploadGroupEventImage({
				db,
				env,
				group,
				callerDid: ADMIN,
				intent: 'create',
				bytes: PNG,
				mimeType: 'text/html',
				upload
			})
		).rejects.toBeInstanceOf(GroupRecordError);
		await expect(
			uploadGroupEventImage({
				db,
				env,
				group,
				callerDid: ADMIN,
				intent: 'create',
				bytes: new Uint8Array(GROUP_EVENT_IMAGE_MAX_BYTES + 1),
				mimeType: 'image/png',
				upload
			})
		).rejects.toBeInstanceOf(GroupRecordError);
		expect(uploaded).toEqual([]);
	});
});

// Where an event is written. A members-only event is the same record as a public
// one, placed in the group's calendar space instead of its public repo, and the
// container is the only thing that keeps it from anonymous readers. So these
// cases run the real transports against a fake host and read what it was sent:
// an injected writer would only prove the seam was called. The gate reads D1 rows
// (no members space, `reader: null`), so every call the host logs is the write
// path's own.
describe('members-only placement', () => {
	/** Written out, not taken from the app, so a wrong type or key in the app's
	 *  constant fails here. */
	const CALENDAR = `at://${GROUP_DID}/space/net.openmeet.space.calendar/self`;
	const PUBLIC_POLICY = 'com.atproto.simplespace.defs#publicPolicy';

	// The refusals' copy, as approved for the form.
	const NO_CALENDAR_SPACE =
		'This group has no calendar space for members-only events, because it was made before they existed. Re-create the group to post members-only events. Nothing was saved.';
	const READABLE_CALENDAR_SPACE =
		"This group's calendar space can be read by more than its members, so the members-only event was not saved.";
	const UNCHECKED_CALENDAR_SPACE =
		"The group's calendar space could not be checked, so the members-only event was not saved. Try again later.";
	const PLACEMENT_CHANGE =
		"This event can't be moved between public and members-only yet. Nothing was saved.";
	const WRONG_PLACEMENT_DELETE =
		"This event wasn't deleted, because the page had it as public when it's members-only, or the other way round. Reload and try again.";

	let pds: ReturnType<typeof stubPds>;
	let linkedEnv: ReturnType<typeof linkGroups>;

	/** The group, linked, on a host holding its three spaces as a create leaves
	 *  them. The log starts empty. */
	async function onHost(options: Partial<StubPdsOptions> = {}) {
		pds = stubPds({ did: GROUP_DID, handle: 'kona.stub.test', ...options });
		linkedEnv = linkGroups([GROUP_DID]);
		await provisionGroupSpaces(pdsProvisioner(linkedCredential(GROUP_DID), GROUP_DID), 'public');
		pds.clearLog();
	}

	beforeEach(async () => {
		// One line per write as the group (session.ts), which is noise here.
		vi.spyOn(console, 'info').mockImplementation(() => {});
		await onHost();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		unlinkAllGroups();
	});

	/** A write by the admin through the real writer. */
	const write = (
		input: Partial<WriteGroupEventInput> & Pick<WriteGroupEventInput, 'intent' | 'space'>
	) =>
		writeGroupEvent({
			db,
			env: linkedEnv,
			group,
			callerDid: ADMIN,
			record: validRecord(),
			reader: null,
			notify,
			...input
		});

	const remove = (
		rkey: string,
		space: string | null,
		input: Partial<Parameters<typeof deleteGroupEvent>[0]> = {}
	) =>
		deleteGroupEvent({
			db,
			env: linkedEnv,
			group,
			callerDid: ADMIN,
			rkey,
			space,
			reader: null,
			notify,
			...input
		});

	/** The methods the host was asked for, in order. */
	const nsids = () => pds.requests.map((r) => r.nsid);
	const repoCalls = () => nsids().filter((nsid) => nsid.startsWith('com.atproto.repo.'));

	/** Whether the host holds the event, asked straight from the stub and not
	 *  through the app's reader: in the calendar space, or in the public repo for
	 *  null. The log is left as it was. */
	async function hostHas(space: string | null, rkey: string): Promise<boolean> {
		const [requests, calls] = [pds.requests.length, pds.calls.length];
		const query = new URLSearchParams({
			...(space ? { space } : {}),
			repo: GROUP_DID,
			collection: GROUP_EVENT_COLLECTION,
			rkey
		});
		const method = space ? 'com.atproto.space.getRecord' : 'com.atproto.repo.getRecord';
		const res = await fetch(`https://pds.stub.test/xrpc/${method}?${query}`);
		pds.requests.splice(requests);
		pds.calls.splice(calls);
		return res.ok;
	}

	it('a members-only create goes to space.createRecord and never to a repo method', async () => {
		const created = await write({ intent: 'create', space: CALENDAR });

		// One check that the space is there and member-list, then the write.
		expect(nsids()).toEqual(['com.atproto.simplespace.getSpace', 'com.atproto.space.createRecord']);
		expect(pds.requests[0].params).toEqual({ space: CALENDAR });
		expect(pds.requests[1].body).toMatchObject({
			space: CALENDAR,
			repo: GROUP_DID,
			collection: GROUP_EVENT_COLLECTION,
			rkey: created.rkey
		});
		expect(created.uri).toBe(`${CALENDAR}/${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`);
		expect(await hostHas(CALENDAR, created.rkey)).toBe(true);
		expect(await hostHas(null, created.rkey)).toBe(false);
	});

	it('a members-only edit goes to space.putRecord in the calendar space', async () => {
		const created = await write({ intent: 'create', space: CALENDAR });
		pds.clearLog();

		const edited = await write({
			intent: 'update',
			space: CALENDAR,
			rkey: created.rkey,
			record: validRecord('Kona weekly ride, new time')
		});

		// The space check, the read that finds the event where the page says, the put.
		expect(nsids()).toEqual([
			'com.atproto.simplespace.getSpace',
			'com.atproto.space.getRecord',
			'com.atproto.space.putRecord'
		]);
		expect(pds.requests[1].params).toMatchObject({ space: CALENDAR, rkey: created.rkey });
		expect(pds.requests[2].body).toMatchObject({
			space: CALENDAR,
			rkey: created.rkey,
			record: { name: 'Kona weekly ride, new time' }
		});
		expect(edited.uri).toBe(created.uri);
		expect(await hostHas(null, created.rkey)).toBe(false);
	});

	it('a members-only delete goes to space.deleteRecord and never to repo.deleteRecord', async () => {
		const created = await write({ intent: 'create', space: CALENDAR });
		pds.clearLog();

		await remove(created.rkey, CALENDAR);

		expect(nsids()).toEqual(['com.atproto.space.getRecord', 'com.atproto.space.deleteRecord']);
		expect(pds.requests[1].body).toEqual({
			space: CALENDAR,
			repo: GROUP_DID,
			collection: GROUP_EVENT_COLLECTION,
			rkey: created.rkey
		});
		expect(await hostHas(CALENDAR, created.rkey)).toBe(false);
	});

	it('a members-only write and delete never notify the index', async () => {
		const created = await write({ intent: 'create', space: CALENDAR });
		await write({ intent: 'update', space: CALENDAR, rkey: created.rkey });
		const deleted = await remove(created.rkey, CALENDAR);

		// A space delete answers with the plain URI, the same shape as a public
		// one, so the skip cannot be told from the URI.
		expect(deleted.uri).toBe(`at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`);
		expect(notified).toEqual([]);

		// The same three steps in the public repo tell the index once each.
		const shown = await write({ intent: 'create', space: null });
		await write({ intent: 'update', space: null, rkey: shown.rkey });
		await remove(shown.rkey, null);
		const uri = `at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${shown.rkey}`;
		expect(notified).toEqual([uri, uri, uri]);
	});

	// A put creates the record when none is there, in either container, so an
	// edit sent to the other container would silently copy the event across.
	it('an edit that changes placement is refused with no write', async () => {
		const membersOnly = await write({ intent: 'create', space: CALENDAR });
		const shown = await write({ intent: 'create', space: null });
		pds.clearLog();

		await expect(
			write({ intent: 'update', space: null, rkey: membersOnly.rkey })
		).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'placement-change',
			message: PLACEMENT_CHANGE
		});
		await expect(
			write({ intent: 'update', space: CALENDAR, rkey: shown.rkey })
		).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'placement-change',
			message: PLACEMENT_CHANGE
		});

		expect(pds.writes()).toEqual([]);
		expect(await hostHas(null, membersOnly.rkey)).toBe(false);
		expect(await hostHas(CALENDAR, membersOnly.rkey)).toBe(true);
		expect(await hostHas(CALENDAR, shown.rkey)).toBe(false);
		expect(await hostHas(null, shown.rkey)).toBe(true);
		expect(notified).toHaveLength(1);
	});

	// A delete of a missing record succeeds in either container, so a delete sent
	// to the wrong one would report success and leave the event where it is.
	it('a delete at the wrong placement is refused with no write', async () => {
		const membersOnly = await write({ intent: 'create', space: CALENDAR });
		const shown = await write({ intent: 'create', space: null });
		pds.clearLog();

		await expect(remove(membersOnly.rkey, null)).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'wrong-placement-delete',
			message: WRONG_PLACEMENT_DELETE
		});
		await expect(remove(shown.rkey, CALENDAR)).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'wrong-placement-delete',
			message: WRONG_PLACEMENT_DELETE
		});

		expect(pds.writes()).toEqual([]);
		expect(await hostHas(CALENDAR, membersOnly.rkey)).toBe(true);
		expect(await hostHas(null, shown.rkey)).toBe(true);
	});

	it('an edit or delete of an event in neither container acts where it was sent, as before', async () => {
		await write({ intent: 'update', space: null, rkey: '3publicmissing' });
		expect(nsids()).toEqual([
			'com.atproto.repo.getRecord',
			'com.atproto.space.getRecord',
			'com.atproto.repo.putRecord'
		]);
		pds.clearLog();
		await write({ intent: 'update', space: CALENDAR, rkey: '3membersmissing' });
		expect(nsids()).toEqual([
			'com.atproto.simplespace.getSpace',
			'com.atproto.space.getRecord',
			'com.atproto.repo.getRecord',
			'com.atproto.space.putRecord'
		]);
		pds.clearLog();
		await remove('3gonealready', null);
		await remove('3gonealready', CALENDAR);
		expect(nsids()).toEqual([
			'com.atproto.repo.getRecord',
			'com.atproto.space.getRecord',
			'com.atproto.repo.deleteRecord',
			'com.atproto.space.getRecord',
			'com.atproto.repo.getRecord',
			'com.atproto.space.deleteRecord'
		]);
	});

	it('a members-only write to a group with no calendar space is refused with no write', async () => {
		// A group made before the calendar space existed. The host would take the
		// write anyway and make the space as it went, so the refusal is the app's.
		pds.spaces.delete(CALENDAR);

		await expect(write({ intent: 'create', space: CALENDAR })).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'no-calendar-space',
			message: NO_CALENDAR_SPACE
		});
		await expect(write({ intent: 'update', space: CALENDAR, rkey: '3abc' })).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'no-calendar-space',
			message: NO_CALENDAR_SPACE
		});

		// The space check is the only call each time: nothing written anywhere, and
		// nothing in the public repo instead.
		expect(nsids()).toEqual([
			'com.atproto.simplespace.getSpace',
			'com.atproto.simplespace.getSpace'
		]);
		expect(notified).toEqual([]);
	});

	it('a members-only write into a calendar space that is not member-list is refused with no write', async () => {
		const config = pds.spaces.get(CALENDAR)!;
		pds.spaces.set(CALENDAR, { ...config, readPolicy: { $type: PUBLIC_POLICY } });

		await expect(write({ intent: 'create', space: CALENDAR })).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'calendar-space-readable',
			message: READABLE_CALENDAR_SPACE
		});
		await expect(write({ intent: 'update', space: CALENDAR, rkey: '3abc' })).rejects.toMatchObject({
			name: 'GroupPlacementError',
			reason: 'calendar-space-readable',
			message: READABLE_CALENDAR_SPACE
		});

		expect(pds.writes()).toEqual([]);
		expect(repoCalls()).toEqual([]);
	});

	it('a members-only write is refused when the calendar space cannot be checked', async () => {
		const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
		const answers: (() => Response)[] = [
			() => Response.json({ error: 'InternalServerError' }, { status: 500 }),
			// A 200 with no read policy says nothing about who can read the space.
			() => Response.json({ uri: CALENDAR }),
			() => {
				throw new TypeError('fetch failed');
			}
		];
		for (const answer of answers) {
			await onHost({
				fail: (nsid) => (nsid === 'com.atproto.simplespace.getSpace' ? answer() : undefined)
			});
			await expect(write({ intent: 'create', space: CALENDAR })).rejects.toMatchObject({
				name: 'GroupPlacementError',
				reason: 'calendar-space-unchecked',
				message: UNCHECKED_CALENDAR_SPACE
			});
			expect(pds.writes()).toEqual([]);
			expect(repoCalls()).toEqual([]);
		}
		expect(logged).toHaveBeenCalledTimes(answers.length);
	});

	// A read that fails says nothing about where the event is, so the write
	// does not guess.
	it('a placement read the host cannot answer refuses the edit and the delete, and writes nothing', async () => {
		vi.spyOn(console, 'error').mockImplementation(() => {});
		await onHost({
			fail: (nsid) =>
				nsid === 'com.atproto.repo.getRecord' || nsid === 'com.atproto.space.getRecord'
					? Response.json({ error: 'InternalServerError' }, { status: 500 })
					: undefined
		});

		for (const space of [null, CALENDAR]) {
			await expect(write({ intent: 'update', space, rkey: '3abc' })).rejects.toMatchObject({
				name: 'GroupPlacementError',
				reason: 'placement-unchecked'
			});
			await expect(remove('3abc', space)).rejects.toMatchObject({
				name: 'GroupPlacementError',
				reason: 'placement-unchecked'
			});
		}
		expect(pds.writes()).toEqual([]);
		expect(notified).toEqual([]);
	});

	it('a write with no placement is refused before any PDS call', async () => {
		// A group with a members space, so the gate itself would read the host if
		// the refusal came after it.
		const provisioned = await provisionedGroup();
		const missing = [{}, { space: undefined }];
		for (const placement of missing) {
			for (const intent of ['create', 'update'] as const) {
				const input = {
					db,
					env: linkedEnv,
					group: provisioned,
					callerDid: ADMIN,
					intent,
					rkey: '3abc',
					record: validRecord(),
					notify,
					...placement
				} as unknown as WriteGroupEventInput;
				await expect(writeGroupEvent(input)).rejects.toMatchObject({
					name: 'GroupPlacementError',
					reason: 'no-placement'
				});
			}
			const input = {
				db,
				env: linkedEnv,
				group: provisioned,
				callerDid: ADMIN,
				rkey: '3abc',
				notify,
				...placement
			} as unknown as Parameters<typeof deleteGroupEvent>[0];
			await expect(deleteGroupEvent(input)).rejects.toMatchObject({
				name: 'GroupPlacementError',
				reason: 'no-placement'
			});
		}
		expect(pds.calls).toEqual([]);
		expect(notified).toEqual([]);
	});

	it('the writer refuses a space other than the group’s calendar space before the gate reads anything', async () => {
		const provisioned = await provisionedGroup();
		const foreign = [
			`at://${GROUP_DID}/space/group.opensocial.meta/self`,
			`at://${GROUP_DID}/space/group.opensocial.members/self`,
			`at://${GROUP_DID}/space/net.openmeet.space.calendar/other`,
			'at://did:plc:anothergroupaaaaaaaaaaaa/space/net.openmeet.space.calendar/self'
		];
		for (const space of foreign) {
			for (const intent of ['create', 'update'] as const) {
				await expect(
					writeGroupEvent({
						db,
						env: linkedEnv,
						group: provisioned,
						callerDid: ADMIN,
						intent,
						rkey: '3abc',
						space,
						record: validRecord(),
						notify
					})
				).rejects.toMatchObject({ name: 'GroupPlacementError', reason: 'not-the-calendar-space' });
			}
			await expect(
				deleteGroupEvent({
					db,
					env: linkedEnv,
					group: provisioned,
					callerDid: ADMIN,
					rkey: '3abc',
					space,
					notify
				})
			).rejects.toMatchObject({ name: 'GroupPlacementError', reason: 'not-the-calendar-space' });
		}
		expect(pds.calls).toEqual([]);
	});

	it('a public write sends the same request as before', async () => {
		const record = validRecord();
		const created = await write({ intent: 'create', space: null, record });
		const sent = {
			repo: GROUP_DID,
			collection: GROUP_EVENT_COLLECTION,
			rkey: created.rkey,
			record: { ...record, $type: GROUP_EVENT_COLLECTION }
		};
		const read = {
			nsid: 'com.atproto.repo.getRecord',
			body: null,
			params: { repo: GROUP_DID, collection: GROUP_EVENT_COLLECTION, rkey: created.rkey }
		};

		// A create is exactly the one call it was.
		expect(pds.requests).toEqual([
			{ nsid: 'com.atproto.repo.createRecord', body: sent, params: {} }
		]);
		pds.clearLog();

		// An edit and a delete send the same write, after one read that finds the
		// event in the public repo.
		await write({ intent: 'update', space: null, rkey: created.rkey, record });
		expect(pds.requests).toEqual([
			read,
			{ nsid: 'com.atproto.repo.putRecord', body: sent, params: {} }
		]);
		pds.clearLog();

		await remove(created.rkey, null);
		expect(pds.requests).toEqual([
			read,
			{
				nsid: 'com.atproto.repo.deleteRecord',
				body: { repo: GROUP_DID, collection: GROUP_EVENT_COLLECTION, rkey: created.rkey },
				params: {}
			}
		]);

		const uri = `at://${GROUP_DID}/${GROUP_EVENT_COLLECTION}/${created.rkey}`;
		expect(notified).toEqual([uri, uri, uri]);
	});

	it('the event record is the same in either container', async () => {
		const record = validRecord();
		await write({ intent: 'create', space: null, record });
		await write({ intent: 'create', space: CALENDAR, record });

		const sentTo = (nsid: string) => pds.requests.find((r) => r.nsid === nsid)?.body?.record;
		const shown = sentTo('com.atproto.repo.createRecord');
		const membersOnly = sentTo('com.atproto.space.createRecord');

		// Placement is the only difference: no field says who may read it.
		expect(membersOnly).toStrictEqual(shown);
		for (const key of ['visibility', 'privacy', 'private', 'audience', 'isPrivate']) {
			expect(membersOnly).not.toHaveProperty(key);
		}
	});

	it('a members-only event keeps its image inside the calendar space', async () => {
		// Uploaded as a public event's image is; the record that cites it is in the
		// space, and no record in the public repo does.
		const media = [
			{
				role: 'thumbnail',
				content: {
					$type: 'blob',
					ref: { $link: 'bafkreihdwdcefgh4dqkjv67uzcmw7ojee6xedzdetojuzjevtenxquvyku' },
					mimeType: 'image/webp',
					size: 12345
				},
				aspect_ratio: { width: 1200, height: 630 }
			}
		];
		const created = await write({
			intent: 'create',
			space: CALENDAR,
			record: { ...validRecord(), media }
		});

		const sent = pds.requests.find((r) => r.nsid === 'com.atproto.space.createRecord')?.body;
		expect(sent).toMatchObject({ space: CALENDAR, rkey: created.rkey });
		expect((sent?.record as { media?: unknown }).media).toStrictEqual(media);
		expect(repoCalls()).toEqual([]);
	});

	it('a caller without the permission is refused before any PDS read or write', async () => {
		// MEMBER holds neither event permission, STRANGER is off the roster, and
		// null is anonymous. The gate answers from D1 here, so any call the host
		// logs would be a placement read or a write made before the gate.
		for (const callerDid of [MEMBER, STRANGER, null]) {
			for (const space of [CALENDAR, null]) {
				await expect(write({ callerDid, intent: 'create', space })).rejects.toBeInstanceOf(
					GroupPermissionError
				);
				await expect(
					write({ callerDid, intent: 'update', space, rkey: '3abc' })
				).rejects.toBeInstanceOf(GroupPermissionError);
				await expect(remove('3abc', space, { callerDid })).rejects.toBeInstanceOf(
					GroupPermissionError
				);
			}
		}
		expect(pds.calls).toEqual([]);
		expect(notified).toEqual([]);
	});

	/** The fixture group with its spaces recorded, so the gate reads its members
	 *  space through the host rather than answering from D1. */
	async function provisionedGroup(): Promise<GroupRow> {
		const spaces = {
			aboutSpaceUri: `at://${GROUP_DID}/space/group.opensocial.meta/self`,
			membersSpaceUri: `at://${GROUP_DID}/space/group.opensocial.members/self`
		};
		await recordGroupSpaces(db, group.id, spaces);
		return {
			...group,
			about_space_uri: spaces.aboutSpaceUri,
			members_space_uri: spaces.membersSpaceUri
		};
	}
});
