<script lang="ts">
	import { Button, Input } from '@atmo-dev/kit';
	import { ANSWER_WORDS } from '../ids';
	import { addGuest, removeGuest } from '../private-events.remote';
	import type { Guest } from '../server/events';
	import { PeopleEditor } from './changes.svelte';

	let {
		rkey,
		guests,
		capped = false
	}: { rkey: string; guests: Guest[]; capped?: boolean } = $props();

	const editor = new PeopleEditor(
		(handleOrDid) => addGuest({ rkey, handleOrDid }),
		(did) => removeGuest({ rkey, did })
	);

	function answerWords(guest: Guest): string {
		if (guest.answer) return ANSWER_WORDS[guest.answer];
		return guest.answerUnread ? "Their answer couldn't be read" : "Added, hasn't answered";
	}
</script>

<section data-testid="guest-list">
	<h2 class="text-base-600 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase">
		Guests
	</h2>
	<p class="text-base-600 dark:text-base-400 text-sm">
		Only people you add can see this event. atmo doesn't tell them they were added, and nothing
		shows on their side until they open the link. The link is the invitation, so send it to them
		yourself.
	</p>
	<Button class="mt-2 w-full" size="sm" variant="secondary" onclick={editor.copyLink}>
		{editor.copied ? 'Link copied' : 'Copy the link'}
	</Button>
	<form class="mt-3 flex gap-2" onsubmit={editor.add}>
		<Input
			name="guest-handle"
			aria-label="Guest's handle"
			placeholder="alice.bsky.social"
			autocomplete="off"
			bind:value={editor.handle}
		/>
		<Button type="submit" size="sm" disabled={editor.busy || editor.handle.trim().length < 3}
			>Add</Button
		>
	</form>
	{#if editor.failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-2 text-sm">
			{editor.failure}
		</p>{/if}
	{#if guests.length === 0}
		<p class="text-base-600 dark:text-base-400 mt-3 text-sm">No guests yet.</p>
	{:else}
		<ul class="mt-3 space-y-2">
			{#each guests as guest (guest.did)}
				<li class="flex items-center justify-between gap-2 text-sm" data-guest={guest.did}>
					<span class="min-w-0">
						<span class="text-base-900 dark:text-base-50 block truncate font-medium"
							>{guest.handle ?? guest.did}</span
						>
						<span class="text-base-600 dark:text-base-400 block text-xs">{answerWords(guest)}</span>
					</span>
					<Button
						size="sm"
						variant="ghost"
						disabled={editor.busy}
						onclick={() => editor.remove(guest.did)}>Remove</Button
					>
				</li>
			{/each}
		</ul>
	{/if}
	{#if capped}
		<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
			There may be more guests than these.
		</p>
	{/if}
</section>
