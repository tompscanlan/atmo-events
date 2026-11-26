<script lang="ts">
	import { Button } from '@atmo-dev/kit';
	import { resolve } from '$app/paths';
	import GroupAccessNotice from '#lib/groups/components/GroupAccessNotice.svelte';
	import GroupSettingsFields from '#lib/groups/components/GroupSettingsFields.svelte';

	let { data, form } = $props();

	/** Sent, and the browser waiting for the answer: a second press would ask for the group again. */
	let sending = $state(false);

	// What the person typed, kept when the host refuses it.
	let values = $derived(
		form?.values ?? {
			name: '',
			address: '',
			description: '',
			joinPolicy: 'approval',
			public: true,
			listed: true
		}
	);
</script>

<!-- Back to this page from the host, the browser may show it as it was left, still sending. -->
<svelte:window onpageshow={() => (sending = false)} />

<div class="min-h-screen px-6 py-12 sm:py-12">
	<div class="mx-auto max-w-2xl">
		<div class="mb-6">
			<a
				href={resolve('/(app)/groups')}
				class="text-accent-600 hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300 text-sm font-medium transition-colors"
			>
				&larr; All groups
			</a>
		</div>
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Make a group</h1>
		<p class="text-base-700 dark:text-base-300 mt-2">
			A group is a community with its own page that others can find and ask to join. Its admins post
			as the group: group events are made from the group's page, as the group.
		</p>

		{#if !data.available}
			<p class="text-base-600 dark:text-base-400 mt-6">
				This site cannot make groups: it serves no OAuth client of its own.
			</p>
		{:else}
			{#if data.unfinished.length > 0}
				<section class="mt-6" aria-label="Groups not set up yet">
					<h2 class="text-base-900 dark:text-base-50 text-lg font-semibold">Not set up yet</h2>
					<p class="text-base-600 dark:text-base-400 mt-1 text-sm">
						You made these groups, but haven't approved atmo to post as them yet.
					</p>
					<ul class="mt-2 space-y-2">
						{#each data.unfinished as group (group.did)}
							<li>
								<form
									method="POST"
									action="/oauth/group/link"
									class="flex flex-wrap items-center gap-3"
								>
									<input type="hidden" name="group" value={group.did} />
									<span class="text-base-900 dark:text-base-50 font-medium">@{group.handle}</span>
									<Button type="submit" size="sm" variant="secondary">Finish setting up</Button>
								</form>
							</li>
						{/each}
					</ul>
				</section>
			{/if}

			<p class="text-base-600 dark:text-base-400 mt-6 text-sm">
				The group host makes the group's account, and you become its first admin. Then you approve
				atmo to post as the group, at the group host.
			</p>

			{#if data.access}
				<GroupAccessNotice
					access={data.access}
					did={data.did}
					newGroupUrl={data.host?.newGroupUrl ?? null}
				/>
			{/if}

			{#if form?.message}
				<p role="alert" class="text-base-950 dark:text-base-50 mt-4 text-sm">
					{form.message}
				</p>
			{/if}
			{#if form && 'made' in form && form.made}
				<form
					method="POST"
					action="/oauth/group/link"
					class="mt-3 flex flex-wrap items-center gap-3"
				>
					<input type="hidden" name="group" value={form.made.did} />
					<span class="text-base-900 dark:text-base-50 font-medium">@{form.made.handle}</span>
					<Button type="submit" size="sm" variant="secondary">Finish setting up</Button>
				</form>
			{/if}

			{#if !data.host}
				<p class="text-base-600 dark:text-base-400 mt-6">
					The group host could not be reached. Try again shortly.
				</p>
			{:else if !data.access}
				<form method="POST" class="mt-6 space-y-5" onsubmit={() => (sending = true)}>
					<GroupSettingsFields
						name={values.name}
						description={values.description}
						joinPolicy={values.joinPolicy}
						isPublic={values.public}
						listed={values.listed}
						address={{ label: values.address, domain: data.host.domain }}
					/>
					<Button type="submit" variant="primary" disabled={sending}>Make the group</Button>
				</form>
			{/if}
		{/if}
	</div>
</div>
