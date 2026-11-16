<script lang="ts">
	import { setLinkEmbeds, ToggleGroup, ToggleGroupItem } from '@atmo-dev/kit';
	import { EventEditor, type EventEditorPrefill } from '@atmo-dev/kit/events';
	import { onMount } from 'svelte';
	import { user } from '#lib/atproto/auth.svelte.js';
	import { createInAppAdapter, type EditorAdapter } from '#lib/components/editor/adapter.js';
	import { readPendingImportPrefill } from '#lib/components/CreateEventModal.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import PrivateEventAccessNotice from '#lib/private-events/components/PrivateEventAccessNotice.svelte';
	import { createPrivateEventAdapter } from '#lib/private-events/editor-adapter.js';
	import { PRIVATE_LINK_EMBEDS } from '#lib/private-events/embeds.js';
	import { UNTITLED_CALENDAR } from '#lib/private-events/ids.js';
	import { HOST_SCOPES } from '#lib/private-events/scopes.js';

	let { data } = $props();

	// No default where there's a choice: a public post can't be taken back. Coming back from the
	// permission step, the choice is already made, and a calendar's page can name the calendar.
	const INVITED = 'invited';
	const CALENDAR = 'calendar';
	const UNLISTED = 'unlisted';
	// The picker's own value while a calendar was asked for and isn't among the host's, so that
	// choosing "Just this event" is a change the browser reports.
	const NOT_PICKED = 'not-picked';
	type Audience = 'everyone' | typeof UNLISTED | typeof INVITED | typeof CALENDAR;
	const asked = page.url.searchParams.get('audience');
	const askedPrivate = asked === INVITED || asked === CALENDAR;
	let audience = $state<Audience | null>(askedPrivate ? asked : null);
	let picked = $state(page.url.searchParams.get('calendar') ?? '');
	// The first when none is named, so the picker never shows one it isn't using. One named but not
	// among the host's picks nothing: an event goes only to the people the host chose.
	let calendar = $derived(
		picked === ''
			? (data.calendars[0]?.key ?? null)
			: (data.calendars.find((c) => c.key === picked)?.key ?? null)
	);
	let isPublic = $derived(audience === 'everyone' || audience === UNLISTED);
	// The host's last choice, not only the link's: private events can turn off mid-edit.
	let wantsPrivate = $derived(audience === INVITED || audience === CALENDAR);
	let invited = $derived(data.privateEvents && audience === INVITED);
	let onCalendar = $derived(data.privateEvents && audience === CALENDAR && calendar !== null);
	let calendarMissing = $derived(data.privateEvents && audience === CALENDAR && calendar === null);
	// With private events off, the editor is the public one, so a private audience, asked for by a
	// link or chosen here, gets no editor at all: what someone meant to keep private must never be
	// posted publicly.
	// A private event's description loads nothing by itself, here as on its page; a public one is as before.
	setLinkEmbeds(() => (invited || onCalendar ? PRIVATE_LINK_EMBEDS : {}));
	let chosen = $derived(
		(!data.privateEvents && !wantsPrivate) || isPublic || invited || onCalendar
	);

	const PRIVATE_LIMITS = " Private events can't have an image or repeat yet.";

	// Public or Unlisted is asked once, at the top, so the editor's own switch is off and the answer
	// is written into the record here, the way the editor would have.
	function listedAs(base: EditorAdapter, listed: boolean): EditorAdapter {
		const mark = <T extends { record: Record<string, unknown> }>(opts: T): T => ({
			...opts,
			record: {
				...opts.record,
				preferences: { ...(opts.record.preferences as object | undefined), showInDiscovery: listed }
			}
		});
		return {
			...base,
			features: { ...base.features, visibility: false },
			putRecord: (opts) => base.putRecord(mark(opts)),
			createRecord: (opts) => base.createRecord(mark(opts))
		};
	}

	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		canPostToBluesky: user.canPostToBluesky,
		did: user.did ?? null,
		handle: user.profile?.handle,
		displayName: user.profile?.displayName,
		avatar: user.profile?.avatar
	});
	let adapter = $derived(
		onCalendar
			? createPrivateEventAdapter({ ...viewer, canPostToBluesky: false }, calendar ?? undefined)
			: invited
				? createPrivateEventAdapter({ ...viewer, canPostToBluesky: false })
				: data.privateEvents
					? listedAs(createInAppAdapter({ viewer }), audience !== UNLISTED)
					: createInAppAdapter({ viewer })
	);

	// Pulled out of sessionStorage on mount so the editor sees it on its first
	// pass. EventEditor only reads `prefill` in its own onMount, so we gate
	// rendering until after this runs.
	let prefill: EventEditorPrefill | null = $state(null);
	let ready = $state(false);
	onMount(async () => {
		const pending = readPendingImportPrefill();
		if (!pending) {
			ready = true;
			return;
		}
		let thumbnailFile: File | undefined;
		if (pending.imageDataUrl) {
			try {
				const blob = await (await fetch(pending.imageDataUrl)).blob();
				const ext = (blob.type.split('/')[1] || 'jpg').split('+')[0];
				thumbnailFile = new File([blob], `imported-cover.${ext}`, { type: blob.type });
			} catch (err) {
				console.error('Could not decode imported cover image:', err);
			}
		}
		prefill = {
			name: pending.name,
			description: pending.description,
			startsAt: pending.startsAt,
			endsAt: pending.endsAt,
			timezone: pending.timezone,
			mode: pending.mode,
			location: pending.location,
			links: pending.links,
			additionalData: pending.additionalData,
			...(thumbnailFile ? { thumbnailFile } : {})
		};
		ready = true;
	});
</script>

{#if data.privateEvents}
	<div class="px-6 pt-12" data-testid="audience">
		<div class="mx-auto max-w-3xl">
			<h2 id="audience-heading" class="text-base-900 dark:text-base-50 text-lg font-semibold">
				Who can see this event?
			</h2>
			<ToggleGroup
				aria-labelledby="audience-heading"
				class="mt-3 w-fit"
				bind:value={
					() => (audience === null ? '' : isPublic ? (audience as string) : 'private'),
					(value) => {
						if (value === 'everyone' || value === UNLISTED) audience = value;
						else if (value === 'private' && (audience === null || isPublic)) audience = INVITED;
					}
				}
			>
				<ToggleGroupItem value="everyone">Public</ToggleGroupItem>
				<ToggleGroupItem value={UNLISTED}>Unlisted</ToggleGroupItem>
				<ToggleGroupItem value="private">Private</ToggleGroupItem>
			</ToggleGroup>
			{#if audience !== null}
				<p class="text-base-700 dark:text-base-300 mt-3 text-sm" data-testid="audience-what">
					{audience === 'everyone'
						? 'Anyone can see it, and it shows in search and listings.'
						: audience === UNLISTED
							? "Anyone with the link can see it. It doesn't show in search or listings."
							: audience === INVITED
								? 'Only people you invite can see it. You add them after publishing.'
								: 'Only people you invite can see it.'}
				</p>
			{/if}
			{#if calendarMissing}
				<p class="text-base-700 dark:text-base-300 mt-3 text-sm" data-testid="calendar-missing">
					That one isn't among yours just now, so nothing is picked.
					{#if data.calendars.length > 0}Pick below, or reload to try again.{:else}Reload to try
						again.{/if}
				</p>
			{/if}
			{#if (audience === INVITED || audience === CALENDAR) && data.calendars.length > 0}
				<label class="text-base-700 dark:text-base-300 mt-4 flex items-center gap-2 text-sm">
					Who's invited?
					<select
						name="calendar"
						value={calendarMissing ? NOT_PICKED : audience === CALENDAR ? (calendar ?? '') : ''}
						onchange={(event) => {
							const key = event.currentTarget.value;
							if (key === '') audience = INVITED;
							else {
								picked = key;
								audience = CALENDAR;
							}
						}}
						class="border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 rounded-lg border px-2 py-1.5 text-sm"
					>
						{#if calendarMissing}
							<option value={NOT_PICKED} disabled>Pick who's invited</option>
						{/if}
						<option value="">Just this event</option>
						{#each data.calendars as option (option.key)}
							<option value={option.key}>Everyone on {option.name ?? UNTITLED_CALENDAR}</option>
						{/each}
					</select>
				</label>
				{#if data.calendarsCapped}
					<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
						There may be more than these. To use another, start from its own page.
					</p>
				{/if}
			{/if}
			{#if audience !== null}
				<p class="text-base-600 dark:text-base-400 mt-3 text-xs" data-testid="audience-fine-print">
					{#if audience === INVITED || audience === CALENDAR}A private event can't be made public
						later.{PRIVATE_LIMITS}{:else}A public or unlisted event can't be made private later.{/if}
				</p>
			{/if}
			{#if invited && data.hostAccess}
				<PrivateEventAccessNotice
					access={data.hostAccess}
					did={data.actorDid}
					scopes={HOST_SCOPES}
					purpose="A private event is kept on your own server. atmo needs your permission to create it there and manage its guest list."
					label="Allow atmo to host private events"
					returnTo="/create?audience={INVITED}"
					spacesServer={data.spacesServer}
				/>
			{/if}
		</div>
	</div>
{:else if wantsPrivate}
	<div class="px-6 pt-12" data-testid="private-off">
		<p class="text-base-700 dark:text-base-300 mx-auto max-w-3xl text-sm">
			Private events are off for you right now, so this page can't make a private event. Turn on
			private events in
			<a
				href={resolve('/(app)/settings')}
				class="text-accent-600 dark:text-accent-400 hover:underline">Settings</a
			>, or reload to try again.
		</p>
	</div>
{/if}

{#if ready && chosen && !(invited && data.hostAccess)}
	{#key `${isPublic ? 'public' : audience}:${onCalendar ? calendar : ''}`}
		<EventEditor
			eventData={null}
			actorDid={data.actorDid}
			rkey={data.rkey}
			{adapter}
			{viewer}
			{prefill}
		/>
	{/key}
{/if}
