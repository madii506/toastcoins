'use strict';
/*
 * TOAST — find the dead coins in a Solana wallet, burn them, close their token accounts, and send the
 * rent back to the owner. Free: no fee is taken.
 *
 * One serverless function behind /api/*. It never holds keys or funds: it reads the chain, builds
 * unsigned transactions (burn + close, owner as the only signer and as the rent destination),
 * simulates every one of them, and hands them to the user's own wallet to sign.
 *
 * Routes
 *   GET  /api/config                 public settings (CA, X)
 *   GET  /api/scan?owner=<address>   every token account of the wallet, priced and classified
 *   POST /api/tx                     {owner, accounts:[...]} -> simulated, unsigned transactions
 *   POST /api/send                   relay a signed transaction
 *   GET  /api/status?sig=            confirmation status
 */
const { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } = require('@solana/web3.js');
const { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID, NATIVE_MINT, createBurnCheckedInstruction, createCloseAccountInstruction } = require('@solana/spl-token');

/* ---------------- settings ---------------- */
const E = (k, d = '') => String(process.env[k] == null ? d : process.env[k]).trim();
const CONFIG = { ca: E('TOAST_CA', ''), x: E('TOAST_X', '') };
const RPCS = [E('RPC_URL'), 'https://solana-rpc.publicnode.com', 'https://api.mainnet-beta.solana.com'].filter(Boolean);
const METADATA_PROGRAM = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');
const LAUNCHPAD_SUFFIX = /(pump|bonk)$/;      // only coins from these launchpads can be burned
const MAX_BURN_USD = 25;                       // server-side guard: never burn a coin worth more than this
const MAX_ACCOUNTS = 240;                      // per /api/tx request

/* ---------------- http + rpc helpers ---------------- */
function send(res, code, body, cache) {
  res.setHeader('Cache-Control', cache || 'no-store');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'content-type');
  res.status(code).send(JSON.stringify(body));
}
function http(code, msg) { const e = new Error(msg); e.code = code; return e; }
async function readBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (e) { return {}; } }
  return await new Promise(r => { let d = ''; req.on('data', c => { d += c; if (d.length > 4e5) d = ''; }); req.on('end', () => { try { r(JSON.parse(d || '{}')); } catch (e) { r({}); } }); });
}
function timedFetch(ms) {
  return (url, opt = {}) => { const c = new AbortController(); const t = setTimeout(() => c.abort(), ms); return fetch(url, { ...opt, signal: c.signal }).finally(() => clearTimeout(t)); };
}
const conns = RPCS.map(u => new Connection(u, { commitment: 'confirmed', disableRetryOnRateLimit: true, fetch: timedFetch(20000) }));
async function rpc(fn) {
  let last;
  for (const c of conns) { try { return await fn(c); } catch (e) { last = e; } }
  throw http(502, 'Solana RPC is busy, try again in a moment. (' + String(last && last.message || last).slice(0, 120) + ')');
}
async function getJson(url, ms = 8000) {
  const r = await timedFetch(ms)(url, { headers: { accept: 'application/json', 'user-agent': 'toast/1.0' } });
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return await r.json();
}
const mem = {};
async function cached(key, ms, fn) {
  const c = mem[key];
  if (c && Date.now() - c.t < ms) return c.v;
  const v = await fn(); mem[key] = { t: Date.now(), v }; return v;
}
function pk(s, what = 'address') { try { return new PublicKey(String(s || '').trim()); } catch (e) { throw http(400, 'Invalid ' + what); } }
async function chunked(arr, size, fn, par = 3) {
  const parts = []; for (let i = 0; i < arr.length; i += size) parts.push(arr.slice(i, i + size));
  const out = new Array(parts.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(par, parts.length) }, async () => { while (next < parts.length) { const i = next++; out[i] = await fn(parts[i]); } }));
  return out.flat();
}

/* ---------------- market data ---------------- */
// DexScreener: price, liquidity, name, symbol, image for every mint that still has a pair.
// Returns { map, failed }: `failed` holds mints whose price could not be checked (never treated as dead).
async function market(mints) {
  const map = {}, failed = new Set();
  const need = mints.filter(m => { const c = mem['mk:' + m]; if (c && Date.now() - c.t < 60000) { map[m] = c.v; return false; } return true; });
  await chunked(need, 30, async part => {
    let pairs = null;
    for (let i = 0; i < 2 && !pairs; i++) {
      try { pairs = await getJson('https://api.dexscreener.com/tokens/v1/solana/' + part.join(',')); }
      catch (e) { if (i === 0) await new Promise(r => setTimeout(r, 600)); }
    }
    if (!Array.isArray(pairs)) { part.forEach(m => failed.add(m)); return []; }
    for (const p of pairs) {
      const m = p && p.baseToken && p.baseToken.address; if (!m || !part.includes(m)) continue;
      const liq = Number(p.liquidity && p.liquidity.usd) || 0;
      if (map[m] && map[m].liq >= liq) continue;
      map[m] = { price: Number(p.priceUsd) || 0, liq, name: p.baseToken.name || '', symbol: p.baseToken.symbol || '', image: (p.info && p.info.imageUrl) || '', pair: p.pairAddress || '', dex: p.dexId || '' };
    }
    for (const m of part) mem['mk:' + m] = { t: Date.now(), v: map[m] || null };
    return [];
  }, 4);
  return { map, failed };
}
// What a holding could really be sold for: price x balance, but never more than half the pool's liquidity.
function worth(m, ui) {
  if (!m || !m.price) return null;
  const v = m.price * ui;
  return m.liq > 0 ? Math.min(v, m.liq / 2) : v;
}
async function solUsd() {
  return cached('solusd', 60000, async () => {
    try {
      const pairs = await getJson('https://api.dexscreener.com/tokens/v1/solana/' + NATIVE_MINT.toBase58());
      const best = (pairs || []).filter(p => p.baseToken && p.baseToken.address === NATIVE_MINT.toBase58() && /USD/.test(p.quoteToken && p.quoteToken.symbol || ''))
        .sort((a, b) => (b.liquidity && b.liquidity.usd || 0) - (a.liquidity && a.liquidity.usd || 0))[0];
      return best ? Number(best.priceUsd) : 0;
    } catch (e) { return 0; }
  });
}
// Names for coins with no pair left: Metaplex metadata (classic SPL) or the Token-2022 metadata extension.
function readMetaplex(buf) {
  try {
    let o = 1 + 32 + 32;
    const rd = max => { const n = buf.readUInt32LE(o); o += 4; if (n > max) throw 0; const s = buf.slice(o, o + n).toString('utf8').replace(/\0/g, '').trim(); o += n; return s; };
    return { name: rd(64), symbol: rd(16) };
  } catch (e) { return null; }
}
async function names(mints2022, mintsClassic) {
  const out = {};
  if (mintsClassic.length) {
    const pdas = mintsClassic.map(m => PublicKey.findProgramAddressSync([Buffer.from('metadata'), METADATA_PROGRAM.toBuffer(), new PublicKey(m).toBuffer()], METADATA_PROGRAM)[0]);
    const infos = await chunked(pdas, 100, part => rpc(c => c.getMultipleAccountsInfo(part)).catch(() => part.map(() => null)));
    infos.forEach((info, i) => { if (info && info.data) { const md = readMetaplex(info.data); if (md) out[mintsClassic[i]] = md; } });
  }
  if (mints2022.length) {
    const infos = await chunked(mints2022.map(m => new PublicKey(m)), 100, part => rpc(c => c.getMultipleParsedAccounts(part)).then(r => r.value).catch(() => part.map(() => null)));
    infos.forEach((info, i) => {
      const ex = info && info.data && info.data.parsed && info.data.parsed.info && info.data.parsed.info.extensions;
      const md = (ex || []).find(x => x.extension === 'tokenMetadata');
      if (md && md.state) out[mints2022[i]] = { name: String(md.state.name || '').trim(), symbol: String(md.state.symbol || '').trim() };
    });
  }
  return out;
}

/* ---------------- wallet scan ---------------- */
function accountFacts(pubkey, acc, programId) {
  const info = acc.data && acc.data.parsed && acc.data.parsed.info; if (!info) return null;
  const amt = info.tokenAmount || {};
  const ex = info.extensions || [];
  const fee = ex.find(x => x.extension === 'transferFeeAmount');
  return {
    account: pubkey.toBase58(), mint: info.mint, owner: info.owner, program: programId.equals(TOKEN_2022_PROGRAM_ID) ? '2022' : 'spl',
    amount: String(amt.amount || '0'), decimals: Number(amt.decimals || 0), ui: Number(amt.uiAmount || 0),
    lamports: acc.lamports, frozen: info.state === 'frozen', native: !!info.isNative,
    closeAuth: info.closeAuthority || null, withheld: fee && fee.state ? String(fee.state.withheldAmount || '0') : '0',
  };
}
function classify(a, owner) {
  if (a.frozen) return { kind: 'frozen', action: null, note: 'Frozen by the coin’s creator. It can’t be closed.' };
  if (a.closeAuth && a.closeAuth !== owner) return { kind: 'locked', action: null, note: 'Someone else holds the close authority.' };
  if (a.withheld !== '0') return { kind: 'locked', action: null, note: 'Has withheld transfer fees, so it can’t be closed yet.' };
  if (a.amount === '0') return { kind: 'empty', action: 'close', note: 'Empty account. Closing returns the rent.' };
  if (a.native) return { kind: 'wsol', action: 'close', note: 'Wrapped SOL. Closing unwraps it back to SOL.' };
  if (!LAUNCHPAD_SUFFIX.test(a.mint)) return { kind: 'other', action: null, note: 'Not a pump.fun or bonk coin. TOAST leaves it alone.' };
  if (a.unpriced) return { kind: 'unpriced', action: null, note: 'Couldn’t check its price just now. Scan again.' };
  if (a.valueUsd != null && a.valueUsd > MAX_BURN_USD) return { kind: 'valuable', action: null, note: 'Still worth something. Sell it instead.' };
  return { kind: 'coin', action: 'burn', note: a.valueUsd == null ? 'No market left.' : '' };
}
async function scan(ownerStr) {
  const owner = pk(ownerStr, 'wallet address');
  const [spl, t22] = await Promise.all([
    rpc(c => c.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID })),
    rpc(c => c.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID })),
  ]);
  const accts = [];
  for (const v of spl.value) { const f = accountFacts(v.pubkey, v.account, TOKEN_PROGRAM_ID); if (f) accts.push(f); }
  for (const v of t22.value) { const f = accountFacts(v.pubkey, v.account, TOKEN_2022_PROGRAM_ID); if (f) accts.push(f); }
  const held = [...new Set(accts.filter(a => a.amount !== '0' && !a.native).map(a => a.mint))];
  const [{ map: mk, failed }, usd] = await Promise.all([market(held), solUsd()]);
  // names for coins with no pair left, and for empty accounts (so you can see what you already sold)
  const allMints = [...new Set(accts.filter(a => !a.native).map(a => a.mint))];
  const unnamed = allMints.filter(m => !mk[m] || !mk[m].name).slice(0, 400);
  const t22set = new Set(accts.filter(a => a.program === '2022').map(a => a.mint));
  const nm = await names(unnamed.filter(m => t22set.has(m)), unnamed.filter(m => !t22set.has(m))).catch(() => ({}));
  const out = accts.map(a => {
    const m = mk[a.mint];
    const r = Object.assign({}, a, {
      name: (m && m.name) || (nm[a.mint] && nm[a.mint].name) || '', symbol: (m && m.symbol) || (nm[a.mint] && nm[a.mint].symbol) || '',
      image: (m && m.image) || '', priceUsd: m ? m.price : null, liqUsd: m ? m.liq : 0,
      valueUsd: a.amount === '0' ? 0 : worth(m, a.ui), unpriced: a.amount !== '0' && failed.has(a.mint),
    });
    if (r.native) { r.name = 'Wrapped SOL'; r.symbol = 'wSOL'; r.valueUsd = usd ? usd * a.ui : null; r.unpriced = false; }
    return Object.assign(r, classify(r, owner.toBase58()));
  });
  out.sort((x, y) => (x.action ? 0 : 1) - (y.action ? 0 : 1) || (x.valueUsd || 0) - (y.valueUsd || 0));
  const closable = out.filter(a => a.action);
  return {
    owner: owner.toBase58(), solUsd: usd, accounts: out,
    totals: { accounts: out.length, closable: closable.length, rentLamports: closable.reduce((s, a) => s + a.lamports, 0), allRentLamports: out.reduce((s, a) => s + a.lamports, 0) },
  };
}

/* ---------------- transactions ---------------- */
function itemIxs(a, owner) {
  const prog = a.program === '2022' ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  const acc = new PublicKey(a.account), mint = new PublicKey(a.mint);
  const ixs = [];
  if (!a.native && a.amount !== '0') ixs.push(createBurnCheckedInstruction(acc, mint, owner, BigInt(a.amount), a.decimals, [], prog));
  ixs.push(createCloseAccountInstruction(acc, owner, owner, [], prog));
  return ixs;
}
function compile(owner, ixs, units, price, blockhash) {
  const all = [ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }), ...ixs];
  const msg = new TransactionMessage({ payerKey: owner, recentBlockhash: blockhash, instructions: all }).compileToV0Message();
  const tx = new VersionedTransaction(msg);
  try { const bytes = tx.serialize(); return bytes.length <= 1232 ? { tx, bytes } : null; } catch (e) { return null; }
}
// Greedy packing: as many burn+close pairs per transaction as fit in 1,232 bytes (and 30 items at most).
function pack(owner, items, blockhash) {
  const groups = []; let cur = [];
  for (const a of items) {
    const trial = cur.concat([a]);
    const ok = trial.length <= 30 && compile(owner, trial.flatMap(x => itemIxs(x, owner)), 1_400_000, 1_000_000, blockhash);
    if (ok) cur = trial;
    else { if (cur.length) groups.push(cur); cur = [a]; }
  }
  if (cur.length) groups.push(cur);
  return groups;
}
async function priorityFee() {
  try {
    const r = await cached('prio', 20000, () => rpc(c => c.getRecentPrioritizationFees()));
    const v = r.map(x => x.prioritizationFee).filter(x => x > 0).sort((a, b) => a - b);
    const p = v.length ? v[Math.floor(v.length * 0.6)] : 20000;
    return Math.max(5000, Math.min(250000, p));
  } catch (e) { return 20000; }
}
function explain(sim) {
  const l = ((sim && sim.logs) || []).join('\n'); const err = JSON.stringify(sim && sim.err || '');
  if (/InsufficientFundsForFee|insufficient funds for fee|AccountNotFound/i.test(err + l)) return 'Your wallet needs a little SOL (about 0.0001) to pay the network fee first.';
  if (/non-native account can only be closed if its balance is zero/i.test(l)) return 'its balance changed since the scan, scan again';
  if (/owner does not match/i.test(l)) return 'not owned by this wallet';
  return 'it would fail on-chain (' + err.replace(/"/g, '').slice(0, 100) + ')';
}
async function build(b) {
  const owner = pk(b.owner, 'wallet address');
  const list = [...new Set((Array.isArray(b.accounts) ? b.accounts : []).map(String))];
  if (!list.length) throw http(400, 'Pick at least one coin to toast.');
  if (list.length > MAX_ACCOUNTS) throw http(400, 'Too many at once. Toast at most ' + MAX_ACCOUNTS + ' per batch.');
  // re-read every account now, never trust what the browser sends
  const keys = list.map(s => pk(s, 'token account'));
  const infos = await chunked(keys, 100, part => rpc(c => c.getMultipleParsedAccounts(part)).then(r => r.value));
  const items = [], skipped = [];
  infos.forEach((acc, i) => {
    const prog = acc && acc.owner && (acc.owner.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : acc.owner.equals(TOKEN_PROGRAM_ID) ? TOKEN_PROGRAM_ID : null);
    const f = prog && accountFacts(keys[i], acc, prog);
    if (!f) return skipped.push({ account: list[i], why: 'not found' });
    if (f.owner !== owner.toBase58()) return skipped.push({ account: list[i], why: 'not this wallet’s' });
    const c = classify(f, owner.toBase58());
    if (!c.action) return skipped.push({ account: list[i], why: c.note });
    items.push(f);
  });
  // price guard on everything that would be burned (fresh prices, never the browser's)
  const burnMints = [...new Set(items.filter(a => !a.native && a.amount !== '0').map(a => a.mint))];
  const { map: mk, failed } = await market(burnMints);
  const ok = items.filter(a => {
    if (a.native || a.amount === '0') return true;
    if (failed.has(a.mint)) { skipped.push({ account: a.account, why: 'couldn’t check its price, try again' }); return false; }
    const v = worth(mk[a.mint], a.ui) || 0;
    if (v > MAX_BURN_USD) { skipped.push({ account: a.account, why: 'worth $' + v.toFixed(2) + ', sell it instead' }); return false; }
    return true;
  });
  if (!ok.length) throw http(400, skipped.length ? 'Nothing left to toast: ' + skipped[0].why : 'Nothing to toast.');
  const { blockhash } = await rpc(c => c.getLatestBlockhash('confirmed'));
  const price = await priorityFee();
  const sim = g => simulate(owner, g, price, blockhash);
  const txs = [];
  let retry = [];
  const first = pack(owner, ok, blockhash);
  (await mapLimit(first, 4, sim)).forEach((r, i) => {
    if (r.tx) return txs.push(r.tx);
    if (r.fatal) throw r.fatal;
    if (first[i].length === 1) skipped.push({ account: first[i][0].account, why: r.why });
    else retry = retry.concat(first[i]);
  });
  if (retry.length) {
    // one account in a batch made it fail: test them one by one, drop the bad ones, re-pack the rest
    const solo = await mapLimit(retry.map(a => [a]), 6, sim);
    const pass = [];
    solo.forEach((r, i) => { if (r.fatal) throw r.fatal; if (r.tx) pass.push(retry[i]); else skipped.push({ account: retry[i].account, why: r.why }); });
    const again = pack(owner, pass, blockhash);
    (await mapLimit(again, 4, sim)).forEach((r, i) => {
      if (r.tx) txs.push(r.tx); else again[i].forEach(a => skipped.push({ account: a.account, why: r.why }));
    });
  }
  if (!txs.length) { const e = http(400, skipped.length ? 'Nothing can be toasted: ' + skipped[0].why : 'Nothing to toast.'); throw e; }
  const fee = txs.reduce((s, t) => s + 5000 + Math.ceil(t.units * price / 1e6), 0);
  return { txs, skipped, priceMicroLamports: price, feeLamports: fee, rentLamports: txs.reduce((s, t) => s + t.rentLamports, 0) };
}
async function mapLimit(arr, n, fn) {
  const out = new Array(arr.length); let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, arr.length) }, async () => { while (next < arr.length) { const i = next++; out[i] = await fn(arr[i], i); } }));
  return out;
}
// Simulate one group. Returns { tx } when it would succeed, { why } when it would fail,
// and { fatal } when no transaction from this wallet can succeed (no SOL for the fee).
async function simulate(owner, g, price, blockhash) {
  const ixs = g.flatMap(a => itemIxs(a, owner));
  const first = compile(owner, ixs, 1_400_000, price, blockhash);
  if (!first) return { why: 'transaction too large' };
  const r = await rpc(c => c.simulateTransaction(first.tx, { sigVerify: false, replaceRecentBlockhash: true, commitment: 'processed' }));
  if (r.value.err) {
    const why = explain(r.value);
    if (/needs a little SOL/.test(why)) { const e = http(400, why); e.logs = (r.value.logs || []).slice(-8); return { fatal: e }; }
    return { why };
  }
  const units = Math.max(20000, Math.ceil((r.value.unitsConsumed || 100000) * 1.15) + 5000);
  const fin = compile(owner, ixs, units, price, blockhash);
  if (!fin) return { why: 'transaction too large' };
  return {
    tx: {
      tx: Buffer.from(fin.bytes).toString('base64'), bytes: fin.bytes.length, units, count: g.length,
      burns: g.filter(a => !a.native && a.amount !== '0').length, rentLamports: g.reduce((s, a) => s + a.lamports, 0),
      wsolLamports: g.filter(a => a.native).reduce((s, a) => s + Number(a.amount), 0), accounts: g.map(a => a.account),
    },
  };
}

/* ---------------- router ---------------- */
module.exports = async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 204, {});
  const url = new URL(req.url, 'http://x');
  const q = url.searchParams;
  const path = (q.get('__p') || url.pathname.replace(/^\/api\/?/, '')).replace(/\/+$/, '');
  try {
    if (path === 'config') return send(res, 200, { ok: true, ca: CONFIG.ca, x: CONFIG.x, rpc: E('RPC_URL') ? 'private' : 'public', maxBurnUsd: MAX_BURN_USD }, 'public, s-maxage=60');
    if (path === 'scan') return send(res, 200, { ok: true, ...(await scan(q.get('owner'))) });
    if (path === 'status') {
      const sig = String(q.get('sig') || '');
      if (!/^[1-9A-HJ-NP-Za-km-z]{64,90}$/.test(sig)) throw http(400, 'bad signature');
      const r = await rpc(c => c.getSignatureStatuses([sig], { searchTransactionHistory: false }));
      const s = r.value[0];
      return send(res, 200, { ok: true, status: s ? s.confirmationStatus : null, err: s ? s.err : null });
    }
    if (req.method !== 'POST') throw http(404, 'Not found');
    const b = await readBody(req);
    if (path === 'tx') return send(res, 200, { ok: true, ...(await build(b)) });
    if (path === 'send') {
      const raw = Buffer.from(String(b.tx || ''), 'base64');
      if (raw.length < 100 || raw.length > 1232) throw http(400, 'bad transaction');
      const sig = await rpc(c => c.sendRawTransaction(raw, { skipPreflight: true, maxRetries: 5 }));
      return send(res, 200, { ok: true, sig });
    }
    throw http(404, 'Not found');
  } catch (e) {
    const code = e.code && e.code >= 400 && e.code < 600 ? e.code : 500;
    return send(res, code, { ok: false, error: String(e.message || e).slice(0, 400), logs: e.logs || undefined });
  }
};
module.exports._t = { pack, itemIxs, compile, classify, readMetaplex };
