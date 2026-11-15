<script lang="ts">
	import { Button, Input } from '@atmo-dev/kit';
	import { goto } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { CALENDAR_NAME_MAX } from '../ids';
	import { createCalendar } from '../private-events.remote';
	import { refusalWords } from './refusal';

	// A group with its own account is the other way to post for a set of people: say so where a calendar
	// is made, if groups are on.
	let { groups = false }: { groups?: boolean } = $props();

	let name = $state('');
	let busy = $state(false);
	let failure: string | null = $state(null);

	async function make(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		failure = null;
		try {
			const { key, actor } = await createCalendar({ name });
			await goto(resolve('/(app)/p/[actor]/calendar/[key]', { actor, key }));
		} catch (e) {
			failure = refusalWords(e);
		} finally {
			busy = false;
		}
	}
</script>

<form class="mt-3 flex max-w-md gap-2" onsubmit={make} data-testid="new-calendar">
	<Input
		name="calendar-name"
		aria-label="Name of the new shared calendar"
		placeholder="Supper club"
		maxlength={CALENDAR_NAME_MAX}
		autocomplete="off"
		bind:value={name}
	/>
	<Button type="submit" size="sm" disabled={busy || !name.trim()}>New shared calendar</Button>
</form>
<p class="text-base-600 dark:text-base-400 mt-2 text-sm" data-testid="new-calendar-what">
	For a few people you invite to your own events. Only you add events or people.
	{#if groups}For a club with its own account, use
		<a href={resolve('/(app)/groups')} class="text-accent-600 dark:text-accent-400 hover:underline"
			>Groups</a
		>.{/if}
</p>
{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-2 text-sm">
		{failure}
	</p>{/if}
