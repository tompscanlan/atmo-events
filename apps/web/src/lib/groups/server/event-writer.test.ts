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
import { linkGroups, unlinkAllGroups } from './__fixtures__/linked-group';
import { addMember, createGroup, recordGroupSpaces } from './repo';
import {
	GROUP_EVENT_COLLECTION,
	GroupCredentialError,
	GroupPermissionError,
	GroupRecordError,
	GROUP_EVENT_IMAGE_MAX_BYTES,
	deleteGroupEvent,
	groupBlobUploader,
	groupWriter,
	uploadGroupEventImage,
	writeGroupEvent,
	type GroupBlobUploader,
	type GroupRepoWrite,
	type GroupRepoWriter
} from './event-writer';
import type { GroupEventNotifier } from './events-index';
import type { GroupRow } from '../types';

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
let notify: GroupEventNotifier;

// The writer takes an env only to find the group's linked session, and these
// cases inject their own writer, so it is never consulted.
const env = {};

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
			intent: 'update',
			rkey: created.rkey,
			record: {
				...validRecord('Weekly ride, new time'),
				startsAt: '2026-09-21T18:00:00.000Z'
			},
			writer,
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
				intent: 'update',
				record: validRecord(),
				writer,
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
				intent: 'update',
				rkey: '3abc',
				record: validRecord(),
				writer,
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
			deleteGroupEvent({ db, env, group, callerDid: MEMBER, rkey: '3abc', writer, notify })
		).rejects.toMatchObject({ permission: 'MANAGE_EVENTS' });

		const deleted = await deleteGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			rkey: '3abc',
			writer,
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
			writeGroupEvent({ db, env, group, callerDid: ADMIN, intent: 'create', record: validRecord() })
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
			const refusal = groupWriter(unlinked(), db, group);

			await expect(refusal).rejects.toBeInstanceOf(GroupCredentialError);
			await expect(refusal).rejects.toThrow(/not linked/);
			expect(requests).toEqual([]);
		});

		it('refuses to build an image uploader, and sends nothing', async () => {
			await expect(groupBlobUploader(unlinked(), db, group)).rejects.toBeInstanceOf(
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
			intent: 'update',
			rkey: created.rkey,
			record: validRecord('Weekly ride, new time'),
			writer,
			notify
		});
		await deleteGroupEvent({
			db,
			env,
			group,
			callerDid: ADMIN,
			rkey: created.rkey,
			writer,
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
