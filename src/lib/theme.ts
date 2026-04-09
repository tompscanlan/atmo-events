export interface EventTheme {
	name: string;
	accentColor: string;
	baseColor: string;
}

export const defaultTheme: EventTheme = {
	name: 'minimal',
	accentColor: 'cyan',
	baseColor: 'mist'
};

export const themeBackgrounds: Record<string, string> = {
	minimal: 'Minimal',
	blobs: 'Blobs',
	warp: 'Stars',
	matrix: 'Matrix',
	fireflies: 'Fireflies',
	kaleidoscope: 'Kaleidoscope'
};
