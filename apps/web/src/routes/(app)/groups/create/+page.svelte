<script lang="ts">
	import { Button, Input, Label } from '@foxui/core';
	import { createGroupForm } from '$lib/groups/groups.remote';
	import { slugifyGroupName } from '$lib/groups/slug';
	import { groupFormError } from '$lib/groups/form-result';

	let { data } = $props();

	let name = $state('');
	let slug = $state('');
	// The slug follows the name until the operator edits it, then stops — typing a
	// URL by hand and watching it be overwritten is the worse failure.
	let slugTouched = $state(false);
	let derivedSlug = $derived(slugTouched ? slug : name ? slugifyGroupName(name) : '');
	let createError = $derived(groupFormError(createGroupForm.result));
</script>

<svelte:head><title>New group — atmo.rsvp</title></svelte:head>

<div class="mx-auto max-w-2xl px-6 py-8 sm:py-12">
	<h1 class="mb-2 text-3xl font-bold">New group</h1>
	<p class="text-base-500 dark:text-base-400 mb-8 text-sm">
		A group is an account on the network. You bind an existing DID whose credential this deployment
		holds — creating a group never mints a new identity.
	</p>

	{#if data.custodialDids.length === 0}
		<div
			class="ring-base-200 dark:ring-base-800 text-base-600 dark:text-base-300 mb-8 rounded-2xl p-4 text-sm ring-1"
		>
			<p class="font-semibold">No custodial DIDs are configured.</p>
			<p class="mt-1">
				Set the <code class="font-mono">GROUP_CREDENTIALS</code> secret (a JSON map of group DID to
				<code class="font-mono">{'{ service, identifier, password }'}</code>) before creating a
				group.
			</p>
		</div>
	{/if}

	<form {...createGroupForm} class="flex flex-col gap-5">
		<div class="flex flex-col gap-1.5">
			<Label for="group-name">Name</Label>
			<Input id="group-name" name="name" bind:value={name} required maxlength={120} />
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="group-slug">URL</Label>
			<div class="flex items-center gap-2">
				<span class="text-base-500 dark:text-base-400 shrink-0 text-sm">/groups/</span>
				<Input
					id="group-slug"
					name="slug"
					value={derivedSlug}
					oninput={(e) => {
						slugTouched = true;
						slug = e.currentTarget.value;
					}}
					required
					pattern="[a-z0-9][a-z0-9-]{'{'}1,47{'}'}"
					class="flex-1"
				/>
			</div>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="group-did">Group DID</Label>
			{#if data.custodialDids.length > 0}
				<select
					id="group-did"
					name="groupDid"
					required
					class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 font-mono text-sm ring-1 ring-inset"
				>
					{#each data.custodialDids as did (did)}
						<option value={did}>{did}</option>
					{/each}
				</select>
			{:else}
				<Input id="group-did" name="groupDid" placeholder="did:plc:…" required class="font-mono" />
			{/if}
			<p class="text-base-500 dark:text-base-400 text-xs">
				The account every group event is authored by.
			</p>
		</div>

		<div class="flex flex-col gap-1.5">
			<Label for="group-description">Description</Label>
			<textarea
				id="group-description"
				name="description"
				rows="4"
				maxlength="4000"
				class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
			></textarea>
		</div>

		<div class="grid gap-5 sm:grid-cols-2">
			<div class="flex flex-col gap-1.5">
				<Label for="group-visibility">Visibility</Label>
				<select
					id="group-visibility"
					name="visibility"
					class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
				>
					<option value="public">public — listed and browsable</option>
					<option value="unlisted">unlisted — reachable by link</option>
					<option value="private">private — members only</option>
				</select>
			</div>
			<div class="flex flex-col gap-1.5">
				<Label for="group-status">Status</Label>
				<select
					id="group-status"
					name="status"
					class="ring-accent-500/30 dark:ring-accent-500/20 bg-accent-400/5 dark:bg-accent-600/5 text-accent-700 dark:text-accent-400 rounded-ui border-0 px-3 py-1.5 text-sm ring-1 ring-inset"
				>
					<option value="draft">draft</option>
					<option value="pending">pending</option>
					<option value="published">published</option>
				</select>
			</div>
		</div>

		<!-- The Space URI field is gone: creating a group now CREATES its `about`
		     and `members` spaces on the group's own PDS account, so
		     there is nothing to paste. The URIs appear on the group page. -->

		<label class="flex items-center gap-2 text-sm">
			<input type="checkbox" name="requireApproval" checked class="size-4" />
			Require approval to join
		</label>

		{#if createError}
			<p class="text-sm text-red-600 dark:text-red-400">{createError}</p>
		{/if}

		<div>
			<Button type="submit">Create group</Button>
		</div>
	</form>
</div>
