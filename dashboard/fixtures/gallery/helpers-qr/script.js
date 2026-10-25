// A QR code for a link, placed with the qr helper from --with-helpers.
const doc = Document.current;
axiQr(doc, "https://example.com", { x: 80, y: 80, size: 240 });
console.log("qr placed");
