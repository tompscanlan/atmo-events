<script lang="ts">
	import { Avatar, Badge, Button, Input, Label } from '@atmo-dev/kit';
	import { resolve } from '$app/paths';
	import { requestPermissions } from '@svelte-atproto/oauth/client';
	import { GROUP_PERSON_SCOPES } from '#lib/groups/scopes.js';

	let { data } = $props();
</script>

<div class="min-h-screen px-6 py-12 sm:py-12">
	<div class="mx-auto max-w-2xl">
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Groups</h1>

		{#if data.notice}
			<p role="status" class="text-muted mt-4 text-sm">{data.notice}</p>
		{/if}

		{#if data.askAccess}
			<div class="mt-6 flex flex-wrap items-center gap-3">
				<Button variant="secondary" onclick={() => requestPermissions(GROUP_PERSON_SCOPES)}>
					See your groups
				</Button>
				<span class="text-muted text-sm">
					To list the groups you belong to, private ones too, allow atmo to read them.
				</span>
			</div>
		{/if}

		{#if data.canLink}
			<form method="POST" action="/oauth/group/link" class="mt-6 flex flex-wrap items-end gap-2">
				<div class="min-w-0 flex-1">
					<Label for="group-link">Link a group you help run, to post its events</Label>
					<Input id="group-link" name="group" placeholder="group.example.com" required />
				</div>
				<Button type="submit" variant="secondary">Link</Button>
			</form>
		{/if}

		{#if data.declaredUnavailable}
			<p class="text-muted mt-6 text-sm">The groups list could not be loaded. Try again shortly.</p>
		{/if}

		{#if data.groups.length > 0}
			<ul class="mt-6 space-y-3">
				{#each data.groups as group (group.did)}
					<li>
						<a
							href={resolve('/(app)/groups/[actor]', { actor: group.did })}
							class="flex items-start gap-3 rounded-lg p-2 hover:bg-black/5 dark:hover:bg-white/5"
						>
							<Avatar name={group.name} size={40} />
							<span class="min-w-0 flex-1">
								<span class="text-base-900 dark:text-base-50 flex items-center gap-2 font-medium">
									<span class="truncate">{group.name}</span>
									{#if group.member}<Badge>Member</Badge>{/if}
									{#if group.linked}<Badge>Linked</Badge>{/if}
								</span>
								{#if group.handle}
									<span class="text-muted block truncate text-sm">@{group.handle}</span>
								{/if}
								{#if group.description}
									<span class="text-muted mt-1 line-clamp-2 block text-sm">{group.description}</span
									>
								{/if}
							</span>
						</a>
					</li>
				{/each}
			</ul>
		{:else if !data.declaredUnavailable}
			<p class="text-muted py-12 text-center">No groups yet.</p>
		{/if}
	</div>
</div>
