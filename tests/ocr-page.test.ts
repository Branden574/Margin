import { describe, expect, it, vi } from 'vitest';
vi.mock('pdfjs-dist', () => ({ PermissionFlag: { COPY: 16, COPY_FOR_ACCESSIBILITY: 512 } }));
import {
  pixelBoxToPdfQuad,
  pdfQuadToRect,
  rasterSize,
  OCR_RASTER_MAX_PIXELS,
  OCR_RASTER_MAX_SIDE,
} from '../apps/web/src/editor/ocrPage';
describe('OCR page geometry preserves the original PDF coordinate system', () => {
  it.each([
    [2, 0, 0, -2, -40, 1500], // Nonzero crop origin, upright page.
    [0, 2, 2, 0, -60, -40], // Rotation 90, nonzero crop origin.
    [-2, 0, 0, 2, 1240, -60], // Rotation 180.
    [0, -2, -2, 0, 1500, 1240], // Rotation 270.
  ])('round-trips word boxes through rotated and cropped viewports %j', (...transform) => {
    const box = { x0: 140, y0: 220, x1: 450, y1: 280 };
    const quad = pixelBoxToPdfQuad(box, transform);
    const rect = pdfQuadToRect(quad, transform);
    expect(rect).toEqual({ x: 140, y: 220, width: 310, height: 60 });
    // At half scale, the box remains on the same printed passage.
    expect(
      pdfQuadToRect(
        quad,
        transform.map((n) => n / 2),
      ),
    ).toEqual({ x: 70, y: 110, width: 155, height: 30 });
  });
  it('never rounds allocations beyond 4M pixels or 4096 per side', () => {
    for (const [width, height] of [
      [612, 792],
      [1234.567, 2345.678],
      [1, 100000],
      [100000, 1],
      [900000, 900000],
      [0.1, 0.1],
    ]) {
      const raster = rasterSize(width, height);
      expect(raster.width * raster.height).toBeLessThanOrEqual(OCR_RASTER_MAX_PIXELS);
      expect(Math.max(raster.width, raster.height)).toBeLessThanOrEqual(OCR_RASTER_MAX_SIDE);
      expect(raster.width).toBeGreaterThan(0);
      expect(raster.height).toBeGreaterThan(0);
    }
  });
  it('refuses invalid dimensions and singular transforms', () => {
    for (const n of [0, -1, Infinity, NaN]) expect(() => rasterSize(n, 800)).toThrow();
    expect(() => rasterSize(1e-320, 1e-320)).toThrow();
    expect(() => pixelBoxToPdfQuad({ x0: 0, y0: 0, x1: 1, y1: 1 }, [0, 0, 0, 0, 0, 0])).toThrow();
  });
});
