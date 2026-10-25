// axiQR: source hygiene, validation before any SDK call, payload construction
// against a recording fake of /shapes.js and /nodes.js, background and contrast
// handling. The live behaviour (rendering, scanning) is covered by the
// helpers-qr example and the unit's live check.

import { Script } from "node:vm";
import { describe, expect, it } from "vitest";
import { scanForAi, scanForBlocking } from "../src/affinity/guard.js";
import { HELPERS_SOURCE } from "../src/affinity/helpers.js";
import { QR_INDEX, QR_INTERNAL, QR_SOURCE } from "../src/affinity/helpers-qr.js";

type Fn = (...a: any[]) => any;
type Rec = Record<string, any>;

// --- source hygiene ---------------------------------------------------------

describe("QR_SOURCE", () => {
  const declared = [...QR_SOURCE.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!);

  it("parses as plain JS, alone and after the other helpers", () => {
    expect(() => new Script(QR_SOURCE)).not.toThrow();
    expect(() => new Script(HELPERS_SOURCE.includes("function axiQR(") ? HELPERS_SOURCE : HELPERS_SOURCE + QR_SOURCE)).not.toThrow();
  });

  it("passes the blocking and AI guards and has no close or dialog call", () => {
    expect(scanForBlocking(QR_SOURCE)).toEqual([]);
    expect(scanForAi(QR_SOURCE)).toEqual([]);
    expect(QR_SOURCE).not.toMatch(/close\s*\(|closeAsync|dialog\.js/);
  });

  it("has no backtick or dollar-brace (it lives in a String.raw block)", () => {
    expect(QR_SOURCE).not.toContain("`");
    expect(QR_SOURCE).not.toContain("${");
  });

  it("declares every indexed helper, and everything else is listed as internal", () => {
    for (const h of QR_INDEX) {
      expect(declared).toContain(h.name);
      expect(h.signature.startsWith(h.name + "(")).toBe(true);
      expect(h.summary).not.toBe("");
    }
    expect(declared.filter((n) => !QR_INDEX.some((h) => h.name === n)).sort()).toEqual([...QR_INTERNAL].sort());
    expect(new Set(declared).size).toBe(declared.length);
  });

  it("uses function declarations only, all prefixed axi, and no top-level statements", () => {
    const top = QR_SOURCE.split("\n").filter((l) => /^\S/.test(l) && !l.startsWith("//") && !l.startsWith("/*") && l !== "}");
    for (const l of top) expect(l).toMatch(/^function axi[A-Z]\w*\(/);
  });

  it("keeps every require() inside a function", () => {
    for (const line of QR_SOURCE.split("\n")) if (line.includes("require(")) expect(line).toMatch(/^\s+/);
  });

  it("declares no name twice across the other helpers (safe before and after the splice)", () => {
    for (const n of declared) expect(HELPERS_SOURCE.split(`function ${n}(`).length - 1).toBeLessThanOrEqual(1);
  });

  it("does not use the generative or document-closing APIs", () => {
    expect(QR_SOURCE).not.toMatch(/generat|\.close\b/i);
  });
});

// --- fake SDK ---------------------------------------------------------------

/** A payload class whose instances record every property assignment. */
function payloadClass(name: string, extra: Rec = {}) {
  return {
    create() {
      const o: Rec = { _type: name, ...extra };
      return o;
    },
  };
}

interface Rig {
  h: Record<string, Fn>;
  doc: Rec;
  log: string[];
  added: Rec[];
  requires: string[];
  shape: Rec;
  logs: string[];
}

function rig(opts: { urlValid?: boolean; ssidValid?: boolean } = {}): Rig {
  const log: string[] = [];
  const added: Rec[] = [];
  const requires: string[] = [];
  const logs: string[] = [];
  const shape: Rec = {};
  const ENC = { None: { n: "None" }, WEP: { n: "WEP" }, WPA_WPA2: { n: "WPA_WPA2" } };
  const modules: Record<string, Rec> = {
    "/colours.js": { RGBA8: (r: number, g: number, b: number, a: number) => ({ r, g, b, a }) },
    "/shapes.js": {
      QRPayloadURL: payloadClass("url", { isURLValid: opts.urlValid ?? true }),
      QRPayloadText: payloadClass("text"),
      QRPayloadWhatsApp: payloadClass("whatsapp"),
      QRPayloadWifi: payloadClass("wifi", { isSSIDValid: opts.ssidValid ?? true }),
      QRPayloadVCard: payloadClass("vcard"),
      QRPayloadLocation: payloadClass("location"),
      QRPayloadPhone: payloadClass("phone"),
      QRPayloadSMS: payloadClass("sms", { isNumberValid: true }),
      QRPayloadEmail: payloadClass("email", { isAddressValid: true }),
      WifiEncryptionType: ENC,
      ShapeQRCode: {
        create() {
          const s: Rec = { _kind: "qr" };
          shape.last = s;
          return s;
        },
      },
      ShapeRectangle: { create: () => ({ _kind: "rect" }) },
      ShapeCornerType: { Round: "round" },
    },
    "/linestyle.js": { LineStyle: {}, LineStyleDescriptor: {} },
    "/nodes.js": {
      ShapeNodeDefinition: {
        create(s: Rec, box: Rec, fill: Rec | null, st: unknown, ls: unknown) {
          return { s, box, fill, st, ls };
        },
      },
    },
  };
  const doc: Rec = {
    selection: { nodes: { first: null as Rec | null } },
    addNode(def: Rec) {
      const node: Rec = { def, userDescription: "" };
      added.push(node);
      log.push(def.s._kind);
      doc.selection.nodes.first = node;
    },
  };
  // Once the lead splices QR_SOURCE into HELPERS_SOURCE it is already there; do not append it twice.
  const src = HELPERS_SOURCE.includes("function axiQR(") ? HELPERS_SOURCE : HELPERS_SOURCE + QR_SOURCE;
  const names = [...new Set([...src.matchAll(/^function (axi\w+)\(/gm)].map((m) => m[1]!))];
  const body = `${src}\nreturn { ${names.join(", ")} };`;
  const consoleStub = { log: (s: string) => logs.push(s) };
  const h = new Function("require", "console", body)((id: string) => {
    requires.push(id);
    const m = modules[id];
    if (!m) throw new Error("SDK not available in tests: " + id);
    return m;
  }, consoleStub) as Record<string, Fn>;
  return { h, doc, log, added, requires, shape, logs };
}

const URL_PAYLOAD = { type: "url", url: "https://example.com/lumen" };
const ok = { x: 100, y: 200, size: 300, payload: URL_PAYLOAD };

// --- validation happens before any require() --------------------------------

describe("axiQR validation", () => {
  const bad: Array<[string, Rec, RegExp]> = [
    ["no options", undefined as unknown as Rec, /options .* are required/],
    ["missing size", { ...ok, size: undefined }, /size is required/],
    ["zero size", { ...ok, size: 0 }, /size is required/],
    ["negative size", { ...ok, size: -5 }, /size is required/],
    ["missing x", { ...ok, x: undefined }, /x and y are required/],
    ["negative quiet", { ...ok, quiet: -1 }, /quiet must be 0 or more/],
    ["bad fill", { ...ok, fill: "red" }, /fill must be a hex colour/],
    ["bad bg", { ...ok, bg: "#12" }, /bg must be a hex colour/],
    ["missing payload", { ...ok, payload: undefined }, /payload must be an object with a type/],
    ["unknown type", { ...ok, payload: { type: "bitcoin" } }, /unknown payload type "bitcoin"; use one of url, text/],
    ["url without scheme", { ...ok, payload: { type: "url", url: "example.com" } }, /url must start with http/],
    ["javascript url", { ...ok, payload: { type: "url", url: "javascript:alert(1)" } }, /url must start with http/],
    ["empty text", { ...ok, payload: { type: "text", text: "" } }, /text must be a non-empty string/],
    ["whatsapp letters", { ...ok, payload: { type: "whatsapp", number: "+49abc" } }, /number must be digits/],
    ["whatsapp too short", { ...ok, payload: { type: "whatsapp", number: "123" } }, /number must be digits/],
    ["wifi without ssid", { ...ok, payload: { type: "wifi" } }, /wifi payload needs ssid/],
    ["wifi bad encryption", { ...ok, payload: { type: "wifi", ssid: "lab", encryption: "wpa3" } }, /encryption must be wpa, wep or none/],
    ["wifi hidden string", { ...ok, payload: { type: "wifi", ssid: "lab", hidden: "yes" } }, /hidden must be true or false/],
    ["vcard without a name", { ...ok, payload: { type: "vcard", phone: "+15550100" } }, /needs firstName or lastName/],
    ["vcard bad email", { ...ok, payload: { type: "vcard", firstName: "A", email: "nope" } }, /email must be an email address/],
    ["vcard bad website", { ...ok, payload: { type: "vcard", firstName: "A", website: "ftp://x" } }, /website must start with http/],
    ["latitude 91", { ...ok, payload: { type: "location", latitude: 91, longitude: 0 } }, /latitude must be a number within \+-90/],
    ["longitude -181", { ...ok, payload: { type: "location", latitude: 0, longitude: -181 } }, /longitude must be a number within \+-180/],
    ["latitude as string", { ...ok, payload: { type: "location", latitude: "1", longitude: 0 } }, /latitude must be a number/],
    ["phone with spaces", { ...ok, payload: { type: "phone", number: "+49 151 123" } }, /number must be digits/],
    ["sms without content", { ...ok, payload: { type: "sms", number: "+15550100" } }, /sms payload needs content/],
    ["email without @", { ...ok, payload: { type: "email", address: "studio.example.com" } }, /address must be an email address/],
  ];
  for (const [label, o, re] of bad) {
    it(`rejects ${label} before touching the SDK`, () => {
      const r = rig();
      expect(() => r.h.axiQR(r.doc, o)).toThrow(re);
      expect(r.requires).toEqual([]);
      expect(r.added).toEqual([]);
    });
  }

  it("rejects a url that Affinity itself reports invalid, after setting it", () => {
    const r = rig({ urlValid: false });
    expect(() => r.h.axiQR(r.doc, ok)).toThrow(/axiQR: url rejected by Affinity/);
    expect(r.added).toEqual([]);
  });

  it("does not trust isSSIDValid (live it mirrors the hidden flag): a wifi code is still built", () => {
    const r = rig({ ssidValid: false });
    expect(r.h.axiQRPayload({ type: "wifi", ssid: "lab" })).toMatchObject({ ssid: "lab" });
  });
});

// --- payload construction ---------------------------------------------------

describe("axiQRPayload", () => {
  const build = (p: Rec) => {
    const r = rig();
    return r.h.axiQRPayload(p) as Rec;
  };

  it("url: builds QRPayloadURL and sets url", () => {
    expect(build(URL_PAYLOAD)).toMatchObject({ _type: "url", url: "https://example.com/lumen" });
  });

  it("text", () => {
    expect(build({ type: "text", text: "hello" })).toMatchObject({ _type: "text", text: "hello" });
  });

  it("whatsapp: number, optional content", () => {
    expect(build({ type: "whatsapp", number: "+15550100123", content: "Hi" })).toMatchObject({ _type: "whatsapp", number: "+15550100123", content: "Hi" });
    expect("content" in build({ type: "whatsapp", number: "15550100123" })).toBe(false);
  });

  it("wifi: encryption maps to the SDK enum members, WPA_WPA2 by default", () => {
    expect(build({ type: "wifi", ssid: "lab", password: "pw" })).toMatchObject({ _type: "wifi", ssid: "lab", password: "pw", encryption: { n: "WPA_WPA2" } });
    expect(build({ type: "wifi", ssid: "lab", encryption: "wep" }).encryption).toEqual({ n: "WEP" });
    expect(build({ type: "wifi", ssid: "lab", encryption: "NONE", hidden: true })).toMatchObject({ encryption: { n: "None" }, hidden: true });
  });

  it("vcard: sets only the given fields", () => {
    const v = build({ type: "vcard", firstName: "Mia", lastName: "Lumen", phone: "+15550100", email: "mia@example.com", website: "https://example.com", company: "Lumen Studio", jobTitle: "Owner" });
    expect(v).toMatchObject({ _type: "vcard", firstName: "Mia", lastName: "Lumen", phone: "+15550100", email: "mia@example.com", website: "https://example.com", company: "Lumen Studio", jobTitle: "Owner" });
    expect("company" in build({ type: "vcard", lastName: "Lumen" })).toBe(false);
  });

  it("location: accepts the limits", () => {
    expect(build({ type: "location", latitude: 90, longitude: -180 })).toMatchObject({ _type: "location", latitude: 90, longitude: -180 });
  });

  it("phone, sms, email", () => {
    expect(build({ type: "phone", number: "+15550100" })).toMatchObject({ _type: "phone", number: "+15550100" });
    expect(build({ type: "sms", number: "+15550100", content: "Book me" })).toMatchObject({ _type: "sms", number: "+15550100", content: "Book me" });
    expect(build({ type: "email", address: "hi@example.com", subject: "Hello" })).toMatchObject({ _type: "email", address: "hi@example.com", subject: "Hello" });
  });

  it("the type is case-insensitive", () => {
    expect(build({ type: "URL", url: "http://example.com" })._type).toBe("url");
  });
});

// --- axiQR placement --------------------------------------------------------

describe("axiQR", () => {
  it("adds one QR shape with a black fill, the box and no stroke, and returns the node", () => {
    const r = rig();
    const node = r.h.axiQR(r.doc, { ...ok, name: "lumen-url" });
    expect(r.log).toEqual(["qr"]);
    expect(node).toBe(r.added[0]);
    expect(node.userDescription).toBe("lumen-url");
    expect(node.def.box).toEqual({ x: 100, y: 200, width: 300, height: 300 });
    expect(node.def.fill).toEqual({ r: 0, g: 0, b: 0, a: 255 });
    expect(node.def.st).toBeNull();
    expect(node.def.ls).toBeNull();
    expect(r.shape.last.payload).toMatchObject({ _type: "url", url: "https://example.com/lumen" });
  });

  it("uses the fill colour as given", () => {
    const r = rig();
    const node = r.h.axiQR(r.doc, { ...ok, fill: "#1F2A44" });
    expect(node.def.fill).toEqual({ r: 0x1f, g: 0x2a, b: 0x44, a: 255 });
  });

  it("leaves the name unset when none is given", () => {
    const r = rig();
    expect(r.h.axiQR(r.doc, ok).userDescription).toBe("");
  });

  it("bg adds the rect first, quiet px larger on every side (default 10 percent), then the QR", () => {
    const r = rig();
    const node = r.h.axiQR(r.doc, { ...ok, bg: "#F2F5F9", fill: "#1F2A44", name: "lumen-url" });
    expect(r.log).toEqual(["rect", "qr"]);
    const bg = r.added[0]!;
    expect(bg.userDescription).toBe("lumen-url-bg");
    expect(bg.def.box).toEqual({ x: 70, y: 170, width: 360, height: 360 });
    expect(bg.def.fill).toEqual({ r: 0xf2, g: 0xf5, b: 0xf9, a: 255 });
    expect(node.def.box).toEqual({ x: 100, y: 200, width: 300, height: 300 });
  });

  it("an explicit quiet overrides the default, and 0 is allowed", () => {
    const r = rig();
    r.h.axiQR(r.doc, { ...ok, bg: "#FFFFFF", quiet: 20 });
    expect(r.added[0]!.def.box).toEqual({ x: 80, y: 180, width: 340, height: 340 });
    const r0 = rig();
    r0.h.axiQR(r0.doc, { ...ok, bg: "#FFFFFF", quiet: 0 });
    expect(r0.added[0]!.def.box).toEqual({ x: 100, y: 200, width: 300, height: 300 });
  });

  it("draws no background without bg", () => {
    const r = rig();
    r.h.axiQR(r.doc, ok);
    expect(r.log).toEqual(["qr"]);
  });
});

// --- contrast warning -------------------------------------------------------

describe("axiQR contrast", () => {
  it("accepts any hex and stays silent for ink on mist", () => {
    const r = rig();
    r.h.axiQR(r.doc, { ...ok, fill: "#1F2A44", bg: "#F2F5F9" });
    expect(r.logs).toEqual([]);
    expect(r.h.axiQR.warnings).toEqual([]);
  });

  it("warns, but still draws, when fill and bg are close", () => {
    const r = rig();
    const node = r.h.axiQR(r.doc, { ...ok, fill: "#8899AA", bg: "#99AABB" });
    expect(node).toBeTruthy();
    expect(r.logs).toHaveLength(1);
    expect(r.logs[0]).toMatch(/axiQR: warning: contrast between #8899AA and #99AABB is 1\.\d:1/);
    expect(r.h.axiQR.warnings).toEqual(r.logs);
  });

  it("warns about an inverted code (light modules on a dark ground)", () => {
    const r = rig();
    r.h.axiQR(r.doc, { ...ok, fill: "#FFFFFF", bg: "#000000" });
    expect(r.logs[0]).toMatch(/lighter than the background .* inverted/);
  });

  it("does not warn when there is no bg (the ground is unknown)", () => {
    const r = rig();
    r.h.axiQR(r.doc, { ...ok, fill: "#FFFFFF" });
    expect(r.logs).toEqual([]);
  });

  it("resets the warnings on each call", () => {
    const r = rig();
    r.h.axiQR(r.doc, { ...ok, fill: "#8899AA", bg: "#99AABB" });
    r.h.axiQR(r.doc, { ...ok, fill: "#000000", bg: "#FFFFFF" });
    expect(r.h.axiQR.warnings).toEqual([]);
  });
});
