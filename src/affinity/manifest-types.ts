// Shared types for asset manifests, the run log and document inventories.
// Frozen: units import these and never redefine them.

/** The brand kit a run used; path is relative to the run's cwd. */
export interface BrandRef {
  name: string;
  path: string;
  sha256: string;
}

/** One line of .affinity-axi/runs.jsonl. */
export interface RunRecord {
  time: string;
  cmd: "run" | "batch" | "fill" | "templates";
  script: string;
  scriptSha256: string;
  /** Parsed --args, or the batch record. */
  args: unknown;
  flags: string[];
  /** ok | exception | sdk-error | not-allowed | timeout | error */
  outcome: string;
  ms: number;
  cwd: string;
  /** path is "" when the document is unsaved. */
  documents: { uuid: string; path: string }[];
  /** Set when the run was given a brand kit (--brand). */
  brand?: BrandRef;
}

export interface InventoryNode {
  /** Index path, spread index first, e.g. "0/2/1". */
  path: string;
  /** Node class name without "Node"; "Artboard" when artboard-enabled. */
  type: string;
  /** userDescription, "" when unset. */
  name: string;
  /** Spread pixels, rounded: x, y, w, h. */
  box: [number, number, number, number];
  visible: boolean;
  /** Name of the enclosing artboard. */
  artboard?: string;
  /** Text nodes: first 40 characters. */
  text?: string;
  /** Text nodes: the exact visible (ink) box, same format as box; absent when the read failed. */
  ink?: [number, number, number, number];
  /** Text nodes: "<postscriptName> <size>". */
  font?: string;
  /** "#RRGGBB" | "gradient" | "bitmap" | "none" | "other" */
  fill?: string;
}

export interface Inventory {
  at: string;
  doc: { uuid: string; title: string; path: string; units: string; width: number; height: number; dpi: number };
  artboards: { name: string; path: string; box: [number, number, number, number] }[];
  /** Full tree in document order. */
  nodes: InventoryNode[];
  counts: { nodes: number; named: number; text: number; images: number };
}

/** <file>.af.axi.json, stored beside the .af. */
export interface Manifest {
  schema: "affinity-axi/manifest/1";
  /** Basename of the .af. */
  file: string;
  /** tool: e.g. "affinity-axi 0.1.0". */
  af: { sha256: string; bytes: number; savedAt: string; tool: string };
  /** script is relative to the manifest's directory. */
  madeBy: { script: string; scriptSha256: string; args: unknown; flags: string[]; brand?: BrandRef } | null;
  history: Array<{
    time: string;
    kind: "run" | "batch" | "fill" | "templates" | "save" | "open";
    script?: string;
    scriptSha256?: string;
    args?: unknown;
    flags?: string[];
    outcome?: string;
    ms?: number;
    /** A --force save over a stale (hand-edited) file. */
    forced?: boolean;
    brand?: BrandRef;
  }>;
  /** alt: the image's alt text; requested/attempts: an export --max-kb budget and the presets tried. */
  exports: Array<{ time: string; path: string; preset: string; area: string; size: string; bytes: number; aiGenerated: boolean; alt?: string; requested?: string; attempts?: number }>;
  /** From provenance.jsonl. */
  ai: { generated: boolean; records: number };
  inventory: Inventory | null;
  notes: Array<{ time: string; text: string }>;
}

export type Freshness = "fresh" | "stale" | "none";

/** One row of `assets`, from a manifest scan. */
export interface AssetRow {
  file: string;
  dir: string;
  madeBy: string;
  savedAt: string;
  fresh: Freshness;
}
