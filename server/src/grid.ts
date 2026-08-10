import { hashInt } from './hash';
import type { TileType, Zone } from './types';

/**
 * The fog. Same distribution the prototype used, but keyed on a seed that never
 * leaves the server — in the client build `hiddenType(r,c)` was pure coordinates,
 * so anyone could read the bundle and compute the entire map.
 */
export function tileType(zone: Zone, r: number, c: number): TileType {
  const h = hashInt(zone.seedSecret, zone.epoch, r, c) % 100;
  if (h < 56) return 'empty';
  if (h < 73) return 'clue';
  if (h < 85) return 'trap';
  if (h < 94) return 'mystery';
  return 'puzzle';
}

export function cellKey(r: number, c: number): string {
  return `${r},${c}`;
}

export function inBounds(r: number, c: number, rows: number, cols: number): boolean {
  return Number.isInteger(r) && Number.isInteger(c) && r >= 0 && c >= 0 && r < rows && c < cols;
}
