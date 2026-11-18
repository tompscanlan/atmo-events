<script lang="ts">
	// PROTOTYPE of the layout Florian suggested on #105 (2026-11-17): the whole editor at once, the
	// visibility choice under the title where the kit has it, Private as a third option there, and a
	// dialog when choosing Private in place of the lines under the picker. For screenshots only.
	import { Button, Modal, setLinkEmbeds } from '@atmo-dev/kit';
	import { EventEditor, type EventEditorPrefill } from '@atmo-dev/kit/events';
	import { onMount } from 'svelte';
	import { user } from '#lib/atproto/auth.svelte.js';
	import { createInAppAdapter } from '#lib/components/editor/adapter.js';
	import { readPendingImportPrefill } from '#lib/components/CreateEventModal.svelte';
	import PrivateEventAccessNotice from '#lib/private-events/components/PrivateEventAccessNotice.svelte';
	import { createPrivateEventAdapter } from '#lib/private-events/editor-adapter.js';
	import { PRIVATE_LINK_EMBEDS } from '#lib/private-events/embeds.js';
	import { HOST_SCOPES } from '#lib/private-events/scopes.js';

	let { data } = $props();

	let isPrivate = $state(false);
	let asking = $state(false);
	let invited = $derived(data.privateEvents && isPrivate);
	setLinkEmbeds(() => (invited ? PRIVATE_LINK_EMBEDS : {}));

	let viewer = $derived({
		isLoggedIn: user.isLoggedIn,
		canPostToBluesky: user.canPostToBluesky,
		did: user.did ?? null,
		handle: user.profile?.handle,
		displayName: user.profile?.displayName,
		avatar: user.profile?.avatar
	});
	let adapter = $derived.by(() => {
		if (!invited) return createInAppAdapter({ viewer });
		const base = createPrivateEventAdapter({ ...viewer, canPostToBluesky: false });
		// The choice stays under the title, so a host can go back to Public.
		return { ...base, features: { ...base.features, visibility: true } };
	});
	let privateOption = $derived(
		data.privateEvents
			? {
					selected: isPrivate,
					choose: () => (asking = true),
					leave: () => (isPrivate = false)
				}
			: null
	);

	let prefill: EventEditorPrefill | null = $state(null);
	let ready = $state(false);
	onMount(() => {
		const pending = readPendingImportPrefill();
		if (pending) {
			prefill = {
				name: pending.name,
				description: pending.description,
				startsAt: pending.startsAt,
				endsAt: pending.endsAt,
				timezone: pending.timezone,
				mode: pending.mode,
				location: pending.location
			};
		}
		ready = true;
	});
</script>

{#if ready}
	<EventEditor
		eventData={null}
		actorDid={data.actorDid}
		rkey={data.rkey}
		{adapter}
		{viewer}
		{prefill}
		{privateOption}
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
				returnTo="/create?audience=private"
				spacesServer={data.spacesServer}
			/>
		</div>
	{/if}
	<div class="mt-6 flex justify-end gap-2">
		<Button variant="secondary" onclick={() => (asking = false)}>Keep it public</Button>
		<Button
			disabled={!!data.hostAccess}
			onclick={() => {
				isPrivate = true;
				asking = false;
			}}>Make it private</Button
		>
	</div>
</Modal>
