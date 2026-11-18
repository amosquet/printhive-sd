/**
 * Shared print-settings model for the submission flow.
 *
 * Mirrors the deployed PrintHive submission form: global "default settings"
 * apply to every selected file, and each file can carry per-part overrides
 * (plus copies/mirror). The new version pins layer height / walls / infill to
 * one of the three FR-05 slicer profiles (see backend/profiles/*.process.json)
 * instead of exposing them as free selects.
 */

export interface MaterialColor {
  id: number;
  material_id: number;
  name: string;
  code: string;
  is_default?: boolean;
}
export interface Material {
  id: number;
  name: string;
  is_default?: boolean;
  colors: MaterialColor[];
}

export const MATERIALS: Material[] = [
  {
    id: 1,
    name: 'PLA',
    is_default: true,
    colors: [
      { id: 1, material_id: 1, name: 'black', code: '#353832', is_default: true },
      { id: 2, material_id: 1, name: 'white', code: '#ffffff' },
      { id: 3, material_id: 1, name: 'yellow', code: '#edc54d' },
      { id: 4, material_id: 1, name: 'red', code: '#c9493b' },
    ],
  },
  {
    id: 2,
    name: 'PETG',
    colors: [
      { id: 5, material_id: 2, name: 'black', code: '#353832', is_default: true },
      { id: 6, material_id: 2, name: 'white', code: '#ffffff' },
      { id: 7, material_id: 2, name: 'gray', code: '#6b7280' },
      { id: 8, material_id: 2, name: 'blue', code: '#2563eb' },
    ],
  },
];

/** FR-05: exactly three standard functional profiles, pinned to backend/profiles/. */
export interface PrintProfile {
  id: 'draft' | 'standard' | 'high_strength';
  name: string;
  layerHeight: number;
  walls: number;
  infill: number;
  description: string;
}
export const PROFILES: PrintProfile[] = [
  {
    id: 'draft',
    name: 'Draft',
    layerHeight: 0.3,
    walls: 2,
    infill: 10,
    description: 'Fastest print: 0.3 mm layers, 2 walls, 10% infill.',
  },
  {
    id: 'standard',
    name: 'Standard',
    layerHeight: 0.2,
    walls: 3,
    infill: 15,
    description: 'Balanced default: 0.2 mm layers, 3 walls, 15% infill.',
  },
  {
    id: 'high_strength',
    name: 'High Strength',
    layerHeight: 0.2,
    walls: 5,
    infill: 40,
    description: 'Strongest part: 0.2 mm layers, 5 walls, 40% infill.',
  },
];

export const SUPPORTS = ['operator', 'none', 'tree', 'normal'] as const;
export type SupportChoice = (typeof SUPPORTS)[number];
export const supportLabel = (value: string) =>
  value === 'operator' ? 'Operator decides' : value === 'tree' ? 'Tree' : value === 'normal' ? 'Regular' : 'None';

/** Engine support mode for the preview slicer. */
export const supportMode = (value: string): 'tree' | 'normal' | 'none' =>
  value === 'none' ? 'none' : value === 'normal' ? 'normal' : 'tree';

export interface PrinterSpec {
  id: string;
  name: string;
  manufacturer: string;
  buildVolume: { x: number; y: number; z: number };
  buildVolumeFormatted: string;
  technology: string;
  features: string[];
  description: string;
}

/** The fleet shown on the submit page (same two machines the deployed preview slices for). */
export const AVAILABLE_PRINTERS: PrinterSpec[] = [
  {
    id: 'bambu-h2d',
    name: 'Bambu H2D Pro',
    manufacturer: 'Bambu Lab',
    buildVolume: { x: 350, y: 320, z: 325 },
    buildVolumeFormatted: '350 × 320 × 325 mm',
    technology: 'Dual-Nozzle CoreXY',
    features: [
      'Dual-nozzle multi-material extrusion',
      'Active chamber heating (65°C)',
      'High-temp nozzle (350°C)',
      'High-speed precision servo motion',
    ],
    description: 'Large-format dual-nozzle system ideal for multi-material prints and high-temperature engineering polymers without purge waste.',
  },
  {
    id: 'prusa-core-one-plus',
    name: 'Prusa Core ONE+',
    manufacturer: 'Prusa Research',
    buildVolume: { x: 250, y: 220, z: 270 },
    buildVolumeFormatted: '250 × 220 × 270 mm',
    technology: 'Fully Enclosed CoreXY',
    features: [
      'Fully enclosed active temperature regulation',
      'Nextruder with quick-swap nozzles',
      'High-speed CoreXY kinematics',
      'Exceptional precision & dimensional accuracy',
    ],
    description: 'Fully enclosed high-performance printer engineered for dimensional accuracy, crisp detail, and reliable printing across PLA, PETG, ABS, and ASA.',
  },
];

export function checkPrinterFit(dimensions: number[], printer: PrinterSpec): boolean {
  const limits = [printer.buildVolume.x, printer.buildVolume.y, printer.buildVolume.z];
  return (
    dimensions.length === 3 &&
    dimensions.every((value, axis) => Number.isFinite(value) && value >= 0 && value <= limits[axis] + 1e-5)
  );
}

export const DEFAULT_COLOR_CODES: Record<string, string> = {
  black: '#414442', white: '#f5f1e7', yellow: '#efc84a', red: '#c9493b', blue: '#2563eb',
  green: '#16a34a', orange: '#ea580c', purple: '#9333ea', gray: '#6b7280', grey: '#6b7280',
  silver: '#9ca3af', gold: '#d97706', pink: '#db2777', cyan: '#06b6d4', brown: '#78350f', clear: '#e2e8f0',
};
export const SWATCH_COLOR_CODES: Record<string, string> = {
  black: '#353832', white: '#ffffff', yellow: '#edc54d', red: '#c9493b', blue: '#2563eb',
  green: '#22c55e', orange: '#f97316', purple: '#a855f7', gray: '#6b7280', grey: '#6b7280',
  silver: '#9ca3af', gold: '#eab308', pink: '#ec4899', cyan: '#06b6d4', brown: '#854d0e', clear: '#e2e8f0',
};
export function resolveColor(name: string, customCode?: string): string {
  if (customCode && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(customCode.trim())) return customCode.trim();
  const lower = (name || '').toLowerCase().trim();
  if (SWATCH_COLOR_CODES[lower]) return SWATCH_COLOR_CODES[lower];
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(lower)) return lower;
  return '#686d60';
}
export function previewColor(name: string, customCode?: string): string {
  if (customCode && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(customCode.trim())) return customCode.trim();
  const lower = (name || '').toLowerCase().trim();
  if (DEFAULT_COLOR_CODES[lower]) return DEFAULT_COLOR_CODES[lower];
  if (/^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(lower)) return lower;
  return '#686d60';
}

export type ModelUnits = 'mm' | 'm' | 'in';
export interface SharedPartSettings {
  profile: string;
  material: string;
  color: string;
  supports: string;
  supportAngle: string;
  units: ModelUnits;
  scalePercent: string;
}
export interface PartOptions {
  copies: number;
  mirror: boolean;
  overrides: Partial<SharedPartSettings>;
}
export const UNIT_SCALES = { mm: 1, m: 1000, in: 25.4 } as const;

export function getDefaultMaterial(materials: Material[]): Material {
  return materials.find((item) => item.is_default) ?? materials[0];
}
export function getDefaultColor(material: Material): string {
  return material.colors.find((item) => item.is_default)?.name ?? material.colors[0]?.name ?? 'black';
}
export function getProfile(id: string): PrintProfile {
  return PROFILES.find((item) => item.id === id) ?? PROFILES[1];
}

export function defaultPartSettings(materials: Material[]): SharedPartSettings {
  const material = getDefaultMaterial(materials);
  return {
    profile: 'standard',
    material: material.name,
    color: getDefaultColor(material),
    supports: 'operator',
    supportAngle: '',
    units: 'mm',
    scalePercent: '100',
  };
}

export function resolvePartSettings(
  global: SharedPartSettings,
  part: PartOptions | undefined,
  materials: Material[],
) {
  const settings = { ...global, ...part?.overrides };
  const material =
    materials.find((item) => item.name.toLowerCase() === settings.material.toLowerCase()) ??
    getDefaultMaterial(materials);
  const materialOverriddenWithoutColor =
    part?.overrides?.material !== undefined &&
    part.overrides.color === undefined &&
    part.overrides.material.toLowerCase() !== global.material.toLowerCase();
  const color = materialOverriddenWithoutColor
    ? undefined
    : material.colors.find((item) => item.name.toLowerCase() === settings.color.toLowerCase());
  return {
    ...settings,
    profile: PROFILES.some((item) => item.id === settings.profile) ? settings.profile : 'standard',
    material: material.name,
    color: color?.name ?? getDefaultColor(material),
    copies: part?.copies ?? 1,
    mirror: part?.mirror ?? false,
  };
}

export type ResolvedPartSettings = ReturnType<typeof resolvePartSettings>;

/** A material override can make an inherited or explicit color unavailable. */
export function normalizePartOverrides(
  global: SharedPartSettings,
  overrides: Partial<SharedPartSettings>,
  materials: Material[],
) {
  const next = { ...overrides };
  const materialName = next.material ?? global.material;
  const material =
    materials.find((item) => item.name.toLowerCase() === materialName.toLowerCase()) ??
    getDefaultMaterial(materials);
  if (next.color && !material.colors.some((item) => item.name.toLowerCase() === next.color!.toLowerCase()))
    delete next.color;
  if (next.profile && !PROFILES.some((item) => item.id === next.profile)) delete next.profile;
  return next;
}

/** Units and user scaling form one uniform transform, shared by preview and export. */
export function partScale(settings: SharedPartSettings): number | null {
  const percent = Number(settings.scalePercent);
  if (!settings.scalePercent.trim() || !Number.isFinite(percent) || percent < 0.01 || percent > 10000)
    return null;
  return (UNIT_SCALES[settings.units] * percent) / 100;
}

/** Blank inherits the printer profile; Orca's typed default is 30 degrees. */
export function partSupportAngle(settings: SharedPartSettings): number | undefined | null {
  if (!settings.supportAngle?.trim()) return undefined;
  const angle = Number(settings.supportAngle);
  return Number.isInteger(angle) && angle >= 0 && angle <= 90 ? angle : null;
}
