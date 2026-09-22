<script lang="ts">
	import { Badge, Button, Input, Label } from '@foxui/core';
	import { EventCard, type FlatEventRecord } from '@atmo-dev/events-ui';
	import { deleteGroupEventForm, saveGroupEventForm } from '$lib/groups/groups.remote';
	import type { GroupEventRecord } from '$lib/groups/types';
	import { ADDRESS_TYPE } from '$lib/groups/event-record';
	import { groupFormError } from '$lib/groups/form-result';
	import { resolve } from '$app/paths';

	let { data } = $props();

	let group = $derived(data.group);
	// The group's name is a RECORD, not a column: the loader reads it from the
	// about space so this tab cannot show a name the group page contradicts.
	let groupName = $derived(data.groupName);
	/** Which event's edit form is open, by rkey. Co-editing is the point of this
	 *  page: any MANAGE_EVENTS holder edits any of them, because they are all the
	 *  GROUP's records, not each admin's. */
	let editing = $state<string | null>(null);
	let creating = $state(false);
	let saveError = $derived(groupFormError(saveGroupEventForm.result));
	/** The DID the record actually landed under, shown as the proof that the
	 *  GROUP authored it and not the admin who pressed the button. */
	let savedAuthor = $derived(
		saveGroupEventForm.result?.ok === true ? saveGroupEventForm.result.repo : null
	);
	let deleteError = $derived(groupFormError(deleteGroupEventForm.result));

	/** The group's records rendered as the cards the rest of the app uses. `did`
	 *  is the GROUP's, which is what makes the card's link resolve to the group's
	 *  event page rather than an admin's. */
	function toCard(event: GroupEventRecord): FlatEventRecord {
		return {
			...(event.value as unknown as FlatEventRecord),
			did: group.group_did,
			rkey: event.rkey,
			uri: event.uri,
			cid: event.cid || null
		};
	}

	/** `datetime-local` wants `YYYY-MM-DDTHH:mm`. The stored value is UTC and the
	 *  fields are labelled UTC, so this is a slice, not a conversion. */
	function forInput(value: unknown): string {
		return typeof value === 'string' ? value.slice(0, 16) : '';
	}

	function text(value: unknown): string {
		return typeof value === 'string' ? value : '';
	}

	/** The address the group's record carries, for the edit form to post back.
	 *  The record is rebuilt from the form's fields on every save, so a location
	 *  the form does not carry is a location the edit would drop. */
	function address(event: GroupEventRecord): { name?: string; country?: string } {
		const locations = Array.isArray(event.value.locations) ? event.value.locations : [];
		return (
			(locations.find((entry) => (entry as { $type?: string })?.$type === ADDRESS_TYPE) as
				| { name?: string; country?: string }
				| undefined) ?? {}
		);
	}
</script>

<svelte:head><title>{groupName} events — atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<a
		href={resolve('/(app)/groups/[actor]', { actor: group.group_did })}
		class="text-base-500 dark:text-base-400 mb-4 inline-block text-sm hover:underline"
		>← {groupName}</a
	>

	<div class="mb-2 flex flex-wrap items-center justify-between gap-4">
		<h1 class="text-3xl font-bold">Events</h1>
		{#if data.canCreateEvent}
			<Button onclick={() => (creating = !creating)}>
				{creating ? 'Cancel' : 'New group event'}
			</Button>
		{/if}
	</div>
	<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
		Published as <span class="font-mono">{group.group_did}</span> — the group is the author, not whoever
		pressed the button.
	</p>

	{#if creating}
		<form
			{...saveGroupEventForm}
			class="ring-base-200 dark:ring-base-800 mb-8 rounded-2xl p-4 ring-1"
		>
			<input type="hidden" name="groupDid" value={group.group_did} />
			<div class="flex flex-col gap-4">
				<div class="flex flex-col gap-1.5">
					<Label for="new-name">Name</Label>
					<Input id="new-name" name="name" required maxlength={300} />
				</div>
				<div class="grid gap-4 sm:grid-cols-2">
					<div class="flex flex-col gap-1.5">
						<Label for="new-starts">Starts (UTC)</Label>
						<Input id="new-starts" name="startsAt" type="datetime-local" required />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="new-ends">Ends (UTC)</Label>
						<Input id="new-ends" name="endsAt" type="datetime-local" />
					</div>
				</div>
				<div class="grid gap-4 sm:grid-cols-[2fr_1fr]">
					<div class="flex flex-col gap-1.5">
						<Label for="new-location">Location</Label>
						<Input id="new-location" name="locationName" maxlength={300} />
					</div>
					<div class="flex flex-col gap-1.5">
						<Label for="new-country">Country</Label>
						<Input id="new-country" name="locationCountry" maxlength={10} placeholder="US" />
						<p class="text-base-500 dark:text-base-400 text-xs">
							Needed to publish the location — an address without a country is not a valid calendar
							address, so it is left off the event.
						</p>
					</div>
				</div>
				<div class="flex flex-col gap-1.5">
					<Label for="new-description">Description</Label>
					<textarea
						id="new-description"
						name="description"
						rows="3"
						class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
					></textarea>
				</div>
				<div><Button type="submit">Publish as the group</Button></div>
			</div>
		</form>
	{/if}

	{#if saveError}
		<p class="mb-6 text-sm text-red-600 dark:text-red-400">{saveError}</p>
	{:else if savedAuthor}
		<p class="text-base-500 dark:text-base-400 mb-6 text-sm">
			Saved. Author: <span class="font-mono">{savedAuthor}</span>
		</p>
	{/if}
	{#if deleteError}
		<p class="mb-6 text-sm text-red-600 dark:text-red-400">{deleteError}</p>
	{/if}

	{#if data.events.length === 0}
		<div class="py-16 text-center">
			<p class="text-base-500 dark:text-base-400 text-lg">This group has no public events yet.</p>
		</div>
	{:else}
		<div class="flex flex-col gap-6">
			{#each data.events as event (event.rkey)}
				<div>
					<EventCard event={toCard(event)} actor={group.group_did} />
					{#if data.canManageEvents}
						<div class="mt-2 flex items-center gap-3">
							<button
								type="button"
								class="text-base-500 dark:text-base-400 text-sm hover:underline"
								onclick={() => (editing = editing === event.rkey ? null : event.rkey)}
							>
								{editing === event.rkey ? 'Cancel' : 'Edit'}
							</button>
							<form {...deleteGroupEventForm}>
								<input type="hidden" name="groupDid" value={group.group_did} />
								<input type="hidden" name="rkey" value={event.rkey} />
								<button type="submit" class="text-sm text-red-600 hover:underline dark:text-red-400"
									>Delete</button
								>
							</form>
							<Badge variant="secondary">{event.rkey}</Badge>
						</div>

						{#if editing === event.rkey}
							<form
								{...saveGroupEventForm}
								class="ring-base-200 dark:ring-base-800 mt-3 rounded-2xl p-4 ring-1"
							>
								<input type="hidden" name="groupDid" value={group.group_did} />
								<input type="hidden" name="rkey" value={event.rkey} />
								<input type="hidden" name="createdAt" value={text(event.value.createdAt)} />
								<div class="flex flex-col gap-4">
									<div class="flex flex-col gap-1.5">
										<Label for="edit-name-{event.rkey}">Name</Label>
										<Input
											id="edit-name-{event.rkey}"
											name="name"
											value={text(event.value.name)}
											required
										/>
									</div>
									<div class="grid gap-4 sm:grid-cols-2">
										<div class="flex flex-col gap-1.5">
											<Label for="edit-starts-{event.rkey}">Starts (UTC)</Label>
											<Input
												id="edit-starts-{event.rkey}"
												name="startsAt"
												type="datetime-local"
												value={forInput(event.value.startsAt)}
												required
											/>
										</div>
										<div class="flex flex-col gap-1.5">
											<Label for="edit-ends-{event.rkey}">Ends (UTC)</Label>
											<Input
												id="edit-ends-{event.rkey}"
												name="endsAt"
												type="datetime-local"
												value={forInput(event.value.endsAt)}
											/>
										</div>
									</div>
									<div class="grid gap-4 sm:grid-cols-[2fr_1fr]">
										<div class="flex flex-col gap-1.5">
											<Label for="edit-location-{event.rkey}">Location</Label>
											<Input
												id="edit-location-{event.rkey}"
												name="locationName"
												maxlength={300}
												value={address(event).name ?? ''}
											/>
										</div>
										<div class="flex flex-col gap-1.5">
											<Label for="edit-country-{event.rkey}">Country</Label>
											<Input
												id="edit-country-{event.rkey}"
												name="locationCountry"
												maxlength={10}
												placeholder="US"
												value={address(event).country ?? ''}
											/>
										</div>
									</div>
									<div class="flex flex-col gap-1.5">
										<Label for="edit-description-{event.rkey}">Description</Label>
										<textarea
											id="edit-description-{event.rkey}"
											name="description"
											rows="3"
											class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
											>{text(event.value.description)}</textarea
										>
									</div>
									<div><Button type="submit">Save as the group</Button></div>
								</div>
							</form>
						{/if}
					{/if}
				</div>
			{/each}
		</div>
	{/if}
</div>
