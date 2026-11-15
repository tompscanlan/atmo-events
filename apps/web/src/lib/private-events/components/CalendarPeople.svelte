<script lang="ts">
	import { Button, Input } from '@atmo-dev/kit';
	import { invalidateAll } from '$app/navigation';
	import { page } from '$app/state';
	import { addPersonToCalendar, removePersonFromCalendar } from '../private-events.remote';
	import type { CalendarPerson } from '../server/calendars';
	import { refusalWords } from './refusal';

	let {
		calendarKey,
		people,
		capped
	}: { calendarKey: string; people: CalendarPerson[]; capped: boolean } = $props();

	let handle = $state('');
	let busy = $state(false);
	let failure: string | null = $state(null);
	let copied = $state(false);

	/** One change at a time. The page's data is read again after it, and a refusal shows here. */
	async function change(run: () => Promise<unknown>) {
		busy = true;
		failure = null;
		try {
			await run();
			await invalidateAll();
		} catch (e) {
			failure = refusalWords(e);
		} finally {
			busy = false;
		}
	}

	function add(event: SubmitEvent) {
		event.preventDefault();
		return change(async () => {
			await addPersonToCalendar({ key: calendarKey, handleOrDid: handle });
			handle = '';
		});
	}

	const remove = (did: string) => change(() => removePersonFromCalendar({ key: calendarKey, did }));

	async function copyLink() {
		await navigator.clipboard.writeText(page.url.origin + page.url.pathname);
		copied = true;
	}
</script>

<section data-testid="calendar-people">
	<h2 class="text-base-600 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase">
		People on this calendar
	</h2>
	<p class="text-base-600 dark:text-base-400 text-sm">
		Everyone you add can see every event on this calendar, past and future, and who else is on it.
		Nobody else can. atmo doesn't tell them they were added. The link is the invitation, so send it
		to them yourself. Once they have answered an event, the calendar shows under Calendars for them.
	</p>
	<Button class="mt-2" size="sm" variant="secondary" onclick={copyLink}>
		{copied ? 'Link copied' : 'Copy the link'}
	</Button>
	<form class="mt-3 flex max-w-md gap-2" onsubmit={add}>
		<Input
			name="person-handle"
			aria-label="Handle of the person to add"
			placeholder="alice.bsky.social"
			autocomplete="off"
			bind:value={handle}
		/>
		<Button type="submit" size="sm" disabled={busy || handle.trim().length < 3}>Add</Button>
	</form>
	{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-2 text-sm">
			{failure}
		</p>{/if}
	{#if people.length === 0}
		<p class="text-base-600 dark:text-base-400 mt-3 text-sm">No one else is on it yet.</p>
	{:else}
		<ul class="mt-3 max-w-md space-y-2">
			{#each people as person (person.did)}
				<li class="flex items-center justify-between gap-2 text-sm" data-person={person.did}>
					<span class="text-base-900 dark:text-base-50 min-w-0 truncate font-medium"
						>{person.handle ?? person.did}</span
					>
					<Button size="sm" variant="ghost" disabled={busy} onclick={() => remove(person.did)}
						>Remove</Button
					>
				</li>
			{/each}
		</ul>
	{/if}
	{#if capped}
		<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
			There may be more people on it than these.
		</p>
	{/if}
</section>
