<script lang="ts">
	import GroupSettingsFields from '#lib/groups/components/GroupSettingsFields.svelte';
	import { Button } from '@atmo-dev/kit';

	let { data } = $props();
</script>

<div class="min-h-screen px-6 py-12 sm:py-12">
	<div class="mx-auto max-w-2xl">
		<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Make a group</h1>
		<p class="text-muted mt-2 text-sm">
			The group gets its own account at the group host, which you sign in to next. You become its
			admin.
		</p>
		{#if data.notice}<p role="alert" class="mt-4 text-sm text-red-600">{data.notice}</p>{/if}

		{#if data.available}
			<form method="POST" action="/oauth/group/create" class="mt-6 space-y-5">
				<GroupSettingsFields
					name=""
					description=""
					joinPolicy="approval"
					isPublic={true}
					listed={true}
				/>
				<Button type="submit" variant="primary">Continue to the group host</Button>
			</form>
		{:else}
			<p class="text-muted mt-6">
				This site cannot make groups: it serves no OAuth client of its own.
			</p>
		{/if}
	</div>
</div>
