<script lang="ts">
	import { Button, Input } from '@atmo-dev/kit';
	import { invalidateAll } from '$app/navigation';
	import { CALENDAR_NAME_MAX, NAMING_TELLS } from '../ids';
	import { renameCalendar } from '../private-events.remote';
	import { refusalWords } from './changes.svelte';

	// For the host of a single event: naming its space makes its guests a shared calendar, to put
	// later events on. Nothing moves: the event, its guests and their answers stay where they are.
	let { spaceKey }: { spaceKey: string } = $props();

	let open = $state(false);
	let name = $state('');
	let busy = $state(false);
	let failure: string | null = $state(null);

	async function save(event: SubmitEvent) {
		event.preventDefault();
		busy = true;
		failure = null;
		try {
			await renameCalendar({ key: spaceKey, name });
			await invalidateAll();
		} catch (e) {
			failure = refusalWords(e);
		} finally {
			busy = false;
		}
	}
</script>

<section data-testid="save-as-calendar">
	{#if !open}
		<Button class="w-full" size="sm" variant="secondary" onclick={() => (open = true)}
			>Save these people as a shared calendar</Button
		>
	{:else}
		<form class="flex gap-2" onsubmit={save}>
			<Input
				name="calendar-name"
				aria-label="Name of the shared calendar"
				placeholder="Supper club"
				maxlength={CALENDAR_NAME_MAX}
				autocomplete="off"
				bind:value={name}
			/>
			<Button type="submit" size="sm" disabled={busy || !name.trim()}>Save</Button>
			<Button size="sm" variant="ghost" onclick={() => (open = false)}>Cancel</Button>
		</form>
		<p class="text-base-600 dark:text-base-400 mt-2 text-sm" data-testid="naming-tells">
			Put later events on it for the same people. {NAMING_TELLS}
		</p>
	{/if}
	{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-2 text-sm">
			{failure}
		</p>{/if}
</section>
