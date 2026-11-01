// Vercel serverless function: uploads token image + metadata JSON to IPFS via Pinata.
// Set PINATA_JWT (and optionally ALLOWED_ORIGIN) in Vercel Environment Variables.
// Never put the Pinata JWT in index.html.
const G = "https://gateway.pinata.cloud/ipfs/";
module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { name, symbol, description, image, telegram, website, twitter } = req.body || {};
    if (!name || name.length > 32 || !symbol || symbol.length > 8) return res.status(400).json({ error: "Invalid name or symbol" });
    if (!image || !image.startsWith("data:image/png;base64,")) return res.status(400).json({ error: "PNG image required" });
    const buf = Buffer.from(image.split(",")[1], "base64");
    if (buf.length > 1048576) return res.status(400).json({ error: "Image over 1 MB" });
    const auth = { Authorization: "Bearer " + process.env.PINATA_JWT };
    const fd = new FormData();
    fd.append("file", new Blob([buf], { type: "image/png" }), "token.png");
    const r1 = await fetch("https://api.pinata.cloud/pinning/pinFileToIPFS", { method: "POST", headers: auth, body: fd });
    const j1 = await r1.json();
    if (!r1.ok) throw new Error("Image upload failed");
    const meta = { name, symbol, description: description || "", image: G + j1.IpfsHash,
      extensions: { website: website || undefined, twitter: twitter || undefined, telegram: telegram || undefined } };
    const r2 = await fetch("https://api.pinata.cloud/pinning/pinJSONToIPFS", {
      method: "POST", headers: { ...auth, "Content-Type": "application/json" }, body: JSON.stringify({ pinataContent: meta }) });
    const j2 = await r2.json();
    if (!r2.ok) throw new Error("Metadata upload failed");
    return res.status(200).json({ uri: G + j2.IpfsHash });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Upload failed" });
  }
}
