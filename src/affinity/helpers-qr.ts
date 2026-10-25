// QR-code helper for run --with-helpers. Same rules as helpers-core.ts
// (function declarations prefixed axi, requires inside functions, nothing
// blocking or generative, String.raw so no backticks, dollar-brace or
// backslash surprises).
//
// SDK classes used: ShapeQRCode with a typed payload (QRPayloadURL, Text,
// WhatsApp, Wifi, VCard, Location, Phone, SMS, Email) from /shapes.js, placed
// by ShapeNodeDefinition.create like any other shape. The code is native
// vector geometry: the brush fill colours the modules and a stroke would break
// their geometry, so none is set. Wifi encryption is WifiEncryptionType
// {None, WEP, WPA_WPA2} (read live, 3.3.1.4940).
//
// Validation runs before any require(), so a bad payload throws without
// touching the document.

import type { HelperInfo } from "./helpers-core.js";

export const QR_INDEX: readonly HelperInfo[] = [
  {
    name: "axiQR",
    signature: "axiQR(doc, {x,y,size,payload,fill,bg,quiet,name})",
    summary:
      "native QR code in the square x,y,size (px). payload: {type:'url',url} | {type:'text',text} | {type:'whatsapp',number,content?} | {type:'wifi',ssid,password?,encryption?:'wpa'|'wep'|'none',hidden?} | {type:'vcard',firstName?,lastName?,phone?,email?,website?,company?,jobTitle?} | {type:'location',latitude,longitude} | {type:'phone',number} | {type:'sms',number,content} | {type:'email',address,subject?}. fill is the module colour (default #000000); bg draws a square behind it with quiet px of margin (default size*0.1), named <name>-bg. Any hex is accepted; keep dark modules on a light ground (contrast 4:1 or better, never inverted) or phones will not scan, and a warning is logged when bg and fill are too close. Returns the QR node",
  },
];

/** Internal building blocks, not in the index. */
export const QR_INTERNAL: readonly string[] = ["axiQRPayload"];

export const QR_SOURCE: string = String.raw`
/* ---- QR-code helper ---- */

// Internal: a typed QR payload object for p ({type, ...fields}). Every field is
// checked before any SDK module is loaded; the SDK's own validity flags are
// checked after the values are set. Throws 'axiQR: ...' on anything wrong.
function axiQRPayload(p) {
  if (!p || typeof p !== 'object' || typeof p.type !== 'string') { throw new Error('axiQR: payload must be an object with a type'); }
  const type = p.type.toLowerCase();
  const str = function (v, what, optional) {
    if (v === undefined || v === null) {
      if (optional) { return undefined; }
      throw new Error('axiQR: ' + type + ' payload needs ' + what);
    }
    if (typeof v !== 'string' || v === '') { throw new Error('axiQR: ' + what + ' must be a non-empty string'); }
    return v;
  };
  const num = function (v, what) {
    if (typeof v !== 'string' || !/^[+]?[0-9]{5,15}$/.test(v)) { throw new Error('axiQR: ' + what + ' must be digits with an optional leading +, 5 to 15 of them (got ' + JSON.stringify(v) + ')'); }
    return v;
  };
  const web = function (v, what) {
    if (typeof v !== 'string' || !/^https?:[/][/][^ ]+$/.test(v)) { throw new Error('axiQR: ' + what + ' must start with http:// or https:// (got ' + JSON.stringify(v) + ')'); }
    return v;
  };
  const mail = function (v, what) {
    if (typeof v !== 'string' || !/^[^ @]+@[^ @]+[.][^ @]+$/.test(v)) { throw new Error('axiQR: ' + what + ' must be an email address (got ' + JSON.stringify(v) + ')'); }
    return v;
  };
  const coord = function (v, what, lim) {
    if (typeof v !== 'number' || !isFinite(v) || v < -lim || v > lim) { throw new Error('axiQR: ' + what + ' must be a number within +-' + lim + ' (got ' + v + ')'); }
    return v;
  };
  const known = 'url, text, whatsapp, wifi, vcard, location, phone, sms, email';
  let v;
  if (type === 'url') { v = { url: web(p.url, 'url') }; }
  else if (type === 'text') { v = { text: str(p.text, 'text') }; }
  else if (type === 'whatsapp') { v = { number: num(p.number, 'number'), content: str(p.content, 'content', true) }; }
  else if (type === 'wifi') {
    const enc = p.encryption === undefined ? 'wpa' : String(p.encryption).toLowerCase();
    if (enc !== 'wpa' && enc !== 'wep' && enc !== 'none') { throw new Error('axiQR: wifi encryption must be wpa, wep or none (got ' + p.encryption + ')'); }
    if (p.hidden !== undefined && typeof p.hidden !== 'boolean') { throw new Error('axiQR: wifi hidden must be true or false'); }
    v = { ssid: str(p.ssid, 'ssid'), password: str(p.password, 'password', true), enc: enc, hidden: p.hidden };
  }
  else if (type === 'vcard') {
    v = {
      firstName: str(p.firstName, 'firstName', true), lastName: str(p.lastName, 'lastName', true),
      phone: p.phone === undefined ? undefined : num(p.phone, 'phone'),
      email: p.email === undefined ? undefined : mail(p.email, 'email'),
      website: p.website === undefined ? undefined : web(p.website, 'website'),
      company: str(p.company, 'company', true), jobTitle: str(p.jobTitle, 'jobTitle', true),
    };
    if (v.firstName === undefined && v.lastName === undefined) { throw new Error('axiQR: vcard payload needs firstName or lastName'); }
  }
  else if (type === 'location') { v = { latitude: coord(p.latitude, 'latitude', 90), longitude: coord(p.longitude, 'longitude', 180) }; }
  else if (type === 'phone') { v = { number: num(p.number, 'number') }; }
  else if (type === 'sms') { v = { number: num(p.number, 'number'), content: str(p.content, 'content') }; }
  else if (type === 'email') { v = { address: mail(p.address, 'address'), subject: str(p.subject, 'subject', true) }; }
  else { throw new Error('axiQR: unknown payload type ' + JSON.stringify(p.type) + '; use one of ' + known); }

  const S = require('/shapes.js');
  const put = function (obj, fields) {
    Object.keys(fields).forEach(function (k) { if (fields[k] !== undefined) { obj[k] = fields[k]; } });
    return obj;
  };
  if (type === 'url') {
    const o = put(S.QRPayloadURL.create(), v);
    if (o.isURLValid === false) { throw new Error('axiQR: url rejected by Affinity: ' + v.url); }
    return o;
  }
  if (type === 'text') { return put(S.QRPayloadText.create(), v); }
  if (type === 'whatsapp') { return put(S.QRPayloadWhatsApp.create(), v); }
  if (type === 'wifi') {
    const members = { wpa: S.WifiEncryptionType.WPA_WPA2, wep: S.WifiEncryptionType.WEP, none: S.WifiEncryptionType.None };
    // isSSIDValid is not checked: live it simply mirrors the hidden flag, so it says nothing about the name.
    return put(S.QRPayloadWifi.create(), { ssid: v.ssid, password: v.password, encryption: members[v.enc], hidden: v.hidden });
  }
  if (type === 'vcard') { return put(S.QRPayloadVCard.create(), v); }
  if (type === 'location') { return put(S.QRPayloadLocation.create(), v); }
  if (type === 'phone') { return put(S.QRPayloadPhone.create(), v); }
  if (type === 'sms') {
    const o = put(S.QRPayloadSMS.create(), v);
    if (o.isNumberValid === false) { throw new Error('axiQR: sms number rejected by Affinity: ' + v.number); }
    return o;
  }
  const o = put(S.QRPayloadEmail.create(), v);
  if (o.isAddressValid === false) { throw new Error('axiQR: email address rejected by Affinity: ' + v.address); }
  return o;
}

// Native QR code filling the square x,y,size. fill is the module colour
// (default #000000); bg (optional hex) draws a square behind the code, quiet px
// larger on every side (default size*0.1) and named <name>-bg. Any colours are
// accepted, but a bg and fill that are close, or a light code on a dark ground,
// log a warning because phones will not scan them. Returns the QR node, which
// stays selected.
function axiQR(doc, o) {
  if (!o || typeof o !== 'object') { throw new Error('axiQR: options {x,y,size,payload} are required'); }
  if (typeof o.x !== 'number' || typeof o.y !== 'number' || !isFinite(o.x) || !isFinite(o.y)) { throw new Error('axiQR: x and y are required numbers'); }
  if (typeof o.size !== 'number' || !isFinite(o.size) || !(o.size > 0)) { throw new Error('axiQR: size is required and must be positive'); }
  const quiet = o.quiet === undefined ? o.size * 0.1 : o.quiet;
  if (typeof quiet !== 'number' || !isFinite(quiet) || quiet < 0) { throw new Error('axiQR: quiet must be 0 or more'); }
  const rgb = function (hex, what) {
    let h = String(hex).replace('#', '');
    if (h.length === 3) { h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2]; }
    if (!/^[0-9a-fA-F]{6}$/.test(h)) { throw new Error('axiQR: ' + what + ' must be a hex colour (got ' + hex + ')'); }
    return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
  };
  const lum = function (c) {
    const l = c.map(function (u) { const s = u / 255; return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4); });
    return 0.2126 * l[0] + 0.7152 * l[1] + 0.0722 * l[2];
  };
  const fill = o.fill === undefined ? '#000000' : o.fill;
  const fc = rgb(fill, 'fill');
  const bc = o.bg === undefined || o.bg === null ? null : rgb(o.bg, 'bg');
  const payload = axiQRPayload(o.payload);
  const warnings = [];
  if (bc) {
    const a = lum(fc);
    const b = lum(bc);
    const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
    if (a > b) { warnings.push('axiQR: warning: the modules (' + fill + ') are lighter than the background (' + o.bg + '); many phone scanners cannot read an inverted code'); }
    else if (ratio < 4) { warnings.push('axiQR: warning: contrast between ' + fill + ' and ' + o.bg + ' is ' + ratio.toFixed(1) + ':1; use 4:1 or better so phones can scan it'); }
  }
  axiQR.warnings = warnings;
  warnings.forEach(function (w) { console.log(w); });

  axiSurface(doc);
  if (bc) {
    axiRect(doc, { x: o.x - quiet, y: o.y - quiet, w: o.size + 2 * quiet, h: o.size + 2 * quiet, fill: o.bg, name: o.name ? o.name + '-bg' : undefined });
  }
  const { ShapeQRCode } = require('/shapes.js');
  const { ShapeNodeDefinition } = require('/nodes.js');
  const qr = ShapeQRCode.create();
  qr.payload = payload;
  doc.addNode(ShapeNodeDefinition.create(qr, { x: o.x, y: o.y, width: o.size, height: o.size }, axiHex(fill), null, null));
  return axiName(doc.selection.nodes.first, o.name);
}
`;
