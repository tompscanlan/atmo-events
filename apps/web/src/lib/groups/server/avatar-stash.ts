// Holds the image a create at the group host was given while the creator is away
// at the host's sign-up. The group has no repo to upload into until the callback,
// and the authorization's state is too small for an image, so the state carries
// only the key, and the image waits here for as long as the state does.
import { GROUP_AVATAR_TYPES } from '../about-record';

/** A minute past the OAuth state's 600 seconds: the image is kept before the
 *  state exists, so it must not lapse first. One that outlives its sign-up is
 *  never taken. */
const STASH_TTL_SECONDS = 660;

const PREFIX = 'group-create-avatar:';

export interface AvatarStash {
	/** Keeps `image` and answers the key the state carries. */
	put(image: Blob): Promise<string>;
	/** The image under `key`, once: taking it removes it. Null when it is gone. */
	take(key: string): Promise<Blob | null>;
}

/** The stash over the store the OAuth states live in. */
export function kvAvatarStash(kv: KVNamespace): AvatarStash {
	return {
		async put(image) {
			const key = crypto.randomUUID();
			await kv.put(PREFIX + key, await image.arrayBuffer(), {
				expirationTtl: STASH_TTL_SECONDS,
				metadata: { type: image.type }
			});
			return key;
		},
		async take(key) {
			const { value, metadata } = await kv.getWithMetadata<{ type?: unknown }>(
				PREFIX + key,
				'arrayBuffer'
			);
			if (!value) return null;
			await kv.delete(PREFIX + key);
			const type = typeof metadata?.type === 'string' ? metadata.type : '';
			// Checked on the way in too. A stored type the profile would not take reads as gone.
			if (!(GROUP_AVATAR_TYPES as readonly string[]).includes(type)) return null;
			return new Blob([value], { type });
		}
	};
}
