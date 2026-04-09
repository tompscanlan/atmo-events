export type ThumbnailRenderer = (
	ctx: CanvasRenderingContext2D,
	w: number,
	h: number,
	name: string,
	dateStr: string,
	seed: number
) => void;

function hue(seed: number, offset: number) {
	return (seed * 137.5 + offset) % 360;
}

function hsl(h: number, s: number, l: number) {
	return `hsl(${h}, ${s}%, ${l}%)`;
}

function hsla(h: number, s: number, l: number, a: number) {
	return `hsla(${h}, ${s}%, ${l}%, ${a})`;
}

function drawText(
	ctx: CanvasRenderingContext2D,
	text: string,
	x: number,
	y: number,
	maxWidth: number,
	fontSize: number,
	fontWeight: string,
	color: string,
	align: CanvasTextAlign = 'center'
) {
	ctx.fillStyle = color;
	ctx.font = `${fontWeight} ${fontSize}px system-ui, -apple-system, sans-serif`;
	ctx.textAlign = align;
	ctx.textBaseline = 'middle';

	// Word wrap
	const words = text.split(' ');
	const lines: string[] = [];
	let line = '';
	for (const word of words) {
		const test = line ? `${line} ${word}` : word;
		if (ctx.measureText(test).width > maxWidth && line) {
			lines.push(line);
			line = word;
		} else {
			line = test;
		}
	}
	if (line) lines.push(line);

	const lineHeight = fontSize * 1.2;
	const totalHeight = lines.length * lineHeight;
	const startY = y - totalHeight / 2 + lineHeight / 2;

	for (let i = 0; i < lines.length; i++) {
		ctx.fillText(lines[i], x, startY + i * lineHeight, maxWidth);
	}

	return totalHeight;
}

export const gradientMesh: ThumbnailRenderer = (ctx, w, h, name, dateStr, seed) => {
	const h1 = hue(seed, 0);
	const h2 = hue(seed, 120);
	const h3 = hue(seed, 240);

	// Background gradient
	const bg = ctx.createLinearGradient(0, 0, w, h);
	bg.addColorStop(0, hsl(h1, 70, 45));
	bg.addColorStop(0.5, hsl(h2, 65, 40));
	bg.addColorStop(1, hsl(h3, 75, 35));
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);

	// Blurred blobs (circles with radial gradients)
	function blob(x: number, y: number, r: number, color: string, alpha: number) {
		const g = ctx.createRadialGradient(x, y, 0, x, y, r);
		g.addColorStop(0, hsla(parseFloat(color), 80, 60, alpha));
		g.addColorStop(1, hsla(parseFloat(color), 80, 60, 0));
		ctx.fillStyle = g;
		ctx.fillRect(x - r, y - r, r * 2, r * 2);
	}
	blob(w * -0.1, h * -0.1, w * 0.4, String(h2), 0.4);
	blob(w * 1.1, h * 1.1, w * 0.35, String(h1), 0.3);
	blob(w * 0.4, h * 0.3, w * 0.3, String(h3), 0.25);

	// Text
	if (name) {
		const th = drawText(ctx, name, w / 2, h / 2 - 10, w * 0.75, w * 0.09, 'bold', 'white');
		if (dateStr) {
			drawText(ctx, dateStr, w / 2, h / 2 + th / 2 + w * 0.03, w * 0.7, w * 0.04, '500', 'rgba(255,255,255,0.8)');
		}
	}
};

export const boldType: ThumbnailRenderer = (ctx, w, h, name, dateStr, seed) => {
	const hu = hue(seed, 0);

	ctx.fillStyle = hsl(hu, 15, 10);
	ctx.fillRect(0, 0, w, h);

	if (name) {
		drawText(ctx, name, w * 0.07, h * 0.72, w * 0.86, w * 0.11, '900', hsl(hu, 70, 65), 'left');
	}
	if (dateStr) {
		ctx.fillStyle = 'rgba(255,255,255,0.5)';
		ctx.font = `500 ${w * 0.04}px system-ui, -apple-system, sans-serif`;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		ctx.fillText(dateStr, w * 0.07, h * 0.88);
	}
};

export const minimal: ThumbnailRenderer = (ctx, w, h, name, dateStr, seed) => {
	const hu = hue(seed, 0);

	ctx.fillStyle = hsl(hu, 20, 95);
	ctx.fillRect(0, 0, w, h);

	if (name) {
		const th = drawText(ctx, name, w / 2, h / 2 - 10, w * 0.75, w * 0.09, '600', hsl(hu, 30, 20));
		if (dateStr) {
			drawText(ctx, dateStr, w / 2, h / 2 + th / 2 + w * 0.03, w * 0.7, w * 0.04, 'normal', hsl(hu, 20, 50));
		}
	}
};

export const geometric: ThumbnailRenderer = (ctx, w, h, name, dateStr, seed) => {
	const h1 = hue(seed, 0);
	const h2 = (h1 + 30) % 360;

	ctx.fillStyle = hsl(h1, 60, 50);
	ctx.fillRect(0, 0, w, h);

	// Shapes
	ctx.globalAlpha = 0.15;
	for (let i = 0; i < 6; i++) {
		const x = ((seed * 31 + i * 73) % 100) / 100 * w;
		const y = ((seed * 47 + i * 59) % 100) / 100 * h;
		const size = (15 + ((seed * 13 + i * 41) % 25)) / 100 * w;
		const type = i % 3;

		ctx.fillStyle = hsl(h2, 70, 70);
		ctx.save();
		ctx.translate(x, y);
		ctx.rotate(((seed * 23 + i * 67) % 360) * Math.PI / 180);

		if (type === 0) {
			ctx.beginPath();
			ctx.arc(0, 0, size / 2, 0, Math.PI * 2);
			ctx.fill();
		} else if (type === 1) {
			ctx.fillRect(-size / 2, -size / 2, size, size);
		} else {
			ctx.beginPath();
			ctx.moveTo(0, -size / 2);
			ctx.lineTo(-size / 2, size / 2);
			ctx.lineTo(size / 2, size / 2);
			ctx.closePath();
			ctx.fill();
		}
		ctx.restore();
	}
	ctx.globalAlpha = 1;

	if (name) {
		const th = drawText(ctx, name, w / 2, h / 2 - 10, w * 0.75, w * 0.09, 'bold', 'white');
		if (dateStr) {
			drawText(ctx, dateStr, w / 2, h / 2 + th / 2 + w * 0.03, w * 0.7, w * 0.04, '500', 'rgba(255,255,255,0.7)');
		}
	}
};

export const darkGradient: ThumbnailRenderer = (ctx, w, h, name, dateStr, seed) => {
	const hu = hue(seed, 0);

	const bg = ctx.createLinearGradient(0, 0, w * 0.3, h);
	bg.addColorStop(0, hsl(hu, 50, 15));
	bg.addColorStop(1, hsl(hu, 30, 5));
	ctx.fillStyle = bg;
	ctx.fillRect(0, 0, w, h);

	// Accent line at top
	const line = ctx.createLinearGradient(0, 0, w, 0);
	line.addColorStop(0, hsl(hu, 80, 55));
	line.addColorStop(1, hsl((hu + 60) % 360, 80, 55));
	ctx.fillStyle = line;
	ctx.fillRect(0, 0, w, h * 0.01);

	if (name) {
		drawText(ctx, name, w * 0.07, h * 0.72, w * 0.86, w * 0.09, 'bold', 'white', 'left');
	}
	if (dateStr) {
		ctx.fillStyle = hsl(hu, 40, 60);
		ctx.font = `normal ${w * 0.04}px system-ui, -apple-system, sans-serif`;
		ctx.textAlign = 'left';
		ctx.textBaseline = 'top';
		ctx.fillText(dateStr, w * 0.07, h * 0.88);
	}
};

export const waves: ThumbnailRenderer = (ctx, w, h, name, dateStr, seed) => {
	const h1 = hue(seed, 0);
	const h2 = (h1 + 40) % 360;

	ctx.fillStyle = hsl(h1, 45, 92);
	ctx.fillRect(0, 0, w, h);

	// Wave layers
	function wave(yBase: number, amplitude: number, color: string, alpha: number) {
		ctx.globalAlpha = alpha;
		ctx.fillStyle = color;
		ctx.beginPath();
		ctx.moveTo(0, yBase);
		for (let x = 0; x <= w; x += 2) {
			const y = yBase + Math.sin((x / w) * Math.PI * 2 + seed) * amplitude;
			ctx.lineTo(x, y);
		}
		ctx.lineTo(w, h);
		ctx.lineTo(0, h);
		ctx.closePath();
		ctx.fill();
	}

	wave(h * 0.7, h * 0.05, hsl(h1, 55, 75), 0.5);
	wave(h * 0.78, h * 0.04, hsl(h2, 55, 65), 0.4);
	wave(h * 0.85, h * 0.03, hsl(h1, 50, 55), 0.3);
	ctx.globalAlpha = 1;

	if (name) {
		const th = drawText(ctx, name, w / 2, h * 0.4, w * 0.75, w * 0.09, 'bold', hsl(h1, 40, 25));
		if (dateStr) {
			drawText(ctx, dateStr, w / 2, h * 0.4 + th / 2 + w * 0.03, w * 0.7, w * 0.04, '500', hsl(h1, 30, 45));
		}
	}
};

export const designs: Record<string, ThumbnailRenderer> = {
	gradient: gradientMesh,
	bold: boldType,
	minimal,
	geometric,
	dark: darkGradient,
	waves
};
