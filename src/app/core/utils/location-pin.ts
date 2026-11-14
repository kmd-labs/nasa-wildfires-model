export const USER_LOCATION_PIN_COLOR = '#2563eb';

/**
 * Draws a teardrop location pin whose bottom tip sits at (tipX, tipY).
 * Shared between the 2D canvas renderer and the 3D globe sprite texture.
 */
export function drawUserLocationPin(
  ctx: CanvasRenderingContext2D,
  tipX: number,
  tipY: number,
  heightPx = 28
): void {
  const r = heightPx * 0.34;
  const headY = tipY - heightPx + r;

  ctx.save();
  ctx.shadowColor = 'rgba(15, 23, 42, 0.35)';
  ctx.shadowBlur = Math.max(2, heightPx * 0.14);
  ctx.shadowOffsetY = Math.max(1, heightPx * 0.06);

  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.bezierCurveTo(
    tipX - r * 0.45,
    tipY - heightPx * 0.32,
    tipX - r,
    headY + r * 0.45,
    tipX - r,
    headY
  );
  ctx.arc(tipX, headY, r, Math.PI, 0, false);
  ctx.bezierCurveTo(
    tipX + r,
    headY + r * 0.45,
    tipX + r * 0.45,
    tipY - heightPx * 0.32,
    tipX,
    tipY
  );
  ctx.closePath();

  ctx.fillStyle = USER_LOCATION_PIN_COLOR;
  ctx.fill();

  ctx.shadowColor = 'transparent';
  ctx.lineWidth = Math.max(1.5, heightPx * 0.075);
  ctx.strokeStyle = '#ffffff';
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(tipX, headY, r * 0.38, 0, Math.PI * 2);
  ctx.fillStyle = '#ffffff';
  ctx.fill();
  ctx.restore();
}
