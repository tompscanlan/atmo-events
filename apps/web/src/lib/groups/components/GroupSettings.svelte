<script lang="ts">
	import { Button, Input, Label } from '@foxui/core';
	import { GROUP_JOIN_POLICIES, type GroupJoinPolicy } from '../about-record';
	import { groupFormError, resetOnSuccess } from '../form-result';
	import { updateGroupForm } from '../group.remote';
	import type { GroupVisibility } from '../types';
	import { FIELD_CLASS } from './field-class';
	import GroupLinkForm from './GroupLinkForm.svelte';

	// An admin's settings for a group, folded away until asked for.
	let {
		groupDid,
		about,
		visibility,
		listed,
		groupLinked,
		linkOutcome
	}: {
		groupDid: string;
		about: { name: string; description: string | null; joinPolicy: GroupJoinPolicy | null };
		/** Null when the host could not be asked. */
		visibility: GroupVisibility | null;
		listed: boolean;
		groupLinked: boolean | null;
		linkOutcome: string | null;
	} = $props();

	const JOIN_LABELS: Record<GroupJoinPolicy, string> = {
		open: 'Anyone can join',
		approval: 'Anyone can ask; an admin approves',
		invite: 'Invite only'
	};

	let settingsError = $derived(groupFormError(updateGroupForm.result));
	let showSettings = $state(false);
</script>

<section class="mt-10">
	<button
		type="button"
		class="text-base-500 dark:text-base-400 text-sm hover:underline"
		onclick={() => (showSettings = !showSettings)}
	>
		{showSettings ? 'Hide' : 'Show'} group settings
	</button>

	{#if linkOutcome === 'linked'}
		<p class="text-base-500 dark:text-base-400 mt-3 text-sm">
			Linked. This site now writes as the group for you through the session you authorized.
		</p>
	{:else if linkOutcome === 'failed'}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">
			The link did not complete, and nothing changed. At the group's host, sign in with your own
			account and approve the request.
		</p>
	{/if}

	{#if showSettings}
		<form {...resetOnSuccess(updateGroupForm)} class="mt-4 flex flex-col gap-4">
			<input type="hidden" name="groupDid" value={groupDid} />
			<!-- The save changes the visibility only when the choice differs from this. -->
			<input type="hidden" name="shownVisibility" value={visibility ?? ''} />
			<!-- defaultValue, not value: a remote form resets after a save, and a reset
			     restores each control's default, so with value= the next save would
			     write an empty description. -->
			<div class="flex flex-col gap-1.5">
				<Label for="settings-name">Name</Label>
				<Input id="settings-name" name="name" defaultValue={about.name} required />
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="settings-description">Description</Label>
				<textarea
					id="settings-description"
					name="description"
					rows="3"
					defaultValue={about.description ?? ''}
					class={FIELD_CLASS}
				></textarea>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="settings-visibility">Visibility</Label>
				<select id="settings-visibility" name="visibility" required class={FIELD_CLASS}>
					<!-- No default when the host did not say, so a save cannot move the group. -->
					{#if visibility === null}
						<option value="" disabled selected>could not be read from its PDS</option>
					{/if}
					{#each ['public', 'private'] as value (value)}
						<option {value} selected={visibility === value}>{value}</option>
					{/each}
				</select>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="settings-join-policy">Joining</Label>
				<select id="settings-join-policy" name="joinPolicy" required class={FIELD_CLASS}>
					{#each GROUP_JOIN_POLICIES as value (value)}
						<option {value} selected={(about.joinPolicy ?? 'invite') === value}
							>{JOIN_LABELS[value]}</option
						>
					{/each}
				</select>
			</div>
			<label class="flex items-center gap-2 text-sm">
				<input type="checkbox" name="listed" defaultChecked={listed} class="size-4" />
				List this group in browse (public groups only)
			</label>
			{#if settingsError}
				<p class="text-sm text-red-600 dark:text-red-400">{settingsError}</p>
			{:else if updateGroupForm.result?.ok}
				<p class="text-base-500 dark:text-base-400 text-sm">Saved.</p>
			{/if}
			<div><Button type="submit">Save settings</Button></div>
		</form>

		{#if groupLinked}
			<!-- An unlinked group's prompt sits above the settings, on the page. -->
			<GroupLinkForm
				{groupDid}
				class="border-base-200 dark:border-base-800 mt-8 flex flex-col gap-2 border-t pt-6"
			>
				<h3 class="text-sm font-semibold">Your access to this group</h3>
				<p class="text-base-500 dark:text-base-400 text-xs">
					This site writes as the group for you through a session you authorized at the group's PDS.
					Reconnect if you revoked it there or it stopped working.
				</p>
				<div>
					<Button type="submit" variant="secondary">Reconnect your access</Button>
				</div>
			</GroupLinkForm>
		{/if}
	{/if}
</section>
