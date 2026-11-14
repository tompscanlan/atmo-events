<script lang="ts">
	import { ToggleGroup, ToggleGroupItem } from '@atmo-dev/kit';
	import { EventEditor, type EventEditorPrefill } from '@atmo-dev/kit/events';
	import { onMount } from 'svelte';
	import { user } from '#lib/atproto/auth.svelte.js';
	import { createInAppAdapter } from '#lib/components/editor/adapter.js';
	import { readPendingImportPrefill } from '#lib/components/CreateEventModal.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import PrivateEventAccessNotice from '#lib/private-events/components/PrivateEventAccessNotice.svelte';
	import { createPrivateEventAdapter } from '#lib/private-events/editor-adapter.js';
	import { UNTITLED_CALENDAR } from '#lib/private-events/ids.js';
	import { HOST_SCOPES } from '#lib/private-events/scopes.js';

	let { data } = $props();

	// No default where there's a choice: a public post can't be taken back. Coming back from the
	// permission step, the choice is already made, and a calendar's page can name the calendar.
	const INVITED = 'invited';
	const CALENDAR = 'calendar';
	type Audience = 'everyone' | typeof INVITED | typeof CALENDAR;
	const asked = page.url.searchParams.get('audience');
	const askedPrivate = asked === INVITED;
	let audience = $state<Audience | null>(asked === INVITED || asked === CALENDAR ? asked : null);
	let picked = $state(page.url.searchParams.get('calendar') ?? '');
	// The one picked, or else the first, so the picker never shows one it isn't using.
	let calendar = $derived(
		data.calendars.find((c) => c.key === picked)?.key ?? data.calendars[0]?.key ?? null
	);
	let invited = $derived(data.privateEvents && audience === INVITED);
	let onCalendar = $derived(data.privateEvents && audience === CALENDAR && calendar !== null);
	// With private events off, the editor is the public one, so a link that asked for a private
	// audience gets no editor at all: what someone meant to keep private must never be posted publicly.
	let chosen = $derived(
		(!data.privateEvents && !askedPrivate) || audience === 'everyone' || invited || onCalendar
	);

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
					() => audience ?? '',
					(value) => {
						if (value === 'everyone' || value === INVITED || value === CALENDAR) audience = value;
					}
				}
			>
				<ToggleGroupItem value="everyone">Everyone</ToggleGroupItem>
				<ToggleGroupItem value={INVITED}>Invited people only</ToggleGroupItem>
				{#if data.calendars.length > 0}
					<ToggleGroupItem value={CALENDAR}
						>Only the people on one of your shared calendars</ToggleGroupItem
					>
				{/if}
			</ToggleGroup>
			{#if onCalendar}
				<label class="text-base-700 dark:text-base-300 mt-3 flex items-center gap-2 text-sm">
					Calendar
					<select
						name="calendar"
						value={calendar}
						onchange={(event) => (picked = event.currentTarget.value)}
						class="border-base-300 dark:border-base-700 bg-base-50 dark:bg-base-900 rounded-lg border px-2 py-1.5 text-sm"
					>
						{#each data.calendars as option (option.key)}
							<option value={option.key}>{option.name ?? UNTITLED_CALENDAR}</option>
						{/each}
					</select>
				</label>
			{/if}
			<ul class="text-base-600 dark:text-base-400 mt-3 space-y-1 text-sm">
				<li>
					<span class="text-base-900 dark:text-base-50 font-medium">Everyone:</span> anyone can see it,
					and it can't be made private later.
				</li>
				<li>
					<span class="text-base-900 dark:text-base-50 font-medium">Invited people only:</span> only people
					you add can see it, and it can't be made public later. It has no image or repeats for now.
				</li>
				{#if data.calendars.length > 0}
					<li>
						<span class="text-base-900 dark:text-base-50 font-medium">A shared calendar:</span> only the
						people on the calendar you pick can see it, now and later, and it can't be made public later.
						It has no image or repeats for now.
					</li>
				{/if}
			</ul>
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
{:else if askedPrivate}
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
	{#key `${audience}:${onCalendar ? calendar : ''}`}
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
