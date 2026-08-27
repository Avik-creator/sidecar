export const MARK_VIEWBOX = 24;
export const MARK_PETAL_COUNT = 5;
export const MARK_ACCENT = "#d56a2d";
export const MARK_PAPER = "#f4efe6";

interface MarkCircle {
  x: number;
  y: number;
  r: number;
}

interface MarkLayout {
  cx: number;
  cy: number;
  petals: MarkCircle[];
  centerR: number;
  stroke: number;
}

export function markLayout(size = MARK_VIEWBOX): MarkLayout {
  const cx = size / 2;
  const cy = size / 2;
  const orbit = size * 0.18;
  const petalR = size * 0.085;
  const petals: MarkCircle[] = [];
  for (let i = 0; i < MARK_PETAL_COUNT; i += 1) {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / MARK_PETAL_COUNT;
    petals.push({
      x: cx + Math.cos(angle) * orbit,
      y: cy + Math.sin(angle) * orbit,
      r: petalR,
    });
  }
  return {
    cx,
    cy,
    petals,
    centerR: size * 0.045,
    stroke: Math.max(1, size * 0.07),
  };
}

export function markCircles(size = MARK_VIEWBOX): MarkCircle[] {
  const layout = markLayout(size);
  return [...layout.petals, { x: layout.cx, y: layout.cy, r: layout.centerR }];
}

export function markSvgInner(color = "currentColor", size = MARK_VIEWBOX): string {
  const layout = markLayout(size);
  const stroke = fmt(layout.stroke);
  const petals = layout.petals
    .map(
      (circle) =>
        `<circle cx="${fmt(circle.x)}" cy="${fmt(circle.y)}" r="${fmt(circle.r)}" fill="none" stroke="${color}" stroke-width="${stroke}" />`,
    )
    .join("");
  return `${petals}<circle cx="${fmt(layout.cx)}" cy="${fmt(layout.cy)}" r="${fmt(layout.centerR)}" fill="${color}" />`;
}

export function markSvgDocument(color = MARK_ACCENT, size = MARK_VIEWBOX): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" role="img" aria-label="Sidecar">${markSvgInner(color, size)}</svg>`;
}

function fmt(value: number): string {
  return value.toFixed(2).replace(/\.00$/, "");
}
