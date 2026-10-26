/**
 * Pure browser-safe atproto helpers used by the UI components. Does not depend
 * on any session/client state — those flow through the EditorAdapter.
 */

export const DEFAULT_IMAGE_URL_TEMPLATE =
	'https://cdn.bsky.app/img/feed_thumbnail/plain/{did}/{cid}@{format}';
export const DEFAULT_APPVIEW_URL = 'https://public.api.bsky.app';

let imageUrlTemplate = DEFAULT_IMAGE_URL_TEMPLATE;
let appviewUrl = DEFAULT_APPVIEW_URL;

/** Points the components at another network's images and Bluesky API. */
export function configureAtproto(options: { imageUrlTemplate?: string; appviewUrl?: string }) {
	if (options.imageUrlTemplate !== undefined) imageUrlTemplate = options.imageUrlTemplate;
	if (options.appviewUrl !== undefined) appviewUrl = options.appviewUrl;
}

export function getAppviewUrl(): string {
	return appviewUrl;
}

export function getCDNImageBlobUrl({
	did,
	blob,
	format = 'webp'
}: {
	did: string;
	blob: {
		$type: 'blob';
		ref: { $link: string };
	};
	format?: 'webp' | 'jpeg' | 'png';
}) {
	return imageUrlTemplate
		.replace('{did}', did)
		.replace('{cid}', blob.ref.$link)
		.replace('{format}', format);
}

export function compressImage(
	file: File | Blob,
	maxSize: number = 900 * 1024,
	maxDimension: number = 2048
): Promise<{
	blob: Blob;
	aspectRatio: { width: number; height: number };
}> {
	return new Promise((resolve, reject) => {
		const img = new Image();
		const reader = new FileReader();

		reader.onload = (e) => {
			if (!e.target?.result) {
				return reject(new Error('Failed to read file.'));
			}
			img.src = e.target.result as string;
		};

		reader.onerror = (err) => reject(err);
		reader.readAsDataURL(file);

		img.onload = () => {
			let width = img.width;
			let height = img.height;

			if (file.size <= maxSize) {
				return resolve({ blob: file, aspectRatio: { width, height } });
			}

			if (width > maxDimension || height > maxDimension) {
				if (width > height) {
					height = Math.round((maxDimension / width) * height);
					width = maxDimension;
				} else {
					width = Math.round((maxDimension / height) * width);
					height = maxDimension;
				}
			}

			const canvas = document.createElement('canvas');
			canvas.width = width;
			canvas.height = height;
			const ctx = canvas.getContext('2d');
			if (!ctx) return reject(new Error('Failed to get canvas context.'));
			ctx.drawImage(img, 0, 0, width, height);

			let quality = 0.9;

			function attemptCompression() {
				canvas.toBlob(
					(blob) => {
						if (!blob) return reject(new Error('Compression failed.'));
						if (blob.size <= maxSize || quality < 0.3) {
							resolve({ blob, aspectRatio: { width, height } });
						} else {
							quality -= 0.1;
							attemptCompression();
						}
					},
					'image/webp',
					quality
				);
			}

			attemptCompression();
		};

		img.onerror = (err) => reject(err);
	});
}
