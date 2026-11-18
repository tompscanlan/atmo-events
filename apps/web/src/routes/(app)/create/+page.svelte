<script lang="ts">
	import { Button, Modal, setLinkEmbeds } from '@atmo-dev/kit';
	import { EventEditor, type EventEditorPrefill } from '@atmo-dev/kit/events';
	import type { EventVisibility } from '@atmo-dev/kit/events-data';
	import { onMount } from 'svelte';
	import { user } from '#lib/atproto/auth.svelte.js';
	import { createInAppAdapter } from '#lib/components/editor/adapter.js';
	import { readPendingImportPrefill } from '#lib/components/CreateEventModal.svelte';
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import PrivateEventAccessNotice from '#lib/private-events/components/PrivateEventAccessNotice.svelte';
	import { createPrivateEventAdapter } from '#lib/private-events/editor-adapter.js';
	import { PRIVATE_LINK_EMBEDS } from '#lib/private-events/embeds.js';
	import { HOST_SCOPES } from '#lib/private-events/scopes.js';

	let { data } = $props();

	const PRIVATE = 'private';
	// Coming back from the permission step, the host already chose Private; if the permission still
	// isn't there, they choose again and the dialog offers it again.
	const wantsPrivate = page.url.searchParams.get('audience') === PRIVATE;
	let visibility = $state<EventVisibility>(
		// svelte-ignore state_referenced_locally
		wantsPrivate && data.privateEvents && !data.hostAccess ? PRIVATE : 'public'
	);
	let invited = $derived(data.privateEvents && visibility === PRIVATE);
	// A private event's description loads nothing by itself, here as on its page; a public one is as before.
	setLinkEmbeds(() => (invited ? PRIVATE_LINK_EMBEDS : {}));

	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		canPostToBluesky: user.canPostToBluesky,
		did: user.did ?? null,
		handle: user.profile?.handle,
		displayName: user.profile?.displayName,
		avatar: user.profile?.avatar
	});
	// The editor stays mounted when the choice changes, so what the host typed stays; only where it
	// is saved changes. The switch stays, so a host can go back to Public.
	let adapter = $derived.by(() => {
		if (!invited) return createInAppAdapter({ viewer });
		const base = createPrivateEventAdapter({ ...viewer, canPostToBluesky: false });
		return { ...base, features: { ...base.features, visibility: true } };
	});

	// Choosing Private asks first, in a dialog; the switch changes only on "Make it private".
	let asking = $state(false);
	let answer: ((ok: boolean) => void) | null = null;
	function confirmVisibility(next: EventVisibility): boolean | Promise<boolean> {
		if (next !== PRIVATE) return true;
		asking = true;
		return new Promise((done) => (answer = done));
	}
	function decide(ok: boolean) {
		asking = false;
		answer?.(ok);
		answer = null;
	}
	// Closing the dialog any other way keeps the current choice.
	$effect(() => {
		if (!asking && answer) decide(false);
	});

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

{#if wantsPrivate && !data.privateEvents}
	<!-- What someone meant to keep private must never be posted publicly, so no editor here. -->
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
{:else if ready}
	<EventEditor
		eventData={null}
		actorDid={data.actorDid}
		rkey={data.rkey}
		{adapter}
		{viewer}
		{prefill}
		visibilityOptions={data.privateEvents ? ['public', 'unlisted', PRIVATE] : undefined}
		{confirmVisibility}
		bind:visibility
	/>
{/if}

<Modal bind:open={asking} title="Make this event private?">
	<ul class="text-base-700 dark:text-base-300 mt-2 list-disc space-y-1.5 pl-5 text-sm">
		<li>Private events are an alpha version. Use them at your own risk.</li>
		<li>A private event can't be made public later.</li>
		<li>Only people you invite by handle can see it.</li>
	</ul>
	{#if data.hostAccess}
		<div class="mt-4">
			<PrivateEventAccessNotice
				access={data.hostAccess}
				did={data.actorDid}
				scopes={HOST_SCOPES}
				purpose="A private event is kept on your own server. atmo needs your permission to create it there and manage its guest list."
				label="Allow atmo to host private events"
				returnTo="/create?audience={PRIVATE}"
				spacesServer={data.spacesServer}
			/>
		</div>
	{/if}
	<div class="mt-6 flex justify-end gap-2">
		<Button variant="secondary" onclick={() => decide(false)}>Keep it public</Button>
		<Button disabled={!!data.hostAccess} onclick={() => decide(true)}>Make it private</Button>
	</div>
</Modal>
