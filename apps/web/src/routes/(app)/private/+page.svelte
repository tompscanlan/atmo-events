<script lang="ts">
	import { EventCard } from '@atmo-dev/kit/events';
	import { resolve } from '$app/paths';
	import { BETA_WARNING } from '#lib/private-events/beta.js';
	import PrivateEventAccessNotice from '#lib/private-events/components/PrivateEventAccessNotice.svelte';

	let { data } = $props();
</script>

{#snippet howInvitationsArrive()}
	{#if data.invitationScopes || !data.invitationsOn}
		<p class="text-base-600 dark:text-base-400 mt-4 text-sm" data-testid="link-is-invitation">
			The link is the invitation. atmo doesn't tell you when a host adds you, so an event you're
			invited to shows here only after you open the host's link and answer.
		</p>
	{/if}
	{#if data.invitationScopes}
		<PrivateEventAccessNotice
			access="ask"
			did={data.did}
			scopes={data.invitationScopes}
			purpose="atmo can show invitations here without the link. It needs your permission to keep an invitations inbox in your account, which hosts put invitations in and only you can read."
			label="Allow invitations"
		/>
	{:else if data.invitationsOn}
		<p class="text-base-600 dark:text-base-400 mt-4 text-sm" data-testid="how-invitations-arrive">
			An invitation shows here when the host adds you in atmo after you turned on private events.
			The host's link works either way.
		</p>
	{/if}
{/snippet}

<svelte:head><meta name="robots" content="noindex" /></svelte:head>

<div class="mx-auto max-w-3xl px-6 py-8 sm:py-12">
	<h1 class="text-base-900 dark:text-base-50 text-2xl font-bold">Your private events</h1>
	<p class="text-base-600 dark:text-base-400 mt-2 text-sm" data-testid="beta-notice">
		{BETA_WARNING}
		{#if !data.beta}To make your own, turn on private events in
			<a
				href={resolve('/(app)/settings')}
				class="text-accent-600 dark:text-accent-400 hover:underline">Settings</a
			>.{/if}
	</p>
	{#if data.events === null}
		<PrivateEventAccessNotice
			access={data.access ?? 'ask'}
			did={data.did}
			scopes={data.scopes ?? []}
			purpose={data.invitationsOn
				? 'Private events are kept on each host’s server. atmo needs your permission to open them for you, save your answer in your own account, and keep an invitations inbox there that hosts put invitations in and only you can read.'
				: 'Private events are kept on each host’s server. atmo needs your permission to open them for you and save your answer in your own account.'}
			label="Allow atmo to open private events"
			spacesServer={data.spacesServer}
		/>
	{:else}
		{#if data.invitations?.length || data.invitationsIncomplete}
			<section class="mt-6" data-testid="invitations">
				<h2 class="text-base-600 dark:text-base-400 text-xs font-semibold tracking-wider uppercase">
					Invited
				</h2>
				{#if data.invitationsIncomplete}
					<p
						class="text-base-600 dark:text-base-400 mt-2 text-sm"
						role="status"
						data-testid="invitations-incomplete"
					>
						Some invitations couldn't be read just now, so there may be more than these. Try again
						shortly.
					</p>
				{/if}
				<ul class="mt-3 space-y-2">
					{#each data.invitations ?? [] as invitation (invitation.space)}
						<li
							class="rounded-ui border-base-200 dark:border-base-800 flex items-center justify-between gap-3 border p-3 text-sm"
						>
							<span class="min-w-0">
								<span class="text-base-900 dark:text-base-50 block truncate font-medium"
									>{invitation.hostHandle ?? invitation.host} invited you to a private event</span
								>
								<span class="text-base-600 dark:text-base-400 block text-xs"
									>{new Date(invitation.invitedAt).toLocaleDateString('en-US', {
										dateStyle: 'medium',
										timeZone: 'UTC'
									})}. Anyone can send one, so open it only if you know them.</span
								>
							</span>
							<!-- Built from the host's handle or DID and the event's key, not a route id. -->
							<!-- eslint-disable svelte/no-navigation-without-resolve -->
							<a
								href={invitation.href}
								class="text-accent-600 dark:text-accent-400 shrink-0 hover:underline">See it</a
							><!-- eslint-enable svelte/no-navigation-without-resolve -->
						</li>
					{/each}
				</ul>
			</section>
		{/if}
		{#if data.events.length === 0 && !data.incomplete}
			<p class="text-base-600 dark:text-base-400 mt-4">
				None yet. Events you host show here, and ones you've answered.
			</p>
		{/if}
		{#if data.incomplete}
			<p
				class="text-base-600 dark:text-base-400 mt-4 text-sm"
				role="status"
				data-testid="private-events-incomplete"
			>
				Some of your private events couldn't be read just now, so there may be more than these. Try
				again shortly.
			</p>
		{/if}
		{#if data.events.length > 0}
			<ul class="mt-6 space-y-3" data-testid="private-events">
				{#each data.events as item (item.href)}
					<li>
						<EventCard event={item.event} href={item.href} />
						<p class="text-base-600 dark:text-base-400 mt-1 text-xs">
							{item.hosting ? 'You are hosting' : `Hosted by ${item.hostHandle ?? item.event.did}`}
						</p>
					</li>
				{/each}
			</ul>
		{/if}
		{@render howInvitationsArrive()}
	{/if}
</div>
