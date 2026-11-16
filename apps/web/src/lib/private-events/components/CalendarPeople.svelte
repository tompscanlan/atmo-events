<script lang="ts">
	import { Button, Input } from '@atmo-dev/kit';
	import { addPersonToCalendar, removePersonFromCalendar } from '../private-events.remote';
	import type { CalendarPerson } from '../server/calendars';
	import { PeopleEditor } from './changes.svelte';

	let {
		calendarKey,
		people,
		capped
	}: { calendarKey: string; people: CalendarPerson[]; capped: boolean } = $props();

	const editor = new PeopleEditor(
		(handleOrDid) => addPersonToCalendar({ key: calendarKey, handleOrDid }),
		(did) => removePersonFromCalendar({ key: calendarKey, did })
	);
</script>

<section data-testid="calendar-people">
	<h2 class="text-base-600 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase">
		People ({people.length})
	</h2>
	{#if people.length === 0}
		<p class="text-base-600 dark:text-base-400 text-sm">No one else yet.</p>
	{:else}
		<ul class="max-w-md space-y-1">
			{#each people as person (person.did)}
				<li class="flex items-center justify-between gap-2 text-sm" data-person={person.did}>
					<span class="text-base-900 dark:text-base-50 min-w-0 truncate font-medium"
						>{person.handle ?? person.did}</span
					>
					<Button
						size="sm"
						variant="ghost"
						disabled={editor.busy}
						onclick={() => editor.remove(person.did)}>Remove</Button
					>
				</li>
			{/each}
		</ul>
	{/if}
	{#if capped}
		<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
			There may be more people than these.
		</p>
	{/if}
	<form class="mt-4 flex max-w-md gap-2" onsubmit={editor.add}>
		<Input
			name="person-handle"
			aria-label="Handle of the person to add"
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
	<div
		class="rounded-ui border-base-200 dark:border-base-800 mt-4 flex max-w-md items-center justify-between gap-3 border p-3"
	>
		<p class="text-base-700 dark:text-base-300 text-sm">
			atmo doesn't notify people you add. Send them the link.
		</p>
		<Button class="shrink-0" size="sm" variant="secondary" onclick={editor.copyLink}>
			{editor.copied ? 'Link copied' : 'Copy link'}
		</Button>
	</div>
	<p class="text-base-600 dark:text-base-400 mt-3 max-w-md text-xs">
		People here see every event, past and future, and each other. Nobody else can.
	</p>
</section>
