<script lang="ts">
	import type { GroupRow } from '../types';
	import PdslsLink from './PdslsLink.svelte';

	// Where the group page's data came from, with each piece openable on pds.ls.
	let {
		group,
		source,
		rules
	}: {
		group: Pick<GroupRow, 'group_did' | 'about_space_uri' | 'members_space_uri'>;
		source: 'records' | 'cache';
		rules: { uri: string }[];
	} = $props();

	const linkClass =
		'text-accent-600 dark:text-accent-400 font-mono text-xs break-all hover:underline';
</script>

<details class="ring-base-200 dark:ring-base-800 mt-10 rounded-2xl p-4 ring-1">
	<summary class="cursor-pointer text-sm font-semibold">Where this group's data lives</summary>
	<p class="text-base-500 dark:text-base-400 mt-3 text-xs">
		{source === 'records'
			? 'Name, description and rules read from this group’s about space.'
			: 'Reading from cache. This group has no profile record yet.'}
		Each link opens on pds.ls. A space opens there only when you are signed in to pds.ls with an account
		it admits.
	</p>
	<dl class="mt-4 flex flex-col gap-3 text-sm">
		<div>
			<dt class="text-base-500 dark:text-base-400 text-xs">Group account</dt>
			<dd><PdslsLink to={group.group_did} class={linkClass}>{group.group_did}</PdslsLink></dd>
		</div>
		{#if group.about_space_uri}
			<div>
				<dt class="text-base-500 dark:text-base-400 text-xs">About space: profile and rules</dt>
				<dd>
					<PdslsLink to={group.about_space_uri} class={linkClass}>{group.about_space_uri}</PdslsLink
					>
				</dd>
			</div>
		{/if}
		{#if group.members_space_uri}
			<div>
				<dt class="text-base-500 dark:text-base-400 text-xs">
					Members space: memberships, roles and permissions
				</dt>
				<dd>
					<PdslsLink to={group.members_space_uri} class={linkClass}
						>{group.members_space_uri}</PdslsLink
					>
				</dd>
			</div>
		{/if}
	</dl>
	{#if rules.length > 0}
		<p class="text-base-500 dark:text-base-400 mt-4 text-xs">Rule records:</p>
		<ol class="mt-1 flex flex-col gap-1">
			{#each rules as rule, index (rule.uri)}
				<li><PdslsLink to={rule.uri} class={linkClass}>{index + 1}. {rule.uri}</PdslsLink></li>
			{/each}
		</ol>
	{/if}
</details>
