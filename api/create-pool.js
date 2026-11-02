// Vercel serverless function: builds an UNSIGNED Raydium CPMM "create pool" transaction.
// The user's own wallet signs it in the browser. No private keys are used or stored here.
// Optional Vercel env vars: RPC_URL_DEVNET, RPC_URL_MAINNET (required for mainnet), ALLOWED_ORIGIN.
const {
  Raydium, TxVersion, DEVNET_PROGRAM_ID,
  CREATE_CPMM_POOL_PROGRAM, CREATE_CPMM_POOL_FEE_ACC, getCpmmPdaAmmConfigId,
} = require("@raydium-io/raydium-sdk-v2");
const { Connection, PublicKey } = require("@solana/web3.js");
const BN = require("bn.js");

const WSOL = "So11111111111111111111111111111111111111112";
const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
const TIERS = { "0.01%": 100, "0.05%": 500, "0.25%": 2500, "0.30%": 3000, "1%": 10000, "2%": 20000 };

function toUnits(value, decimals) {
  const s = String(value).trim();
  if (!/^\d+(\.\d+)?$/.test(s)) throw new Error("Invalid amount: " + s);
  const [i, f = ""] = s.split(".");
  const units = new BN((i + f.padEnd(decimals, "0").slice(0, decimals)).replace(/^0+(?=\d)/, ""), 10);
  if (units.isZero()) throw new Error("Amount must be greater than zero");
  return units;
}

module.exports = async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try {
    const { owner, mint, tokenAmount, solAmount, feeTier, network } = req.body || {};
    const devnet = network !== "mainnet-beta";
    const rpc = devnet ? (process.env.RPC_URL_DEVNET || "https://api.devnet.solana.com") : process.env.RPC_URL_MAINNET;
    if (!rpc) return res.status(500).json({ error: "RPC_URL_MAINNET is not set in Vercel." });
    const connection = new Connection(rpc, "confirmed");
    const ownerPk = new PublicKey(owner);
    const mintPk = new PublicKey(mint);

    const acc = await connection.getParsedAccountInfo(mintPk);
    const parsed = acc.value && acc.value.data && acc.value.data.parsed;
    if (!parsed || parsed.type !== "mint") throw new Error("That address is not a token mint on this network.");
    const tokenInfo = { address: mintPk.toBase58(), programId: acc.value.owner.toBase58(), decimals: parsed.info.decimals };
    const solInfo = { address: WSOL, programId: TOKEN_PROGRAM, decimals: 9 };

    // Raydium needs mintA to be the one with the smaller address.
    let mintA = tokenInfo, mintB = solInfo;
    let amountA = toUnits(tokenAmount, tokenInfo.decimals), amountB = toUnits(solAmount, 9);
    if (new BN(mintPk.toBytes()).gt(new BN(new PublicKey(WSOL).toBytes()))) {
      [mintA, mintB] = [mintB, mintA];
      [amountA, amountB] = [amountB, amountA];
    }

    const raydium = await Raydium.load({
      connection, owner: ownerPk, cluster: devnet ? "devnet" : "mainnet",
      disableFeatureCheck: true, disableLoadToken: true, blockhashCommitment: "finalized",
    });

    const configs = await raydium.api.getCpmmConfigs();
    if (devnet) configs.forEach((c) => { c.id = getCpmmPdaAmmConfigId(DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM, c.index).publicKey.toBase58(); });
    const feeConfig = configs.find((c) => c.tradeFeeRate === TIERS[feeTier]);
    if (!feeConfig) throw new Error("Fee tier " + feeTier + " is not available. Available: " + configs.map((c) => c.tradeFeeRate / 10000 + "%").join(", "));

    const { transaction, extInfo } = await raydium.cpmm.createPool({
      programId: devnet ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_PROGRAM : CREATE_CPMM_POOL_PROGRAM,
      poolFeeAccount: devnet ? DEVNET_PROGRAM_ID.CREATE_CPMM_POOL_FEE_ACC : CREATE_CPMM_POOL_FEE_ACC,
      mintA, mintB, mintAAmount: amountA, mintBAmount: amountB,
      startTime: new BN(0), feeConfig, associatedOnly: false,
      ownerInfo: { useSOLBalance: true }, txVersion: TxVersion.V0,
    });

    const poolId = extInfo && extInfo.address && extInfo.address.poolId;
    return res.status(200).json({
      tx: Buffer.from(transaction.serialize()).toString("base64"),
      poolId: poolId ? poolId.toString() : "",
    });
  } catch (e) {
    return res.status(500).json({ error: e.message || "Could not build the pool transaction" });
  }
};
