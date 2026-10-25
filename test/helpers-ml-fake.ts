// Shared harness for the ML helper tests (helpers-ml.test.ts, helpers-ml-align.test.ts):
// the helper source is evaluated in plain Node with a fake `require` that returns stub
// SDK modules and a fake document that logs every call.

import { HELPERS_SOURCE } from "../src/affinity/helpers.js";

export type Fn = (...a: any[]) => any;
export type Log = string[];

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** A logged transform chain: multiply joins the strings, toString gives 'T(a,b).S(k,k).T(c,d)'. */
function chain(s: string): any {
  return { s, multiply: (o: { s: string }) => chain(`${s}.${o.s}`), toString: () => s };
}

/**
 * Evaluates the helper block. axiTransparent (helpers-core.ts) is wrapped so each
 * call is recorded; the real one is used when it exists, else a stand-in that
 * does what it documents (DocumentProperties.isTransparent + setDocumentProperties).
 */
export function load(log: Log): Record<string, Fn> {
  const names = [...HELPERS_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);
  const extra = `
    var realT = typeof axiTransparent === 'function' ? axiTransparent : function (d, on) {
      const { DocumentProperties } = require('/documentproperties.js');
      const p = DocumentProperties.create();
      p.isTransparent = on !== false;
      d.setDocumentProperties(p);
      return d;
    };
    var axiTransparent = function (d, on) { LOG.push('transparent:' + on); return realT(d, on); };
  `;
  const body = `${HELPERS_SOURCE}\n${extra}\nreturn { ${names.join(", ")} };`;
  const modules: Record<string, unknown> = {
    "/commands.js": {
      DocumentCommand: {
        createRasterInvertSelection: () => (log.push("invert"), "cmd:invert"),
        createDeleteSelection: (_sel: unknown, flag: boolean) => (log.push(`delete:${flag}`), "cmd:delete"),
        createRasterDeselect: () => (log.push("deselect"), "cmd:deselect"),
        createSetVisibility: (_sel: unknown, vis: boolean) => (log.push(`visibility:${vis}`), "cmd:visibility"),
        createDuplicate: () => (log.push("createDuplicate"), "cmd:duplicate"),
        createGaussianBlurFilter: (sel: any, p: { radius: number }) => (log.push(`blur:${sel?.nodes?.first?.userDescription}:${p.radius}`), "cmd:blur"),
      },
      RasterSelectionLogicalOperation: { New: "op:New", Add: "op:Add", Subtract: "op:Subtract", Intersect: "op:Intersect" },
    },
    "/nodes.js": { GaussianBlurFilterParameters: { create: () => ({ radius: 0 }) } },
    "/geometry.js": {
      Transform: {
        createIdentity: () => "identity",
        createTranslate: (x: number, y: number) => chain(`T(${x},${y})`),
        createScale: (x: number, y: number) => chain(`S(${x},${y})`),
      },
    },
    "/selections.js": { Selection: { create: (_d: unknown, n: unknown) => ({ node: n }) } },
    "/documentproperties.js": { DocumentProperties: { create: () => ({}) } },
  };
  const req = (id: string) => {
    if (!(id in modules)) throw new Error(`unexpected require ${id}`);
    log.push(`require:${id}`);
    return modules[id];
  };
  return new Function("require", "LOG", body)(req, log) as Record<string, Fn>;
}

export interface Fake {
  doc: any;
  node: any;
  copy: any;
  log: Log;
  props: Array<Record<string, unknown>>;
}

export interface FakeOpts {
  subject?: boolean;
  image?: boolean;
  name?: string;
  duplicate?: boolean;
  /** The layer's content box in document px (identity transform). Default 100x100 at (0,0). */
  box?: Rect;
  /** A picture frame the node sits in (its box), or absent for no frame. */
  frame?: Rect;
  /** The box the layer shrinks to after removeBackground or the subject delete. */
  shrinkTo?: Rect;
}

/** A SDK-style baseBoxInterface (width/height) for a document-px rectangle. */
const baseOf = (r: Rect) => ({ baseBox: { x: r.x, y: r.y, width: r.w, height: r.h } });
const identity = { applyToPoint: (p: { x: number; y: number }) => p };

/** A fake document: selection, pixel selection and a logged command executor. */
export function fakeDoc(opts: FakeOpts = {}): Fake {
  const log: Log = [];
  const props: Array<Record<string, unknown>> = [];
  const copy: any = { userDescription: "photo", isImageNode: false };
  const node: any = {
    userDescription: opts.name ?? "photo",
    isImageNode: !!opts.image,
    parent: opts.frame ? { pictureFrameEnabled: true, baseBoxInterface: baseOf(opts.frame), transform: identity } : null,
    baseBoxInterface: baseOf(opts.box ?? { x: 0, y: 0, w: 100, h: 100 }),
    transform: identity,
  };
  const shrink = () => {
    if (opts.shrinkTo) node.baseBoxInterface = baseOf(opts.shrinkTo);
  };
  if (opts.duplicate !== false) node.duplicate = (xf: unknown) => (log.push(`duplicate:${xf}`), copy);
  let sel: any = null;
  const doc: any = {
    rasterSelection: { isSelectNone: true },
    get selection() {
      return { nodes: { first: sel } };
    },
    set selection(v: any) {
      sel = v;
      log.push(`select:${v === node ? "node" : v === copy ? "copy" : "other"}`);
    },
    removeBackground: () => {
      log.push("removeBackground");
      shrink();
    },
    selectSubject: () => {
      log.push("selectSubject");
      doc.rasterSelection.isSelectNone = opts.subject === false;
    },
    detectDepth: () => log.push(`detectDepth:${sel === copy ? "copy" : "node"}`),
    colourise: () => log.push("colourise"),
    setRasterSelectionFromObject: (n: any, intensity: boolean, op: string) => {
      log.push(`selectFrom:${n === copy ? "copy" : "other"}:${intensity}:${op}`);
      doc.rasterSelection.isSelectNone = false;
    },
    rasteriseObjects: () => {
      log.push("rasteriseObjects");
      node.isImageNode = false;
    },
    executeCommand: (c: string) => {
      log.push(`exec:${c}`);
      if (c === "cmd:deselect") doc.rasterSelection.isSelectNone = true;
      if (c === "cmd:delete") shrink();
    },
    applyTransform: (xf: unknown) => log.push(`applyTransform:${xf}`),
    setDocumentProperties: (p: Record<string, unknown>) => {
      props.push(p);
      log.push("setDocumentProperties");
    },
  };
  return { doc, node, copy, log, props };
}

/** The SDK calls in `log`, without selection and require bookkeeping. */
export const calls = (log: Log) => log.filter((l) => !l.startsWith("select:") && !l.startsWith("require:"));
