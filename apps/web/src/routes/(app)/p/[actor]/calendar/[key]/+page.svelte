<script lang="ts">
	import { Button, Icon, Input } from '@atmo-dev/kit';
	import { EventCard } from '@atmo-dev/kit/events';
	import { LockKeyhole } from '@sketchyicons/svelte';
	import { goto, invalidateAll } from '$app/navigation';
	import { resolve } from '$app/paths';
	import { atProtoLoginModalState } from '#lib/components/LoginModal.svelte';
	import { BETA_WARNING, BETA_WARNING_SHORT } from '#lib/private-events/beta.js';
	import CalendarPeople from '#lib/private-events/components/CalendarPeople.svelte';
	import PrivateEventAccessNotice from '#lib/private-events/components/PrivateEventAccessNotice.svelte';
	import { refusalWords } from '#lib/private-events/components/changes.svelte.js';
	import { NAMING_TELLS, UNTITLED_CALENDAR } from '#lib/private-events/ids.js';
	import { deleteCalendar, renameCalendar } from '#lib/private-events/private-events.remote.js';
	import { GUEST_SCOPES, HOST_SCOPES } from '#lib/private-events/scopes.js';

	let { data } = $props();

	let renaming = $state(false);
	let newName = $state('');
	let confirmingDelete = $state(false);
	let busy = $state(false);
	let failure: string | null = $state(null);

	async function act(run: () => Promise<unknown>) {
		busy = true;
		failure = null;
		try {
			await run();
		} catch (e) {
			failure = refusalWords(e);
		} finally {
			busy = false;
		}
	}

	function startRename(current: string) {
		newName = current;
		renaming = true;
	}

	function rename(event: SubmitEvent, key: string) {
		event.preventDefault();
		return act(async () => {
			await renameCalendar({ key, name: newName });
			renaming = false;
			await invalidateAll();
		});
	}

	/** The event its space was made for keeps the address it had before the space had a name. */
	function eventHref(actor: string, key: string, rkey: string) {
		return rkey === key
			? resolve('/(app)/p/[actor]/private/[rkey]', { actor, rkey })
			: resolve('/(app)/p/[actor]/calendar/[key]/[rkey]', { actor, key, rkey });
	}

	const remove = (key: string) =>
		act(async () => {
			await deleteCalendar({ key });
			await goto(resolve('/(app)/private'), { invalidateAll: true });
		});
</script>

<svelte:head><meta name="robots" content="noindex" /></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	{#if data.view === 'calendar'}
		{@const calendar = data.calendar}
		{@const name = calendar.name ?? UNTITLED_CALENDAR}
		<p
			class="text-base-600 dark:text-base-400 flex items-center gap-1.5 text-xs font-semibold tracking-wider uppercase"
			data-testid="calendar-private-note"
		>
			<Icon img={LockKeyhole} size={12} />
			Private ·
			<span data-testid="calendar-owner" class="normal-case">
				{#if data.isOwner}
					yours
				{:else}
					<a
						href={resolve('/(app)/p/[actor]', { actor: data.actor })}
						class="text-accent-600 dark:text-accent-400 hover:underline">{data.actor}</a
					>
				{/if}
			</span>
		</p>
		<h1 class="text-base-900 dark:text-base-50 mt-1 text-2xl font-bold">{name}</h1>

		{#if data.isOwner}
			<div class="mt-4 flex flex-wrap items-center gap-2" data-testid="calendar-owner-actions">
				<Button
					size="sm"
					href={`${resolve('/(app)/create')}?audience=calendar&calendar=${encodeURIComponent(calendar.key)}`}
					>New event</Button
				>
				<Button
					size="sm"
					variant="secondary"
					disabled={busy}
					onclick={() => startRename(calendar.name ?? '')}>Rename</Button
				>
				<Button size="sm" variant="ghost" disabled={busy} onclick={() => (confirmingDelete = true)}
					>Delete</Button
				>
			</div>
			{#if renaming}
				<form class="mt-3 flex max-w-md gap-2" onsubmit={(e) => rename(e, calendar.key)}>
					<Input
						name="calendar-name"
						aria-label="The calendar's name"
						maxlength={64}
						autocomplete="off"
						bind:value={newName}
					/>
					<Button type="submit" size="sm" disabled={busy || !newName.trim()}>Save</Button>
					<Button size="sm" variant="ghost" onclick={() => (renaming = false)}>Cancel</Button>
				</form>
				<p class="text-base-600 dark:text-base-400 mt-2 text-sm" data-testid="naming-tells">
					{NAMING_TELLS}
				</p>
			{/if}
			{#if confirmingDelete}
				<div
					class="rounded-ui border-base-200 dark:border-base-800 mt-3 border p-4"
					data-testid="confirm-delete"
				>
					<p class="text-base-700 dark:text-base-300 text-sm">
						Delete {name} and every event on it? Everyone on it loses them at once. This can't be undone.
					</p>
					<div class="mt-3 flex gap-2">
						<Button size="sm" disabled={busy} onclick={() => remove(calendar.key)}
							>Delete it for everyone</Button
						>
						<Button size="sm" variant="ghost" onclick={() => (confirmingDelete = false)}
							>Keep it</Button
						>
					</div>
				</div>
			{/if}
		{/if}
		{#if failure}<p role="alert" class="text-base-950 dark:text-base-50 mt-2 text-sm">
				{failure}
			</p>{/if}

		<section class="mt-8" data-testid="upcoming-events">
			<h2 class="text-base-900 dark:text-base-50 text-lg font-semibold">Upcoming</h2>
			{#if calendar.upcoming.length === 0}
				<p class="text-base-600 dark:text-base-400 mt-2 text-sm">No upcoming events.</p>
			{:else}
				<ul class="mt-3 space-y-3">
					{#each calendar.upcoming as event (event.rkey)}
						<li>
							<EventCard {event} href={eventHref(data.actor, calendar.key, event.rkey)} />
						</li>
					{/each}
				</ul>
			{/if}
		</section>
		{#if calendar.past.length > 0}
			<section class="mt-8" data-testid="past-events">
				<h2 class="text-base-900 dark:text-base-50 text-lg font-semibold">Past</h2>
				<ul class="mt-3 space-y-3">
					{#each calendar.past as event (event.rkey)}
						<li>
							<EventCard {event} href={eventHref(data.actor, calendar.key, event.rkey)} />
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if calendar.eventsCapped}
			<p class="text-base-600 dark:text-base-400 mt-3 text-sm" role="status">
				There may be more events than these.
			</p>
		{/if}

		{#if data.isOwner && calendar.people}
			<div class="mt-10">
				<CalendarPeople
					calendarKey={calendar.key}
					people={calendar.people}
					capped={calendar.peopleCapped}
				/>
			</div>
		{:else if calendar.people}
			<section class="mt-10" data-testid="calendar-people-shown">
				<h2
					class="text-base-600 dark:text-base-400 mb-3 text-xs font-semibold tracking-wider uppercase"
				>
					People ({calendar.people.length})
				</h2>
				<ul class="max-w-md space-y-2">
					{#each calendar.people as person (person.did)}
						<li class="text-base-900 dark:text-base-50 truncate text-sm font-medium">
							{person.handle ?? person.did}
						</li>
					{/each}
				</ul>
				{#if calendar.peopleCapped}
					<p class="text-base-600 dark:text-base-400 mt-2 text-sm" role="status">
						There may be more people on it than these.
					</p>
				{/if}
				<p class="text-base-600 dark:text-base-400 mt-3 text-xs">
					Everyone here sees every event and each other. Only the owner changes who's here.
				</p>
			</section>
		{/if}
		<p class="text-base-500 mt-10 text-xs" data-testid="beta-notice">{BETA_WARNING_SHORT}</p>
	{:else}
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Shared calendar</h1>
		<p class="text-base-600 dark:text-base-400 mt-2 text-sm" data-testid="beta-notice">
			{BETA_WARNING}
		</p>
		{#if data.view === 'signed-out'}
			<p class="text-base-600 dark:text-base-400 mt-2">Sign in to see whether you're on it.</p>
			<Button class="mt-4" onclick={() => atProtoLoginModalState.show()}>Sign in</Button>
		{:else}
			<PrivateEventAccessNotice
				access={data.access}
				did={data.did}
				scopes={data.isOwner ? HOST_SCOPES : GUEST_SCOPES}
				purpose={data.isOwner
					? 'Your sign-in no longer lets atmo open your private events. Allow it again to see this calendar and the people on it.'
					: 'Shared calendars are kept on the owner’s server. atmo needs your permission to open them for you and save your answers in your own account.'}
				label={data.isOwner ? 'Allow atmo again' : 'Allow atmo to open private events'}
				spacesServer={data.spacesServer}
			/>
		{/if}
	{/if}
</div>
