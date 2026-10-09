<script lang="ts">
	import { Button, Input, Label } from '@foxui/core';
	import { groupFormError, resetOnSuccess } from '../form-result';
	import { repairGroupForm, updateGroupForm } from '../group.remote';
	import type { GroupRow, GroupVisibility } from '../types';
	import { FIELD_CLASS } from './field-class';
	import GroupLinkForm from './GroupLinkForm.svelte';

	// The owner's settings for a group: its profile, rules and visibility, the
	// repair, and reconnecting its account. Folded away until asked for.
	let {
		group,
		about,
		visibility,
		groupLinked,
		linkOutcome
	}: {
		group: Pick<GroupRow, 'group_did' | 'require_approval'>;
		about: { name: string; description: string | null; rules: { text: string }[] };
		/** The host's visibility, or null when it could not be asked. */
		visibility: GroupVisibility | null;
		groupLinked: boolean | null;
		/** `linked` or `failed` after a link's callback, else null. */
		linkOutcome: string | null;
	} = $props();

	let settingsError = $derived(groupFormError(updateGroupForm.result));
	let repairError = $derived(groupFormError(repairGroupForm.result));
	let repairSummary = $derived(
		repairGroupForm.result?.ok === true ? repairGroupForm.result.summary : undefined
	);
	let showSettings = $state(false);
	// The visibility currently selected in the settings form, or null for "not
	// changed yet", in which case the host's applies. A private group is
	// invite-only and a save refuses one that does not require approval, so the
	// form shows approval as fixed on while private is picked.
	let pickedVisibility = $state<string | null>(null);
	let settingsPrivate = $derived((pickedVisibility ?? visibility) === 'private');
</script>

<section class="mt-10">
	<button
		type="button"
		class="text-base-500 dark:text-base-400 text-sm hover:underline"
		onclick={() => {
			showSettings = !showSettings;
			pickedVisibility = null;
		}}
	>
		{showSettings ? 'Hide' : 'Show'} group settings
	</button>

	{#if linkOutcome === 'linked'}
		<p class="text-base-500 dark:text-base-400 mt-3 text-sm">
			Linked. This site now writes as the group through the session you authorized.
		</p>
	{:else if linkOutcome === 'failed'}
		<p class="mt-3 text-sm text-red-600 dark:text-red-400">
			The link did not complete, and nothing changed. At the group's PDS, sign in as the group
			itself, not as yourself, and approve the request.
		</p>
	{/if}

	{#if showSettings}
		<form {...resetOnSuccess(updateGroupForm)} class="mt-4 flex flex-col gap-4">
			<input type="hidden" name="groupDid" value={group.group_did} />
			<!-- The visibility this form shows, which is the host's as the page
			     read it, and empty when the host could not be read. The save
			     moves the visibility only when the choice below differs from
			     it, so a tab opened before someone else changed the visibility
			     does not change it back. A hidden input's value is its default,
			     so a reset keeps it, and a reload after a save refreshes it. -->
			<input type="hidden" name="shownVisibility" value={visibility ?? ''} />
			<!-- Default values, not values. A successful remote-form submission
			     resets the form, and a reset restores each control's default
			     (`defaultValue` / `defaultChecked`), not the `value` property
			     Svelte assigns. With `value=`, `description` and `rules` come
			     back empty after a save, so the next save would write an empty
			     description and delete every rule record. `<select>` is fine:
			     its `selected` attribute is the option's default. -->
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
				<Label for="settings-rules">Rules</Label>
				<textarea
					id="settings-rules"
					name="rules"
					rows="4"
					placeholder="One rule per line"
					defaultValue={about.rules.map((rule) => rule.text).join('\n')}
					class={FIELD_CLASS}
				></textarea>
				<p class="text-base-500 dark:text-base-400 text-xs">
					One rule per line. Each line is its own record, so editing one rule leaves the others’
					addresses untouched.
				</p>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="settings-visibility">Visibility</Label>
				<select
					id="settings-visibility"
					name="visibility"
					required
					onchange={(e) => (pickedVisibility = e.currentTarget.value)}
					class={FIELD_CLASS}
				>
					<!-- The host did not say. No option is preselected then, because a
					     save would otherwise send the first one and could move the group
					     to it; the owner has to pick one. -->
					{#if visibility === null}
						<option value="" disabled selected>could not be read from its PDS</option>
					{/if}
					{#each ['public', 'private'] as value (value)}
						<option {value} selected={visibility === value}>{value}</option>
					{/each}
				</select>
			</div>
			<!-- No space URI field: both spaces are created with the group under
			     its own DID, so there is nothing to edit. They are listed,
			     read-only, under "Where this group's data lives". -->
			<!-- A disabled checkbox is never submitted, and an absent checkbox
			     parses as "off", so the fixed-on case sends its value through a
			     hidden input. -->
			{#if settingsPrivate}
				<input type="hidden" name="requireApproval" value="on" />
				<label class="flex items-center gap-2 text-sm">
					<input type="checkbox" checked disabled class="size-4" />
					Require approval to join
				</label>
				<p class="text-base-500 dark:text-base-400 -mt-2 text-xs">
					A private group is invite-only, so approval is always on.
				</p>
			{:else}
				<label class="flex items-center gap-2 text-sm">
					<input
						type="checkbox"
						name="requireApproval"
						defaultChecked={!!group.require_approval}
						class="size-4"
					/>
					Require approval to join
				</label>
			{/if}
			{#if settingsError}
				<p class="text-sm text-red-600 dark:text-red-400">{settingsError}</p>
			{:else if updateGroupForm.result?.ok}
				<p class="text-base-500 dark:text-base-400 text-sm">Saved.</p>
			{/if}
			<div><Button type="submit">Save settings</Button></div>
		</form>

		<!-- A separate form, so repairing never submits the settings above. -->
		<form
			{...resetOnSuccess(repairGroupForm)}
			class="border-base-200 dark:border-base-800 mt-8 flex flex-col gap-2 border-t pt-6"
		>
			<input type="hidden" name="groupDid" value={group.group_did} />
			<h3 class="text-sm font-semibold">Repair this group</h3>
			<p class="text-base-500 dark:text-base-400 text-xs">
				Writes any of this group's member records that are missing and can be written safely, brings
				the group's member list at its PDS in line with those records, publishes or withdraws its
				declaration to match the visibility its PDS enforces, then rebuilds this site's copy of the
				group from its records. It never overwrites a record that exists, and running it twice
				changes nothing the second time.
			</p>
			{#if repairError}
				<p class="text-sm text-red-600 dark:text-red-400">{repairError}</p>
			{:else if repairSummary}
				<p class="text-base-500 dark:text-base-400 text-sm">{repairSummary}</p>
			{/if}
			<div><Button type="submit" variant="secondary">Repair this group</Button></div>
		</form>

		{#if groupLinked}
			<!-- An unlinked group's prompt sits above the settings, on the page. -->
			<GroupLinkForm
				groupDid={group.group_did}
				class="border-base-200 dark:border-base-800 mt-8 flex flex-col gap-2 border-t pt-6"
			>
				<h3 class="text-sm font-semibold">This group's account</h3>
				<p class="text-base-500 dark:text-base-400 text-xs">
					This site writes as the group through a session you authorized at the group's PDS.
					Reconnect if you revoked it there or it stopped working.
				</p>
				<div>
					<Button type="submit" variant="secondary">Reconnect the group's account</Button>
				</div>
			</GroupLinkForm>
		{/if}
	{/if}
</section>
