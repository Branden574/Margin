/** Margins are physical PDF points measured from the currently displayed page edges. */
export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}
export interface CropBox {
  x: number;
  y: number;
  width: number;
  height: number;
}
export type CropRequest = { kind: 'margins'; margins: CropMargins } | { kind: 'reset' };
export interface CropPageInfo {
  pageIndex: number;
  pageCount: number;
  /** Effective PDF.js quarter-turn rotation; the source Rotate entry is preserved. */
  rotation: 0 | 90 | 180 | 270;
  userUnit: number;
  /** Normalized boxes in the source PDF user coordinate system. */
  mediaBox: CropBox;
  cropBox: CropBox;
  /** CropBox intersected with MediaBox, using PDF.js's MediaBox fallback if disjoint. */
  visibleBox: CropBox;
  /** Display dimensions at viewport scale 1, including UserUnit and rotation. */
  width: number;
  height: number;
  /** PDF user coordinates to displayed top-left coordinates, matching PDF.js scale 1. */
  transform: [number, number, number, number, number, number];
}
export interface CropResult {
  blob: Blob;
  before: CropPageInfo;
  after: CropPageInfo;
  /** Add this translation to existing display-space annotations on the cropped page only. */
  annotationOffset: { x: number; y: number };
  changed: boolean;
}
export const CROP_MIN_SIZE = 1;
export const CROP_MAX_DISPLAY_SIZE = 1_000_000;
