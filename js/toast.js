/* TOAST front end. No framework, no keys: the server builds burn + close transactions, your wallet signs. */
(() => {
  'use strict';
  const $ = (s, el = document) => el.querySelector(s);
  const $$ = (s, el = document) => [...el.querySelectorAll(s)];
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) { } } };
  const S = { data: null, sel: new Set(), thr: 1, cfg: {}, busy: false, showAll: {} };

  /* ---------- utils ---------- */
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const b58 = bytes => { let n = 0n; for (const x of bytes) n = n * 256n + BigInt(x); let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; } for (const x of bytes) { if (x === 0) s = '1' + s; else break; } return s; };
  const fromB64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const toB64 = u => { let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); return btoa(s); };
  const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s);
  const short = a => a ? a.slice(0, 4) + '…' + a.slice(-4) : '';
  function compact(n) {
    n = Number(n); if (!isFinite(n)) return '—';
    const a = Math.abs(n);
    if (a >= 1e9) return (n / 1e9).toFixed(1) + 'B'; if (a >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return (n / 1e3).toFixed(1) + 'K'; if (a >= 1) return n.toFixed(a >= 100 ? 0 : 2);
    if (a === 0) return '0'; return n.toPrecision(2);
  }
  const sol = l => (Number(l) || 0) / 1e9;
  function fsol(x) { x = Number(x) || 0; return x >= 100 ? x.toFixed(1) : x >= 1 ? x.toFixed(3) : x.toFixed(4); }
  function fusd(x) { if (x == null) return 'no market'; x = Number(x); return x < 0.01 ? '<$0.01' : '$' + (x < 10 ? x.toFixed(2) : compact(x)); }
  function say(msg, ms = 2800) { const t = $('#msg'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms); }
  async function api(path, body) {
    const opt = body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {};
    const r = await fetch('/api/' + path, opt);
    let j = null; try { j = await r.json(); } catch (e) { }
    if (!r.ok || !j || j.ok === false) { const e = new Error((j && j.error) || ('Request failed (' + r.status + ')')); e.logs = j && j.logs; throw e; }
    return j;
  }
  addEventListener('scroll', () => $('#nav').classList.toggle('scrolled', scrollY > 8), { passive: true });

  /* ---------- wallet (Wallet Standard) ---------- */
  const W = { list: [], w: null, acct: null, after: null };
  function addWallet(w) {
    try {
      if (!w || !w.features || !w.name) return;
      const solChain = (w.chains || []).some(c => String(c).startsWith('solana:'));
      const can = w.features['standard:connect'] && (w.features['solana:signTransaction'] || w.features['solana:signAndSendTransaction']);
      if (!solChain || !can || W.list.some(x => x.name === w.name)) return;
      W.list.push(w);
      if (!W.w && store.get('toast:wallet') === w.name && w.accounts && w.accounts.length) use(w, w.accounts[0]);
      if (!$('#wModal').hidden) renderWallets();
    } catch (e) { }
  }
  const walletApi = Object.freeze({ register: (...ws) => { ws.forEach(addWallet); return () => { }; } });
  addEventListener('wallet-standard:register-wallet', e => { try { e.detail(walletApi); } catch (_) { } });
  try { dispatchEvent(new CustomEvent('wallet-standard:app-ready', { detail: walletApi })); } catch (_) { }
  function use(w, acct) {
    W.w = w; W.acct = acct; store.set('toast:wallet', w.name);
    $('#walletBtn').classList.add('on'); $('#walletLabel').textContent = short(acct.address);
    try { w.features['standard:events'] && w.features['standard:events'].on('change', ({ accounts }) => { if (accounts && W.w === w) { if (accounts.length) use(w, accounts[0]); else disconnect(); } }); } catch (e) { }
    renderAct();
    if (W.after) { const f = W.after; W.after = null; f(); }
  }
  function disconnect() {
    try { W.w && W.w.features['standard:disconnect'] && W.w.features['standard:disconnect'].disconnect(); } catch (e) { }
    W.w = null; W.acct = null; store.set('toast:wallet', '');
    $('#walletBtn').classList.remove('on'); $('#walletLabel').textContent = 'Connect wallet'; renderAct();
  }
  const mobile = /iphone|ipad|android/i.test(navigator.userAgent);
  function renderWallets() {
    const box = $('#wList');
    $('#wTitle').textContent = W.w ? 'Your wallet' : 'Connect a wallet';
    if (W.w) {
      box.innerHTML = `<p>${esc(W.w.name)}<br><code>${esc(W.acct.address)}</code></p><button class="wopt" type="button" id="wScan">Scan this wallet</button><button class="wopt" type="button" id="wCopy">Copy address</button><button class="wopt" type="button" id="wOut">Disconnect</button>`;
      $('#wScan').onclick = () => { $('#wModal').hidden = true; scan(W.acct.address); };
      $('#wCopy').onclick = () => { navigator.clipboard && navigator.clipboard.writeText(W.acct.address).then(() => say('Address copied')); };
      $('#wOut').onclick = () => { disconnect(); $('#wModal').hidden = true; say('Disconnected'); };
      return;
    }
    if (!W.list.length) {
      const here = encodeURIComponent(location.href), ref = encodeURIComponent(location.origin);
      box.innerHTML = mobile
        ? `<p>Open TOAST inside your wallet app’s browser:</p>
           <a class="wopt" href="https://phantom.app/ul/browse/${here}?ref=${ref}">Open in Phantom</a>
           <a class="wopt" href="https://solflare.com/ul/v1/browse/${here}?ref=${ref}">Open in Solflare</a>`
        : `<p>No Solana wallet found in this browser. Install one, then reload:</p>
           <a class="wopt" href="https://phantom.com/download" target="_blank" rel="noopener">Phantom</a>
           <a class="wopt" href="https://solflare.com/download" target="_blank" rel="noopener">Solflare</a>
           <a class="wopt" href="https://backpack.app/download" target="_blank" rel="noopener">Backpack</a>`;
      return;
    }
    box.innerHTML = W.list.map((w, i) => `<button class="wopt" data-i="${i}" type="button">${w.icon ? `<img src="${esc(w.icon)}" alt="">` : ''}${esc(w.name)}<small>Detected</small></button>`).join('');
  }
  function connect(after) { if (after) W.after = after; renderWallets(); $('#wModal').hidden = false; }
  $('#wList').addEventListener('click', async e => {
    const b = e.target.closest('button.wopt[data-i]'); if (!b) return;
    const w = W.list[+b.dataset.i];
    try {
      b.disabled = true;
      const r = await w.features['standard:connect'].connect();
      const acct = (r && r.accounts && r.accounts[0]) || (w.accounts && w.accounts[0]);
      if (!acct) throw new Error('No account shared');
      $('#wModal').hidden = true; use(w, acct); say('Connected ' + short(acct.address));
    } catch (err) { W.after = null; say(err && err.message ? err.message : 'Connection cancelled'); }
    finally { b.disabled = false; }
  });
  $('#walletBtn').addEventListener('click', () => connect());
  $('#wClose').addEventListener('click', () => { $('#wModal').hidden = true; W.after = null; });
  $('#wModal').addEventListener('click', e => { if (e.target.id === 'wModal') { $('#wModal').hidden = true; W.after = null; } });

  /* ---------- scan ---------- */
  async function scan(addr) {
    addr = String(addr || '').trim();
    if (!isAddr(addr)) { say('That doesn’t look like a Solana address.'); $('#addr').focus(); return; }
    if (S.busy) return; S.busy = true;
    const btn = $('#scanBtn'); btn.classList.add('busy'); btn.disabled = true; btn.firstElementChild.textContent = 'Scanning';
    const slow = setTimeout(() => { btn.firstElementChild.textContent = 'Still reading'; say('Big wallet. Reading every account…', 5000); }, 4500);
    try {
      const d = await api('scan?owner=' + encodeURIComponent(addr));
      S.data = d; S.showAll = {}; $('#addr').value = addr; defaults(); render();
      $('#results').hidden = false;
      setTimeout(() => $('#results').scrollIntoView({ behavior: 'smooth', block: 'start' }), 60);
    } catch (e) { say(e.message || 'Scan failed', 4200); }
    finally { clearTimeout(slow); S.busy = false; btn.classList.remove('busy'); btn.disabled = false; btn.firstElementChild.textContent = 'Scan wallet'; }
  }
  $('#scanForm').addEventListener('submit', e => { e.preventDefault(); const v = $('#addr').value.trim(); if (!v && W.acct) return scan(W.acct.address); scan(v); });
  $('#useWallet').addEventListener('click', () => { if (W.acct) scan(W.acct.address); else connect(() => scan(W.acct.address)); });
  $('#rescan').addEventListener('click', () => S.data && scan(S.data.owner));

  const isDead = a => a.kind === 'coin' && (a.valueUsd == null || a.valueUsd < S.thr);
  function defaults() {
    S.sel = new Set();
    for (const a of S.data.accounts) if (a.kind === 'empty' || isDead(a)) S.sel.add(a.account);
  }
  $('#thr').addEventListener('click', e => {
    const b = e.target.closest('button[data-v]'); if (!b || !S.data) return;
    S.thr = +b.dataset.v; $$('#thr button').forEach(x => x.classList.toggle('on', x === b));
    for (const a of S.data.accounts) if (a.kind === 'coin') { if (isDead(a)) S.sel.add(a.account); else S.sel.delete(a.account); }
    render();
  });
  $('#selAll').addEventListener('click', () => { if (!S.data) return; for (const a of S.data.accounts) if (a.action && a.kind !== 'wsol') S.sel.add(a.account); render(); });
  $('#selNone').addEventListener('click', () => { S.sel.clear(); render(); });

  function avatar(a) {
    if (a.kind === 'empty') return `<span class="av empty">∅</span>`;
    if (a.image) return `<span class="av"><span>${esc(((a.symbol || a.name || '?')[0] || '?').toUpperCase())}</span><img src="${esc(a.image)}" alt="" loading="lazy" referrerpolicy="no-referrer" onerror="this.remove()"></span>`;
    return `<span class="av toasted"><img src="/img/toast.png" alt=""></span>`;
  }
  function card(a, i) {
    const can = !!a.action, on = S.sel.has(a.account);
    const nm = a.name || short(a.mint);
    let sub, tag = '';
    if (a.kind === 'empty') { sub = (a.symbol ? '$' + a.symbol + ' · ' : '') + 'rent ' + fsol(sol(a.lamports)) + ' SOL'; tag = '<span class="tag empty">empty</span>'; }
    else if (a.kind === 'coin') { sub = (a.symbol ? '$' + a.symbol + ' · ' : '') + compact(a.ui) + ' · ' + fusd(a.valueUsd); tag = isDead(a) ? '<span class="tag dead">' + (a.valueUsd == null ? 'no market' : 'dead') + '</span>' : ''; }
    else if (a.kind === 'wsol') { sub = fsol(a.ui) + ' wSOL · unwraps to SOL'; tag = '<span class="tag keep">wsol</span>'; }
    else {
      sub = a.kind === 'frozen' || a.kind === 'locked' || a.kind === 'unpriced' ? (a.note || '') : (a.symbol ? '$' + a.symbol + ' · ' : '') + compact(a.ui) + (a.valueUsd != null ? ' · ' + fusd(a.valueUsd) : '');
      tag = '<span class="tag keep">' + esc({ other: 'kept', valuable: 'worth it', unpriced: 'retry' }[a.kind] || a.kind) + '</span>';
    }
    return `<label class="card${on ? ' sel' : ''}${can ? '' : ' off'}" data-a="${esc(a.account)}" style="animation-delay:${Math.min(i, 24) * 12}ms" title="${esc(a.note || '')}">
      <input type="checkbox" ${on ? 'checked' : ''} ${can ? '' : 'disabled'}><span class="tick"></span>${avatar(a)}
      <span class="nm"><b>${esc(nm)}${tag}</b><small>${esc(sub)}</small></span></label>`;
  }
  function group(id, title, note, list) {
    if (!list.length) return '';
    const LIM = 90, all = S.showAll[id] || list.length <= LIM, shown = all ? list : list.slice(0, LIM);
    const n = list.filter(a => S.sel.has(a.account)).length;
    return `<div class="grp" data-g="${id}"><div class="grp-h"><div><h3>${esc(title)}<small>${n ? n + ' of ' : ''}${list.length}</small></h3><p>${esc(note)}</p></div></div>
      <div class="cards">${shown.map(card).join('')}</div>${all ? '' : `<button type="button" class="btn ghost more" data-more="${id}">Show all ${list.length}</button>`}</div>`;
  }
  function render() {
    const d = S.data; if (!d) return;
    const acc = d.accounts;
    const coins = acc.filter(a => a.kind === 'coin'), empties = acc.filter(a => a.kind === 'empty'), kept = acc.filter(a => a.kind !== 'coin' && a.kind !== 'empty');
    const g = $('#groups');
    if (!acc.length) {
      g.innerHTML = `<div class="empty-state"><img src="/img/toaster.png" alt=""><b>Nothing to toast here.</b>This wallet has no token accounts at all. Clean as a fresh loaf.</div>`;
    } else {
      g.innerHTML = group('coins', 'Dead coins', 'pump.fun and bonk coins with no market or worth less than your limit. They get burned, then closed.', coins)
        + group('empty', 'Empty accounts', 'Coins you already sold. Closing them only returns the rent.', empties)
        + group('kept', 'Kept', 'TOAST leaves these alone. Wrapped SOL can be ticked to unwrap it.', kept);
      if (!coins.length && !empties.length) g.insertAdjacentHTML('afterbegin', `<div class="empty-state"><img src="/img/toaster.png" alt=""><b>No dead coins.</b>Every account here still has a job.</div>`);
    }
    // summary
    const selected = acc.filter(a => S.sel.has(a.account));
    const back = selected.reduce((s, a) => s + a.lamports + (a.kind === 'wsol' ? Number(a.amount) : 0), 0);
    $('#sumSol').textContent = '+' + fsol(sol(back));
    $('#sumWho').textContent = (W.acct && W.acct.address === d.owner ? 'Your wallet ' : 'Wallet ') + short(d.owner);
    const usd = d.solUsd ? ' ≈ $' + (sol(back) * d.solUsd).toFixed(2) : '';
    $('#sumSub').textContent = selected.length ? `${selected.length} account${selected.length === 1 ? '' : 's'} selected${usd}. All rent locked in this wallet: ${fsol(sol(d.totals.allRentLamports))} SOL.` : 'Nothing selected yet.';
    $('#stDead').textContent = coins.filter(isDead).length; $('#stEmpty').textContent = empties.length; $('#stKept').textContent = kept.length + coins.filter(a => !isDead(a)).length;
    renderAct();
  }
  $('#groups').addEventListener('click', e => {
    const more = e.target.closest('[data-more]'); if (more) { S.showAll[more.dataset.more] = true; render(); return; }
    const c = e.target.closest('.card'); if (!c || c.classList.contains('off')) return;
    e.preventDefault();
    const a = c.dataset.a; if (S.sel.has(a)) S.sel.delete(a); else S.sel.add(a);
    render();
  });

  /* ---------- action bar ---------- */
  function renderAct() {
    const act = $('#act'), d = S.data;
    if (!d || $('#results').hidden) { act.classList.remove('show'); document.body.classList.remove('acting'); return; }
    const selected = d.accounts.filter(a => S.sel.has(a.account));
    const back = selected.reduce((s, a) => s + a.lamports + (a.kind === 'wsol' ? Number(a.amount) : 0), 0);
    $('#actCount').textContent = selected.length + ' selected';
    $('#actSol').textContent = '+' + fsol(sol(back)) + ' SOL';
    const btn = $('#toastBtn');
    if (!W.acct) btn.textContent = 'Connect wallet to toast';
    else if (W.acct.address !== d.owner) btn.textContent = 'Connect the scanned wallet';
    else btn.textContent = 'Toast ' + selected.length;
    btn.disabled = !selected.length;
    act.classList.toggle('show', true); document.body.classList.add('acting');
  }
  $('#toastBtn').addEventListener('click', () => {
    const d = S.data; if (!d) return;
    if (!W.acct) return connect(() => { if (W.acct.address !== d.owner) say('Connected wallet is different from the scanned one. Scan it first.', 4000); else run(); });
    if (W.acct.address !== d.owner) { say('This wallet is ' + short(W.acct.address) + '. Scanning it now.', 3000); return scan(W.acct.address); }
    run();
  });

  /* ---------- toasting ---------- */
  async function waitFor(sig) {
    const t0 = Date.now();
    while (Date.now() - t0 < 90000) {
      await new Promise(r => setTimeout(r, 1400));
      try {
        const s = await api('status?sig=' + sig);
        if (s.err) throw Object.assign(new Error('failed on-chain'), { chain: s.err });
        if (s.status === 'confirmed' || s.status === 'finalized') return true;
      } catch (e) { if (e.chain) throw e; }
    }
    throw new Error('not confirmed after 90 s');
  }
  const P = { open() { $('#pModal').hidden = false; $('.prog').classList.add('working'); $('#pAct').innerHTML = ''; $('#pLinks').innerHTML = ''; }, set(frac, line, solBack) { $('#pFill').style.width = Math.round(frac * 100) + '%'; if (line != null) $('#pLine').innerHTML = line; if (solBack != null) $('#pSol').textContent = '+' + fsol(solBack) + ' SOL'; } };
  $('#pClose').addEventListener('click', () => { if (!S.running) $('#pModal').hidden = true; });
  async function run() {
    const d = S.data; if (!d || S.running) return;
    const order = d.accounts.filter(a => S.sel.has(a.account)).map(a => a.account);
    if (!order.length) return;
    S.running = true; P.open(); $('#pTitle').textContent = 'Toasting…';
    const f = W.w.features, chain = 'solana:mainnet';
    let doneAcc = 0, back = 0, failed = 0, skipped = 0, whySkip = '', sigs = [];
    const gone = new Set();
    const BATCH = 200, total = order.length;
    try {
      for (let i = 0; i < order.length; i += BATCH) {
        const part = order.slice(i, i + BATCH);
        P.set(doneAcc / total, `Building and simulating ${part.length} account${part.length === 1 ? '' : 's'}…`, sol(back));
        const r = await api('tx', { owner: d.owner, accounts: part });
        const txs = r.txs;
        P.set(doneAcc / total, `Approve ${txs.length} transaction${txs.length === 1 ? '' : 's'} in ${esc(W.w.name)}…`);
        let signed = null;
        if (f['solana:signTransaction']) {
          const outs = await f['solana:signTransaction'].signTransaction(...txs.map(t => ({ account: W.acct, chain, transaction: fromB64(t.tx) })));
          signed = outs.map(o => toB64(o.signedTransaction));
        }
        let k = 0;
        const confirmOne = async (t, sig) => {
          sigs.push(sig); $('#pLinks').insertAdjacentHTML('beforeend', `<a href="https://solscan.io/tx/${sig}" target="_blank" rel="noopener">tx ${sigs.length}</a>`);
          try { await waitFor(sig); doneAcc += t.count; back += sol(t.rentLamports + t.wsolLamports); t.accounts.forEach(a => { S.sel.delete(a); gone.add(a); }); }
          catch (e) { failed += t.count; }
          k++; P.set((doneAcc + failed) / total, `Confirmed ${k} of ${txs.length} transaction${txs.length === 1 ? '' : 's'}`, back);
        };
        if (signed) {
          const sent = [];
          for (let j = 0; j < signed.length; j++) {
            try { const { sig } = await api('send', { tx: signed[j] }); sent.push(confirmOne(txs[j], sig)); }
            catch (e) { failed += txs[j].count; }
          }
          await Promise.all(sent);
        } else {
          for (const t of txs) {
            const [res] = await f['solana:signAndSendTransaction'].signAndSendTransaction({ account: W.acct, chain, transaction: fromB64(t.tx) });
            await confirmOne(t, typeof res.signature === 'string' ? res.signature : b58(res.signature));
          }
        }
        if (r.skipped && r.skipped.length) { skipped += r.skipped.length; whySkip = whySkip || r.skipped[0].why; }
      }
      finish(doneAcc, back, failed, skipped, whySkip);
    } catch (e) {
      const rejected = /reject|cancel|denied|declin/i.test(String(e && e.message));
      $('#pTitle').textContent = doneAcc ? 'Partly toasted' : (rejected ? 'Cancelled' : 'Not toasted');
      P.set(doneAcc / total, `<span class="p-err">${esc(rejected ? 'You cancelled in the wallet.' : (e.message || 'Something went wrong.'))}</span>`, back);
      finishButtons(doneAcc, back);
    } finally {
      S.running = false; $('.prog').classList.remove('working');
      if (gone.size) { S.data.accounts = S.data.accounts.filter(a => !gone.has(a.account)); render(); }
    }
  }
  function finish(n, back, failed, skipped, why) {
    $('#pTitle').textContent = n ? 'Your coins are toast.' : 'Nothing was toasted';
    const extra = (failed ? ` ${failed} didn’t confirm, scan again to retry.` : '') + (skipped ? ` ${skipped} skipped (${esc(why)}).` : '');
    P.set(1, n ? `Toasted ${n} account${n === 1 ? '' : 's'}. The SOL is back in your wallet.${extra}` : `Nothing confirmed.${extra} Scan again and retry.`, back);
    finishButtons(n, back);
  }
  function finishButtons(n, back) {
    const text = n ? `I just toasted ${n} dead coin account${n === 1 ? '' : 's'} and got ${fsol(back)} SOL back.\n\nYour coins are toast.` : '';
    const share = n ? `<a class="btn go" target="_blank" rel="noopener" href="https://x.com/intent/tweet?text=${encodeURIComponent(text + (S.cfg.x ? ' @' + S.cfg.x.replace(/^@/, '') : ''))}&url=${encodeURIComponent(location.origin)}">Share on X</a>` : '';
    $('#pAct').innerHTML = share + `<button class="btn ghost" type="button" id="pAgain">Scan again</button>`;
    $('#pAgain').onclick = () => { $('#pModal').hidden = true; scan(S.data.owner); };
  }

  /* ---------- config + CA pill ---------- */
  api('config').then(c => {
    S.cfg = c;
    if (c.ca) {
      const ca = esc(c.ca);
      $('#caPill').innerHTML = `<code>${short(ca)}</code><button type="button" id="caCopy">Copy CA</button><a href="https://pump.fun/coin/${ca}" target="_blank" rel="noopener">Buy</a><a href="https://dexscreener.com/solana/${ca}" target="_blank" rel="noopener">Chart</a>${c.x ? `<a href="https://x.com/${esc(c.x.replace(/^@/, ''))}" target="_blank" rel="noopener">X</a>` : ''}`;
      $('#caPill').hidden = false;
      $('#caCopy').onclick = () => navigator.clipboard && navigator.clipboard.writeText(c.ca).then(() => say('CA copied'));
    }
    if (c.x) $('#footX').innerHTML = `<a href="https://x.com/${esc(c.x.replace(/^@/, ''))}" target="_blank" rel="noopener">X</a>`;
  }).catch(() => { });

  const qs = new URLSearchParams(location.search).get('w');
  if (qs && isAddr(qs)) { $('#addr').value = qs; scan(qs); }
})();
