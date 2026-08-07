/**
 * Net Serviços — Plataforma de internet e pagamentos em Moçambique
 * Node.js puro · zero dependências externas
 */

import { createServer }                              from 'http'
import { createHmac, timingSafeEqual, randomBytes }  from 'crypto'
import { readFile, writeFile }                       from 'fs/promises'

// ── Configuração ──────────────────────────────────────────────────────────────
const PORT                 = process.env.PORT || 5000
const ZUMBO_API_KEY        = 'zk_live_a694231e0f188fe3599e4de8feda28b35714ed9b6fa3cd0e'
const ZUMBO_MERCHANT_ID    = 'MCH_B29C53549C'
const ZUMBO_WEBHOOK_SECRET = 'teste.com'
const ZUMBO_BASE           = 'https://zumbopay.com/api/public/v1'
const WALLET_MPESA         = 'd9a21461-8ff3-4929-8015-efd89268a068'
const WALLET_EMOLA         = '93a03d6d-f361-4602-90e1-c62889b45346'
const ADMIN_PASS           = 'office2025'
const ORDERS_FILE          = './orders.json'

function adminToken() {
  return createHmac('sha256', ZUMBO_WEBHOOK_SECRET + ADMIN_PASS).update('netservicos:admin').digest('hex')
}
function checkAdminCookie(req) {
  const cookies = req.headers.cookie || ''
  const m = cookies.match(/(?:^|;\s*)nsa=([^;]*)/)
  return m ? m[1] === adminToken() : false
}

// ── Catálogo de pacotes ───────────────────────────────────────────────────────
const BUNDLES = new Map([
  ['n01',{label:'380 MB', price:10,  cat:'normal'}],['n02',{label:'512 MB', price:13,  cat:'normal'}],
  ['n03',{label:'624 MB', price:17,  cat:'normal'}],['n04',{label:'780 MB', price:20,  cat:'normal'}],
  ['n05',{label:'1 GB',   price:25,  cat:'normal'}],['n06',{label:'1.1 GB', price:28,  cat:'normal'}],
  ['n07',{label:'1.6 GB', price:41,  cat:'normal'}],['n08',{label:'2 GB',   price:50,  cat:'normal'}],
  ['n09',{label:'3 GB',   price:75,  cat:'normal'}],['n10',{label:'4 GB',   price:100, cat:'normal'}],
  ['n11',{label:'5 GB',   price:125, cat:'normal'}],['n12',{label:'6 GB',   price:150, cat:'normal'}],
  ['n13',{label:'7 GB',   price:175, cat:'normal'}],['n14',{label:'8 GB',   price:200, cat:'normal'}],
  ['n15',{label:'9 GB',   price:225, cat:'normal'}],['n16',{label:'10 GB',  price:250, cat:'normal'}],
  ['p01',{label:'1.7 GB', price:57,  cat:'premium'}],['p02',{label:'2.6 GB', price:83,  cat:'premium'}],
  ['p03',{label:'3.4 GB', price:100, cat:'premium'}],['p04',{label:'4 GB',   price:135, cat:'premium'}],
  ['p05',{label:'5.4 GB', price:160, cat:'premium'}],['p06',{label:'6.2 GB', price:180, cat:'premium'}],
  ['p07',{label:'9.5 GB', price:280, cat:'premium'}],
  ['s01',{label:'1.7 GB', price:49,  cat:'sete'}],  ['s02',{label:'2.9 GB', price:85,  cat:'sete'}],
  ['s03',{label:'3.4 GB', price:90,  cat:'sete'}],  ['s04',{label:'5.3 GB', price:145, cat:'sete'}],
  ['s05',{label:'7.2 GB', price:200, cat:'sete'}],  ['s06',{label:'11 GB',  price:290, cat:'sete'}],
  ['m01',{label:'2.8 GB', price:95,  cat:'mensal'}],['m02',{label:'5.8 GB', price:195, cat:'mensal'}],
  ['m03',{label:'7.8 GB', price:210, cat:'mensal'}],['m04',{label:'10.8 GB',price:320, cat:'mensal'}],
  ['m05',{label:'17.8 GB',price:480, cat:'mensal'}],['m06',{label:'20.8 GB',price:575, cat:'mensal'}],
  ['m07',{label:'32.8 GB',price:950, cat:'mensal'}],
  ['d01',{label:'11 GB',  price:450,  cat:'diamante'}],['d02',{label:'15 GB',  price:580,  cat:'diamante'}],
  ['d03',{label:'21 GB',  price:720,  cat:'diamante'}],['d04',{label:'30 GB',  price:970,  cat:'diamante'}],
  ['d05',{label:'50 GB',  price:1490, cat:'diamante'}],
])

// ── Estado em memória ─────────────────────────────────────────────────────────
const transactions = new Map()
const sseClients   = new Map()
let   orders       = []           // persiste em ORDERS_FILE

// ── Persistência de encomendas ────────────────────────────────────────────────
async function loadOrders() {
  try { orders = JSON.parse(await readFile(ORDERS_FILE, 'utf8')) } catch {}
}
async function saveOrders() {
  try { await writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2)) } catch {}
}
function trackOrder(tx, extra = {}) {
  const rec = {
    txId: tx.id, type: tx.type || 'deposit', phone: tx.phone,
    bundleId: tx.bundleId || null, bundleLabel: tx.bundleLabel || null,
    amount: tx.amount, method: tx.method, status: 'pending',
    ts: tx.ts, activatedAt: null, ...extra,
  }
  orders.unshift(rec)
  if (orders.length > 1000) orders = orders.slice(0, 1000)
  saveOrders()
  return rec
}
function updateOrderStatus(txId, status, extra = {}) {
  const rec = orders.find(o => o.txId === txId)
  if (rec) { Object.assign(rec, { status, ...extra }); saveOrders() }
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}
function html(res, body, extraHeaders = {}) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', ...extraHeaders })
  res.end(body)
}
function redirect(res, url, headers = {}) {
  res.writeHead(302, { Location: url, ...headers }); res.end()
}
function readBody(req) {
  return new Promise((ok, fail) => {
    const c = []; req.on('data', d => c.push(d)); req.on('end', () => ok(Buffer.concat(c))); req.on('error', fail)
  })
}
function parseParams(pattern, path) {
  const pp = pattern.split('/'), rp = path.split('?')[0].split('/')
  if (pp.length !== rp.length) return null
  const p = {}
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) p[pp[i].slice(1)] = decodeURIComponent(rp[i])
    else if (pp[i] !== rp[i]) return null
  }
  return p
}
function parseQuery(req) {
  return Object.fromEntries(new URL(req.url, 'http://x').searchParams)
}

// ── Lógica de pagamento ───────────────────────────────────────────────────────
function normalizeMsisdn(p) { const d = String(p).replace(/\D/g,''); return d.startsWith('258') ? d : '258'+d }
function detectMethod(msisdn) {
  const l = msisdn.replace(/^258/,'')
  if (l.startsWith('84')||l.startsWith('85')) return 'mpesa'
  if (l.startsWith('86')||l.startsWith('87')) return 'emola'
  return null
}

function notifyTx(txId, data) {
  const clients = sseClients.get(txId)
  if (!clients) return
  const msg = `data: ${JSON.stringify(data)}\n\n`
  for (const r of clients) { try { r.write(msg) } catch {} }
}

async function initiateCharge(tx, sourceId, customerName) {
  const walletId = tx.method === 'mpesa' ? WALLET_MPESA : WALLET_EMOLA
  try {
    const resp = await fetch(`${ZUMBO_BASE}/charges`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'Authorization':`Bearer ${ZUMBO_API_KEY}`, 'X-Merchant-Id':ZUMBO_MERCHANT_ID },
      body: JSON.stringify({ wallet_id:walletId, amount:tx.amount, msisdn:tx.msisdn, customer_name:customerName, source_id:sourceId }),
    })
    const data = await resp.json().catch(()=>({}))
    console.log(`[ZumboPay] POST /charges → ${resp.status}`, JSON.stringify(data))
    if (resp.status === 200) {
      tx.ref = data.data?.reference || sourceId; tx.status = 'succeeded'
      notifyTx(tx.id, { status:'succeeded', method:tx.method })
      updateOrderStatus(tx.id, 'succeeded'); return
    }
    if (resp.status === 202) {
      tx.ref = data.data?.reference || sourceId; tx.status = 'pending'
      notifyTx(tx.id, { status:'pending', method:tx.method })
      scheduleTimeout(tx); return
    }
    const msg = data.error?.message || data.message || data.detail || `Erro ${resp.status}`
    tx.status = 'failed'; tx.error = msg
    notifyTx(tx.id, { status:'failed', error:msg, method:tx.method })
    updateOrderStatus(tx.id, 'failed')
  } catch (err) {
    console.error('[ZumboPay]', err.message)
    tx.status = 'failed'; tx.error = 'Erro de ligação. Tente novamente.'
    notifyTx(tx.id, { status:'failed', error:tx.error, method:tx.method })
    updateOrderStatus(tx.id, 'failed')
  }
}

function scheduleTimeout(tx) {
  setTimeout(() => {
    if (tx.status !== 'pending') return
    tx.status = 'failed'; tx.error = 'Tempo esgotado. O PIN não foi introduzido.'
    notifyTx(tx.id, { status:'failed', error:tx.error, method:tx.method })
    updateOrderStatus(tx.id, 'failed')
  }, 5 * 60 * 1000)
}

// ── Router ────────────────────────────────────────────────────────────────────
async function router(req, res) {
  const method = req.method
  const path   = req.url.split('?')[0]
  res.setHeader('Access-Control-Allow-Origin', '*')

  // ── Páginas públicas ──────────────────────────────────────────────────────
  if (method === 'GET' && path === '/')         return html(res, landingPage())
  if (method === 'GET' && path === '/megas')    return html(res, megasPage())
  if (method === 'GET' && path === '/deposito') return html(res, depositPage())
  if (method === 'GET' && path === '/ping')     return json(res, { ok: true })

  // ── SSE ───────────────────────────────────────────────────────────────────
  const evtP = parseParams('/events/:txId', path)
  if (method === 'GET' && evtP) {
    const { txId } = evtP
    res.writeHead(200, { 'Content-Type':'text/event-stream', 'Cache-Control':'no-cache', 'Connection':'keep-alive' })
    if (!sseClients.has(txId)) sseClients.set(txId, new Set())
    sseClients.get(txId).add(res)
    req.on('close', () => sseClients.get(txId)?.delete(res))
    const tx = transactions.get(txId)
    if (tx) res.write(`data: ${JSON.stringify({ status:tx.status, method:tx.method })}\n\n`)
    return
  }

  // ── API webhook-status ────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/webhook-status') {
    try {
      const r = await fetch(`${ZUMBO_BASE}/merchant/validate`, {
        headers: { 'Authorization':`Bearer ${ZUMBO_API_KEY}`, 'X-Merchant-Id':ZUMBO_MERCHANT_ID },
      })
      const data = await r.json().catch(()=>({}))
      const wh = data?.data?.webhook
      return json(res, { registered:!!wh, url:wh?.url||null, active:wh?.is_active||false })
    } catch { return json(res, { registered:false, url:null, active:false }) }
  }

  // ── API depósito ──────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/deposit') {
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { phone, amount, customer_name } = body
    if (!phone || !amount) return json(res, { error:'Telemóvel e valor obrigatórios.' }, 400)
    const msisdn = normalizeMsisdn(phone), meth = detectMethod(msisdn)
    const n = Number(amount)
    if (isNaN(n)||n<=0) return json(res, { error:'Valor inválido.' }, 400)
    if (!meth) return json(res, { error:'Número inválido. Use 84/85 (M-Pesa) ou 86/87 (e-Mola).' }, 400)
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'deposit', phone, msisdn, amount:n, method:meth, status:'pending', ref:null, error:null, ts:new Date().toISOString() }
    transactions.set(txId, tx)
    trackOrder(tx)
    json(res, { txId, status:'pending', method:meth })
    initiateCharge(tx, `dep-${txId}`, customer_name || 'Cliente')
    return
  }

  const depP = parseParams('/api/deposit/:txId', path)
  if (method === 'GET' && depP) {
    const tx = transactions.get(depP.txId)
    return tx ? json(res, tx) : json(res, { error:'Não encontrado.' }, 404)
  }

  // ── API encomenda de megas ────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/order') {
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { phone, bundleId } = body
    const bundle = BUNDLES.get(bundleId)
    if (!bundle) return json(res, { error:'Pacote inválido.' }, 400)
    const msisdn = normalizeMsisdn(phone), meth = detectMethod(msisdn)
    if (!meth) return json(res, { error:'Número inválido. Use 84/85 (M-Pesa) ou 86/87 (e-Mola).' }, 400)
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'bundle', bundleId, bundleLabel:bundle.label, phone, msisdn, amount:bundle.price, method:meth, status:'pending', ref:null, error:null, ts:new Date().toISOString() }
    transactions.set(txId, tx)
    trackOrder(tx)
    json(res, { txId, status:'pending', method:meth })
    initiateCharge(tx, `bnd-${txId}`, `Mega ${bundle.label}`)
    return
  }

  // ── Webhook ZumboPay ──────────────────────────────────────────────────────
  if (method === 'POST' && path === '/webhook') {
    const raw = await readBody(req), rawStr = raw.toString()
    const sig = req.headers['x-zumbopay-signature'] || ''
    if (ZUMBO_WEBHOOK_SECRET && sig) {
      try {
        const exp = createHmac('sha256', ZUMBO_WEBHOOK_SECRET).update(rawStr).digest('hex')
        const ok  = sig.length > 0 && sig === exp
        if (!ok) return json(res, { error:'Assinatura inválida.' }, 401)
      } catch { return json(res, { error:'Assinatura inválida.' }, 401) }
    }
    let event = {}; try { event = JSON.parse(rawStr) } catch {}
    const ref    = event.data?.reference || event.data?.source_id || event.data?.id
    const status = event.event === 'payment.succeeded' ? 'succeeded' : event.event === 'payment.failed' ? 'failed' : null
    if (status && ref) {
      for (const [txId, tx] of transactions) {
        const src = 'dep-'+tx.id, bsrc = 'bnd-'+tx.id
        if ([tx.ref,tx.id,src,bsrc,event.data?.source_id].includes(ref) || [tx.ref,tx.id,src,bsrc].includes(event.data?.source_id)) {
          tx.status = status
          tx.error  = status==='failed' ? (event.data?.message||'Pagamento recusado.') : null
          notifyTx(txId, { status, error:tx.error, method:tx.method })
          updateOrderStatus(txId, status)
          console.log(`[Webhook] ${txId} → ${status}`)
          break
        }
      }
    }
    return json(res, { ok:true })
  }

  // ── Admin panel ───────────────────────────────────────────────────────────
  if (path === '/admin/office') {
    if (method === 'GET') {
      if (!checkAdminCookie(req)) return html(res, adminLoginPage())
      const q = parseQuery(req)
      return html(res, adminDashboard(q.filter || 'all'))
    }
    if (method === 'POST') {
      let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
      if (body.password === ADMIN_PASS) {
        const token = adminToken()
        return redirect(res, '/admin/office', { 'Set-Cookie': `nsa=${token}; Path=/; HttpOnly; SameSite=Strict` })
      }
      return html(res, adminLoginPage('Senha incorrecta.'))
    }
  }

  if (method === 'POST' && path === '/admin/activate') {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const rec = orders.find(o => o.txId === body.txId)
    if (!rec) return json(res, { error:'Encomenda não encontrada.' }, 404)
    rec.status = 'activated'; rec.activatedAt = new Date().toISOString()
    await saveOrders()
    return json(res, { ok:true })
  }

  if (method === 'GET' && path === '/admin/logout') {
    return redirect(res, '/admin/office', { 'Set-Cookie': 'nsa=; Path=/; Max-Age=0' })
  }

  if (method === 'GET' && path === '/admin/orders.json') {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    return json(res, orders)
  }

  json(res, { error:'Not found.' }, 404)
}

// ── PÁGINA: Landing ───────────────────────────────────────────────────────────
function landingPage() { return `<!DOCTYPE html>
<html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Net Serviços — Internet & Pagamentos</title>
<script>(function(){document.addEventListener('contextmenu',e=>e.preventDefault());document.addEventListener('keydown',function(e){const c=e.ctrlKey||e.metaKey;if(e.key==='F12'){e.preventDefault();return false}if(c&&e.shiftKey&&['I','J','C','K'].includes(e.key.toUpperCase())){e.preventDefault();return false}if(c&&['u','U','s','S','a','A','c','C','x','X'].includes(e.key)){e.preventDefault();return false}},true);['copy','cut','selectstart','dragstart'].forEach(ev=>document.addEventListener(ev,e=>e.preventDefault(),true))})()
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;user-select:none;-webkit-user-select:none;}
:root{--bg:#07080f;--s:#0d0f1a;--card:#111422;--b:#1a1e35;--accent:#10b981;--blue:#3b82f6;--text:#e8eaf6;--muted:#4a5080;--r:16px;}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;}

/* nav */
.nav{display:flex;align-items:center;justify-content:space-between;padding:16px 24px;border-bottom:1px solid var(--b);position:sticky;top:0;background:rgba(7,8,15,.9);backdrop-filter:blur(16px);z-index:50;}
.nav-logo{display:flex;align-items:center;gap:10px;}
.nav-logo-icon{width:38px;height:38px;background:linear-gradient(135deg,var(--accent),#059669);border-radius:11px;display:flex;align-items:center;justify-content:center;font-size:19px;box-shadow:0 4px 16px rgba(16,185,129,.3);}
.nav-logo-text{font-size:17px;font-weight:800;letter-spacing:-.3px;}
.nav-logo-text span{color:var(--accent);}
.nav-links{display:flex;gap:8px;}
.nav-btn{padding:7px 16px;border-radius:8px;font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;text-decoration:none;border:1.5px solid var(--b);color:var(--muted);background:transparent;transition:all .15s;}
.nav-btn:hover,.nav-btn.act{border-color:var(--accent);color:var(--accent);background:rgba(16,185,129,.07);}

/* hero */
.hero{padding:72px 24px 60px;text-align:center;background:radial-gradient(ellipse 80% 50% at 50% -10%,rgba(16,185,129,.12) 0%,transparent 70%);}
.hero-tag{display:inline-flex;align-items:center;gap:6px;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.2);border-radius:999px;padding:5px 14px;font-size:12px;font-weight:700;color:var(--accent);margin-bottom:24px;letter-spacing:.3px;}
.hero-title{font-size:clamp(32px,6vw,56px);font-weight:900;letter-spacing:-1.5px;line-height:1.1;margin-bottom:18px;}
.hero-title span{background:linear-gradient(135deg,var(--accent),#3b82f6);-webkit-background-clip:text;-webkit-text-fill-color:transparent;background-clip:text;}
.hero-sub{font-size:16px;color:var(--muted);line-height:1.7;max-width:480px;margin:0 auto 40px;}
.hero-btns{display:flex;gap:12px;justify-content:center;flex-wrap:wrap;}
.btn-primary{padding:14px 28px;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;border:none;background:linear-gradient(135deg,var(--accent),#059669);color:#fff;text-decoration:none;box-shadow:0 8px 24px rgba(16,185,129,.35);transition:transform .15s,box-shadow .15s;}
.btn-primary:hover{transform:translateY(-2px);box-shadow:0 12px 32px rgba(16,185,129,.45);}
.btn-sec{padding:14px 28px;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;border:1.5px solid var(--b);color:var(--text);text-decoration:none;background:var(--card);transition:border-color .15s;}
.btn-sec:hover{border-color:var(--blue);}

/* services */
.section{padding:60px 24px;max-width:900px;margin:0 auto;}
.sec-title{font-size:13px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:1px;margin-bottom:10px;}
.sec-h{font-size:clamp(22px,4vw,32px);font-weight:800;letter-spacing:-.5px;margin-bottom:40px;}
.services{display:grid;grid-template-columns:1fr 1fr;gap:16px;}
@media(max-width:600px){.services{grid-template-columns:1fr;}}
.svc{background:var(--card);border:1px solid var(--b);border-radius:20px;padding:28px 24px;text-decoration:none;color:var(--text);transition:border-color .2s,transform .15s,box-shadow .2s;display:block;}
.svc:hover{border-color:var(--accent);transform:translateY(-3px);box-shadow:0 16px 48px rgba(0,0,0,.4);}
.svc-icon{width:52px;height:52px;border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:24px;margin-bottom:18px;}
.svc-icon.green{background:rgba(16,185,129,.12);border:1px solid rgba(16,185,129,.2);}
.svc-icon.blue{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.2);}
.svc-title{font-size:18px;font-weight:800;margin-bottom:8px;}
.svc-desc{font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:18px;}
.svc-link{font-size:13px;font-weight:700;display:flex;align-items:center;gap:6px;}
.svc-link.green{color:var(--accent);}
.svc-link.blue{color:var(--blue);}
.svc-badge{display:inline-block;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.18);border-radius:6px;padding:3px 8px;font-size:11px;font-weight:700;color:var(--accent);margin-bottom:8px;}

/* steps */
.steps-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:20px;}
@media(max-width:600px){.steps-grid{grid-template-columns:1fr;}}
.step{text-align:center;padding:24px 16px;}
.step-n{width:44px;height:44px;border-radius:50%;background:var(--card);border:1.5px solid var(--b);font-size:18px;font-weight:900;color:var(--accent);display:flex;align-items:center;justify-content:center;margin:0 auto 16px;}
.step-t{font-size:14px;font-weight:700;margin-bottom:6px;}
.step-d{font-size:12px;color:var(--muted);line-height:1.6;}

/* stats */
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin:40px 0;}
@media(max-width:500px){.stats{grid-template-columns:1fr;}}
.stat{background:var(--card);border:1px solid var(--b);border-radius:16px;padding:24px;text-align:center;}
.stat-n{font-size:32px;font-weight:900;color:var(--accent);margin-bottom:4px;}
.stat-l{font-size:12px;color:var(--muted);}

/* footer */
.footer{border-top:1px solid var(--b);padding:28px 24px;text-align:center;color:var(--muted);font-size:12px;}
.footer strong{color:var(--text);}

/* divider */
.divider{height:1px;background:var(--b);margin:0 24px;}
</style>
</head><body>

<nav class="nav">
  <div class="nav-logo">
    <div class="nav-logo-icon">🌐</div>
    <div class="nav-logo-text">Net <span>Serviços</span></div>
  </div>
  <div class="nav-links">
    <a href="/megas"    class="nav-btn">Megas</a>
    <a href="/deposito" class="nav-btn">Depósito</a>
  </div>
</nav>

<div class="hero">
  <div class="hero-tag">✓ Vodacom · M-Pesa · e-Mola</div>
  <h1 class="hero-title">Internet rápida,<br><span>pagamentos seguros</span></h1>
  <p class="hero-sub">Compre pacotes de internet Vodacom ou faça depósitos directamente do seu telemóvel. Simples, rápido e seguro.</p>
  <div class="hero-btns">
    <a href="/megas"    class="btn-primary">🌐 Comprar Megas</a>
    <a href="/deposito" class="btn-sec">💳 Fazer Depósito</a>
  </div>
</div>

<div class="divider"></div>

<div class="section">
  <div class="sec-title">Os nossos serviços</div>
  <div class="sec-h">Escolha o que precisa</div>
  <div class="services">
    <a href="/megas" class="svc">
      <div class="svc-icon green">🌐</div>
      <div class="svc-badge">Vodacom</div>
      <div class="svc-title">Megas de Internet</div>
      <div class="svc-desc">Pacotes Normal, Premium 3 Dias, 7 Dias, Mensal e Diamante. A partir de 10 MT.</div>
      <div class="svc-link green">Ver todos os pacotes →</div>
    </a>
    <a href="/deposito" class="svc">
      <div class="svc-icon blue">💳</div>
      <div class="svc-title">Depósito Directo</div>
      <div class="svc-desc">Deposite fundos directamente via M-Pesa ou e-Mola com confirmação instantânea.</div>
      <div class="svc-link blue">Fazer depósito →</div>
    </a>
  </div>
</div>

<div class="divider"></div>

<div class="section">
  <div class="sec-title">Como funciona</div>
  <div class="sec-h">3 passos simples</div>
  <div class="steps-grid">
    <div class="step">
      <div class="step-n">1</div>
      <div class="step-t">Escolha o pacote</div>
      <div class="step-d">Seleccione a categoria e o pacote que melhor se adapta à sua necessidade.</div>
    </div>
    <div class="step">
      <div class="step-n">2</div>
      <div class="step-t">Confirme o PIN</div>
      <div class="step-d">Recebe um pedido no telemóvel via M-Pesa ou e-Mola. Introduza o seu PIN.</div>
    </div>
    <div class="step">
      <div class="step-n">3</div>
      <div class="step-t">Pronto!</div>
      <div class="step-d">O pacote é activado em 5–15 minutos após confirmação do pagamento.</div>
    </div>
  </div>
</div>

<div class="footer">
  <strong>Net Serviços</strong> &nbsp;·&nbsp; Internet & Pagamentos em Moçambique &nbsp;·&nbsp; Válido para Vodacom
</div>

</body></html>`
}

// ── PÁGINA: Megas ─────────────────────────────────────────────────────────────
function megasPage() {
  // ── Catálogo server-side ───────────────────────────────────────────────────
  const CAT_DATA = {
    diarias: {
      note: null,
      pkgs: [
        {id:'n01',name:'Diário 10', size:'380 MB', price:10,  dur:'1 dia(s)'},
        {id:'n02',name:'Diário 13', size:'512 MB', price:13,  dur:'1 dia(s)'},
        {id:'n03',name:'Diário 17', size:'624 MB', price:17,  dur:'1 dia(s)'},
        {id:'n04',name:'Diário 20', size:'780 MB', price:20,  dur:'1 dia(s)'},
        {id:'n05',name:'Diário 25', size:'1 GB',   price:25,  dur:'1 dia(s)'},
        {id:'n06',name:'Diário 28', size:'1.1 GB', price:28,  dur:'1 dia(s)'},
        {id:'n07',name:'Diário 41', size:'1.6 GB', price:41,  dur:'1 dia(s)'},
        {id:'n08',name:'Diário 50', size:'2 GB',   price:50,  dur:'1 dia(s)'},
        {id:'n09',name:'Diário 75', size:'3 GB',   price:75,  dur:'1 dia(s)'},
        {id:'n10',name:'Diário 100',size:'4 GB',   price:100, dur:'1 dia(s)'},
        {id:'n11',name:'Diário 125',size:'5 GB',   price:125, dur:'1 dia(s)'},
        {id:'n12',name:'Diário 150',size:'6 GB',   price:150, dur:'1 dia(s)'},
        {id:'n13',name:'Diário 175',size:'7 GB',   price:175, dur:'1 dia(s)'},
        {id:'n14',name:'Diário 200',size:'8 GB',   price:200, dur:'1 dia(s)'},
        {id:'n15',name:'Diário 225',size:'9 GB',   price:225, dur:'1 dia(s)'},
        {id:'n16',name:'Diário 250',size:'10 GB',  price:250, dur:'1 dia(s)'},
      ]
    },
    semanais: {
      note: 'ℹ️ Premium: renovável · +100MB ao renovar nos primeiros 3 dias.',
      pkgs: [
        {id:'p01',name:'Premium 57', size:'1.7 GB',price:57,  dur:'3 dia(s)'},
        {id:'p02',name:'Premium 83', size:'2.6 GB',price:83,  dur:'3 dia(s)'},
        {id:'p03',name:'Premium 100',size:'3.4 GB',price:100, dur:'3 dia(s)'},
        {id:'p04',name:'Premium 135',size:'4 GB',  price:135, dur:'3 dia(s)'},
        {id:'p05',name:'Premium 160',size:'5.4 GB',price:160, dur:'3 dia(s)'},
        {id:'p06',name:'Premium 180',size:'6.2 GB',price:180, dur:'3 dia(s)'},
        {id:'p07',name:'Premium 280',size:'9.5 GB',price:280, dur:'3 dia(s)'},
        {id:'s01',name:'Semanal 49', size:'1.7 GB',price:49,  dur:'7 dia(s)'},
        {id:'s02',name:'Semanal 85', size:'2.9 GB',price:85,  dur:'7 dia(s)'},
        {id:'s03',name:'Semanal 90', size:'3.4 GB',price:90,  dur:'7 dia(s)'},
        {id:'s04',name:'Semanal 145',size:'5.3 GB',price:145, dur:'7 dia(s)'},
        {id:'s05',name:'Semanal 200',size:'7.2 GB',price:200, dur:'7 dia(s)'},
        {id:'s06',name:'Semanal 290',size:'11 GB', price:290, dur:'7 dia(s)'},
      ]
    },
    mensais: {
      note: 'ℹ️ ⚠️ Não deve ter Txuna crédito activo antes de activar.',
      pkgs: [
        {id:'m01',name:'Mensal 95', size:'2.8 GB', price:95,  dur:'30 dia(s)'},
        {id:'m02',name:'Mensal 195',size:'5.8 GB', price:195, dur:'30 dia(s)'},
        {id:'m03',name:'Mensal 210',size:'7.8 GB', price:210, dur:'30 dia(s)'},
        {id:'m04',name:'Mensal 320',size:'10.8 GB',price:320, dur:'30 dia(s)'},
        {id:'m05',name:'Mensal 480',size:'17.8 GB',price:480, dur:'30 dia(s)'},
        {id:'m06',name:'Mensal 575',size:'20.8 GB',price:575, dur:'30 dia(s)'},
        {id:'m07',name:'Mensal 950',size:'32.8 GB',price:950, dur:'30 dia(s)'},
      ]
    },
    infinitas: {
      note: 'ℹ️ ⚠️ Não deve ter Txuna crédito activo. Inclui chamadas + SMS ilimitadas.',
      pkgs: [
        {id:'d01',name:'Diamante 450', size:'11 GB',price:450,  dur:'30 dia(s)',calls:'Chamadas + SMS ilim.'},
        {id:'d02',name:'Diamante 580', size:'15 GB',price:580,  dur:'30 dia(s)',calls:'Chamadas + SMS ilim.'},
        {id:'d03',name:'Diamante 720', size:'21 GB',price:720,  dur:'30 dia(s)',calls:'Chamadas + SMS ilim.'},
        {id:'d04',name:'Diamante 970', size:'30 GB',price:970,  dur:'30 dia(s)',calls:'Chamadas + SMS ilim.'},
        {id:'d05',name:'Diamante 1490',size:'50 GB',price:1490, dur:'30 dia(s)',calls:'Chamadas + SMS ilim.'},
      ]
    },
  }
  const CATS_ORDER = ['diarias','semanais','mensais','infinitas']

  // Generate one slide card HTML
  const slideHtml = p =>
    `<div class="carousel-slide"><div class="vcard">` +
    `<div class="vcard-header"><span class="vcard-name">${p.name}</span>` +
    `<button class="vcard-buy" onclick="openBuy('${p.id}');event.stopPropagation()">Activar</button></div>` +
    `<div class="vcard-info"><div class="vi-price"><span>${p.price} MT</span></div>` +
    `<div class="vi-dur"><span>${p.dur}</span></div></div>` +
    `<div class="vcard-data"><div class="vdata-left">` +
    `<div class="arrows"><span class="arr-up">▲</span><span class="arr-dn">▼</span></div>` +
    `<span class="vdata-label">Dados</span></div><span class="vdata-size">${p.size}</span></div>` +
    (p.calls ? `<div class="vcard-extra"><div class="vextra-left"><span class="vextra-icon">📞</span>` +
      `<span class="vextra-label">Voz + SMS</span></div><span class="vextra-val">${p.calls}</span></div>` : '') +
    `<div class="vcard-footer"><button class="share-btn" onclick="event.stopPropagation()">⋮</button></div>` +
    `</div></div>`

  // Generate one full category section HTML
  const sectionHtml = (catId, visible) => {
    const {note, pkgs} = CAT_DATA[catId]
    const slides = pkgs.map(slideHtml).join('')
    const dots   = pkgs.map((_,i) => `<div class="dot${i===0?' active':''}"></div>`).join('')
    const noteHtml = note ? `<div class="cat-note show">${note}</div>` : ''
    return `<div class="cat-section" id="cat-${catId}"${visible ? '' : ' style="display:none"'}>` +
      noteHtml +
      `<div class="carousel-outer" id="co-${catId}">${slides}</div>` +
      `<div class="dots" id="dots-${catId}">${dots}</div>` +
      `</div>`
  }

  // Build all 4 sections
  const allSections = CATS_ORDER.map((c, i) => sectionHtml(c, i === 0)).join('')

  // JS catalog (for the buy sheet)
  const jsPkgs = 'const PKGS_ALL={' +
    CATS_ORDER.map(c =>
      `"${c}":[${CAT_DATA[c].pkgs.map(p =>
        `{id:"${p.id}",name:"${p.name}",size:"${p.size}",price:${p.price},dur:"${p.dur}"` +
        (p.calls ? `,calls:"${p.calls}"` : '') + '}'
      ).join(',')}]`
    ).join(',') + '}'

  return `<!DOCTYPE html>
<html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1,user-scalable=no">
<title>Megas — Net Serviços</title>
<script>(function(){document.addEventListener('contextmenu',e=>e.preventDefault());document.addEventListener('keydown',function(e){const c=e.ctrlKey||e.metaKey;if(e.key==='F12'){e.preventDefault();return false}if(c&&e.shiftKey&&['I','J','C','K'].includes(e.key.toUpperCase())){e.preventDefault();return false}if(c&&['u','U','s','S','a','A','c','C','x','X'].includes(e.key)){e.preventDefault();return false}},true);['copy','cut','selectstart','dragstart'].forEach(ev=>document.addEventListener(ev,e=>e.preventDefault(),true))})()
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{background:#f2f2f7;color:#1c1c1e;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden;user-select:none;-webkit-user-select:none;}

/* ── Nav ── */
.nav{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:#fff;border-bottom:1px solid #e5e5ea;position:sticky;top:0;z-index:50;}
.nav-logo{display:flex;align-items:center;gap:8px;text-decoration:none;color:#1c1c1e;}
.nav-logo-icon{width:28px;height:28px;background:#cc0000;border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:13px;}
.nav-logo-text{font-size:15px;font-weight:800;}
.nav-logo-text span{color:#cc0000;}
.nav-back{font-size:13px;color:#cc0000;text-decoration:none;font-weight:600;}

/* ── Offer header ── */
.offer-header{padding:24px 20px 32px;background:#fff;border-bottom:1px solid #e5e5ea;text-align:left;}
.offer-title{font-size:18px;font-weight:700;color:#1c1c1e;margin-bottom:10px;text-align:center;}
.offer-desc{font-size:14px;color:#3a3a3c;line-height:1.6;}

/* ── Tabs (Vodacom style) ── */
.tabs-wrap{background:#fff;border-bottom:1px solid #e5e5ea;position:sticky;top:53px;z-index:40;}
.tabs{display:flex;overflow-x:auto;scrollbar-width:none;}
.tabs::-webkit-scrollbar{display:none;}
.tab{flex:1;min-width:80px;padding:14px 8px 12px;background:none;border:none;font-size:14px;font-weight:600;font-family:inherit;color:#8e8e93;cursor:pointer;white-space:nowrap;text-align:center;position:relative;transition:color .15s;}
.tab.active{color:#cc0000;}
.tab.active::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2.5px;background:#cc0000;border-radius:2px 2px 0 0;}

/* ── Carousel area ── */
.carousel-area{padding:24px 0 12px;position:relative;}
.carousel-outer{width:100%;display:flex;overflow-x:scroll;scroll-snap-type:x mandatory;scrollbar-width:none;-webkit-overflow-scrolling:touch;}
.carousel-outer::-webkit-scrollbar{display:none;}

/* ── Slide wrapper ── */
.carousel-slide{flex:0 0 100%;scroll-snap-align:start;padding:0 20px;}

/* ── Card (Vodacom style) ── */
.vcard{background:#fff;border-radius:16px;box-shadow:0 2px 16px rgba(0,0,0,.10);overflow:hidden;cursor:pointer;}

/* Red header */
.vcard-header{background:#cc0000;padding:18px 20px 20px;display:flex;align-items:center;justify-content:space-between;border-radius:16px 16px 0 0;}
.vcard-name{font-size:18px;font-weight:700;color:#fff;}
.vcard-buy{background:transparent;border:2px solid #fff;border-radius:6px;padding:7px 18px;color:#fff;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap;}
.vcard-buy:active{background:rgba(255,255,255,.15);}

/* Dark info row */
.vcard-info{display:flex;overflow:hidden;}
.vi-price{flex:1;background:#3a3a3c;padding:12px 16px;display:flex;align-items:center;}
.vi-price span{font-size:17px;font-weight:700;color:#fff;}
.vi-dur{background:#636366;padding:12px 16px;display:flex;align-items:center;}
.vi-dur span{font-size:17px;font-weight:700;color:#fff;white-space:nowrap;}

/* Data row */
.vcard-data{padding:14px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e5e5ea;}
.vdata-left{display:flex;align-items:center;gap:10px;}
.arrows{display:flex;flex-direction:column;align-items:center;gap:1px;}
.arr-up{font-size:13px;color:#8e8e93;line-height:1;}
.arr-dn{font-size:13px;color:#cc0000;line-height:1;}
.vdata-label{font-size:15px;color:#1c1c1e;font-weight:500;}
.vdata-size{font-size:15px;color:#1c1c1e;font-weight:600;}

/* Extra info (calls, SMS) */
.vcard-extra{padding:10px 16px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #e5e5ea;}
.vextra-left{display:flex;align-items:center;gap:10px;}
.vextra-icon{font-size:14px;color:#cc0000;}
.vextra-label{font-size:13px;color:#1c1c1e;}
.vextra-val{font-size:13px;color:#1c1c1e;font-weight:600;}

/* Footer */
.vcard-footer{padding:12px 16px;display:flex;justify-content:flex-end;}
.share-btn{background:none;border:none;cursor:pointer;font-size:20px;color:#8e8e93;padding:4px;}

/* ── Dots ── */
.dots{display:flex;justify-content:center;gap:5px;padding:14px 0 8px;}
.dot{width:6px;height:6px;border-radius:50%;background:#d1d1d6;transition:background .2s,width .2s;}
.dot.active{background:#cc0000;width:18px;border-radius:3px;}

/* ── Note banner ── */
.cat-note{margin:0 20px 16px;padding:10px 14px;background:#fff3cd;border:1px solid #ffc107;border-radius:10px;font-size:12px;color:#856404;line-height:1.5;display:none;}
.cat-note.show{display:block;}

/* ── Bottom sheet ── */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;display:none;backdrop-filter:blur(4px);}
.overlay.open{display:block;}
.sheet{position:fixed;bottom:0;left:0;right:0;max-width:480px;margin:0 auto;background:#1c1c1e;border-radius:20px 20px 0 0;z-index:101;padding:0 20px 40px;transform:translateY(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);max-height:90vh;overflow-y:auto;}
.sheet.open{transform:translateY(0);}
.sh-handle{width:36px;height:4px;background:#3a3a3c;border-radius:2px;margin:12px auto 20px;}
.s-buy,.s-pending,.s-success,.s-failed{display:none;color:#f2f2f7;}
.sel-pkg{background:#cc000015;border:1px solid #cc000035;border-radius:12px;padding:14px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;}
.sel-size{font-size:18px;font-weight:800;color:#f2f2f7;}
.sel-cat{font-size:11px;color:#8e8e93;margin-top:2px;}
.sel-price{font-size:26px;font-weight:900;color:#cc0000;}
.sel-cur{font-size:12px;color:#8e8e93;}
.lbl{font-size:11px;font-weight:700;color:#8e8e93;text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px;display:block;}
.inp{width:100%;background:#2c2c2e;border:1.5px solid #3a3a3c;border-radius:12px;padding:13px 14px 13px 42px;color:#f2f2f7;font-size:16px;font-family:inherit;outline:none;transition:border-color .15s;}
.inp:focus{border-color:#cc0000;}
.inp::placeholder{color:#636366;}
.inp-w{position:relative;}
.inp-ico{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:16px;color:#636366;pointer-events:none;}
.hint{font-size:11px;color:#636366;margin-top:6px;}
.errs{background:rgba(255,59,48,.1);border:1px solid rgba(255,59,48,.3);border-radius:10px;padding:10px 14px;font-size:13px;color:#ff6b6b;margin-bottom:14px;display:none;}
.btn{width:100%;padding:15px;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;background:#cc0000;color:#fff;margin-top:14px;transition:opacity .2s;}
.btn:hover{opacity:.9;}.btn:active{opacity:.8;}.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn-g{background:transparent;border:1.5px solid #3a3a3c;color:#8e8e93;margin-top:10px;}
.btn-g:hover{border-color:#cc0000;color:#f2f2f7;}
.spinner{width:52px;height:52px;border:4px solid #3a3a3c;border-top-color:#cc0000;border-radius:50%;animation:spin 1s linear infinite;margin:8px auto 20px;}
@keyframes spin{to{transform:rotate(360deg)}}
.pend-ph{display:block;text-align:center;padding:6px 16px;background:rgba(204,0,0,.1);border:1px solid rgba(204,0,0,.2);border-radius:8px;font-size:14px;font-weight:700;color:#cc0000;margin-bottom:16px;}
.psteps{list-style:none;background:#2c2c2e;border:1px solid #3a3a3c;border-radius:12px;padding:12px 16px;}
.psteps li{font-size:12px;color:#8e8e93;padding:6px 0;display:flex;align-items:flex-start;gap:8px;border-bottom:1px solid #3a3a3c;}
.psteps li:last-child{border-bottom:none;}
.sn{min-width:18px;height:18px;border-radius:50%;background:rgba(204,0,0,.15);color:#cc0000;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
.res-icon{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:28px;margin:8px auto 16px;}
.res-icon.ok{background:rgba(52,199,89,.15);}
.res-icon.bad{background:rgba(255,59,48,.12);}
.res-t{font-size:20px;font-weight:700;text-align:center;margin-bottom:6px;}
.res-s{font-size:13px;color:#8e8e93;text-align:center;line-height:1.6;margin-bottom:20px;}
.res-box{background:rgba(204,0,0,.07);border:1px solid rgba(204,0,0,.15);border-radius:10px;padding:14px;text-align:center;margin-bottom:20px;}
.res-box-l{font-size:11px;color:#8e8e93;margin-bottom:4px;}
.res-box-v{font-size:16px;font-weight:700;color:#cc0000;}
</style>
</head><body>

<nav class="nav">
  <a href="/" class="nav-logo">
    <div class="nav-logo-icon">🌐</div>
    <div class="nav-logo-text">Net <span>Serviços</span></div>
  </a>
  <a href="/" class="nav-back">← Início</a>
</nav>

<div class="offer-header">
  <h2 class="offer-title">Ofertas de Internet</h2>
  <p class="offer-desc">São ofertas diferenciadas e ricas em <strong>DADOS</strong> que te permitem aceder a todas as plataformas e conteúdos de internet para navegares à vontade.</p>
</div>

<div class="tabs-wrap">
  <div class="tabs" id="tab-bar">
    <button class="tab active" onclick="setCat('diarias')">Diárias</button>
    <button class="tab" onclick="setCat('semanais')">Semanais</button>
    <button class="tab" onclick="setCat('mensais')">Mensais</button>
    <button class="tab" onclick="setCat('infinitas')">Infinitas</button>
  </div>
</div>

<div class="carousel-area">${allSections}</div>

<div class="overlay" id="overlay" onclick="closeSheet()"></div>
<div class="sheet" id="sheet">
  <div class="sh-handle"></div>
  <div class="s-buy" id="s-buy">
    <div class="sel-pkg">
      <div><div class="sel-size" id="sh-size"></div><div class="sel-cat" id="sh-cat"></div></div>
      <div style="text-align:right"><div class="sel-price" id="sh-price"></div><div class="sel-cur">MT</div></div>
    </div>
    <div class="errs" id="sh-err"></div>
    <label class="lbl">Número Vodacom do destinatário</label>
    <div class="inp-w" style="margin-bottom:6px"><span class="inp-ico">📱</span><input class="inp" id="sh-phone" type="tel" placeholder="84 000 0000" maxlength="15" inputmode="tel" autocomplete="off"></div>
    <div class="hint">84/85 → M-Pesa &nbsp;·&nbsp; 86/87 → e-Mola</div>
    <button class="btn" id="sh-btn" onclick="pay()">Pagar e Encomendar</button>
    <button class="btn btn-g" onclick="closeSheet()">Cancelar</button>
  </div>
  <div class="s-pending" id="s-pending">
    <div class="spinner"></div>
    <div class="res-t" style="margin-bottom:8px">Aguardando PIN</div>
    <div class="pend-ph" id="sh-pend-phone"></div>
    <p style="font-size:12px;color:#8e8e93;text-align:center;margin-bottom:14px;line-height:1.6">Introduza o <strong style="color:#f2f2f7">PIN</strong> no pedido recebido no telemóvel.</p>
    <ul class="psteps">
      <li><span class="sn">1</span>Verifique o telemóvel — pedido <span id="sh-method-lbl">M-Pesa</span> recebido</li>
      <li><span class="sn">2</span>Seleccione "Aceitar" e introduza o seu PIN</li>
      <li><span class="sn">3</span>Esta página actualiza automaticamente</li>
    </ul>
  </div>
  <div class="s-success" id="s-success">
    <div class="res-icon ok" style="font-size:32px">✓</div>
    <div class="res-t">Pedido recebido!</div>
    <p class="res-s">Pagamento confirmado. O seu pacote será activado em <strong style="color:#f2f2f7">5–15 minutos</strong>.</p>
    <div class="res-box"><div class="res-box-l">Pacote encomendado</div><div class="res-box-v" id="sh-ok-pkg"></div></div>
    <button class="btn" onclick="closeSheet()">Comprar outro pacote</button>
  </div>
  <div class="s-failed" id="s-failed">
    <div class="res-icon bad" style="font-size:32px">✗</div>
    <div class="res-t">Pagamento não confirmado</div>
    <p class="res-s" id="sh-fail-msg">O PIN não foi introduzido ou o tempo expirou.</p>
    <button class="btn" onclick="shShow('buy')">Tentar novamente</button>
    <button class="btn btn-g" onclick="closeSheet()">Cancelar</button>
  </div>
</div>

<script>
// ── Catálogo (para o sheet de compra) ──
${jsPkgs}
const CLABELS = {diarias:'Diárias',semanais:'Semanais',mensais:'Mensais',infinitas:'Infinitas'}
const CATS_JS  = ['diarias','semanais','mensais','infinitas']

let curCat = 'diarias', curPkg = null, evtSrc = null

// ── Tab switching (mostra/esconde secções pré-renderizadas) ──
function setCat(id) {
  curCat = id
  CATS_JS.forEach(c => {
    document.getElementById('cat-'+c).style.display = c === id ? 'block' : 'none'
  })
  document.querySelectorAll('.tab').forEach((t,i) => t.classList.toggle('active', CATS_JS[i] === id))
}

// ── Dots: actualizar ao deslizar (por carrossel) ──
CATS_JS.forEach(cat => {
  const co = document.getElementById('co-'+cat)
  if (!co) return
  co.addEventListener('scroll', () => {
    if (!co.clientWidth) return
    const idx = Math.round(co.scrollLeft / co.clientWidth)
    const dots = document.querySelectorAll('#dots-'+cat+' .dot')
    dots.forEach((d,i) => d.classList.toggle('active', i === idx))
  }, {passive: true})
})

// ── Sheet ──
function openBuy(id) {
  const all = Object.values(PKGS_ALL).flat()
  const p = all.find(x=>x.id===id); if(!p) return
  curPkg = p
  document.getElementById('sh-size').textContent = p.name
  document.getElementById('sh-cat').textContent  = CLABELS[curCat]||'' + ' · ' + p.dur
  document.getElementById('sh-price').textContent= p.price
  document.getElementById('sh-phone').value = ''
  document.getElementById('sh-err').style.display = 'none'
  document.getElementById('sh-btn').disabled = false
  document.getElementById('sh-btn').textContent = 'Pagar e Encomendar'
  shShow('buy')
  document.getElementById('overlay').classList.add('open')
  setTimeout(()=>document.getElementById('sheet').classList.add('open'),10)
}
function closeSheet() {
  document.getElementById('sheet').classList.remove('open')
  document.getElementById('overlay').classList.remove('open')
  if (evtSrc) { evtSrc.close(); evtSrc = null }
  setTimeout(()=>shShow('buy'), 300)
}
function shShow(s) { ['buy','pending','success','failed'].forEach(x=>document.getElementById('s-'+x).style.display=(x===s?'block':'none')) }

async function pay() {
  const phone = document.getElementById('sh-phone').value.trim()
  const ee = document.getElementById('sh-err'); ee.style.display='none'
  if (!phone) { ee.textContent='Introduza o número de telemóvel.'; ee.style.display='block'; return }
  const btn = document.getElementById('sh-btn'); btn.disabled=true; btn.textContent='A processar…'
  try {
    const r = await fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,bundleId:curPkg.id})})
    const d = await r.json()
    if (!r.ok) { ee.textContent=d.error||'Erro ao processar.'; ee.style.display='block'; btn.disabled=false; btn.textContent='Pagar e Encomendar'; return }
    document.getElementById('sh-pend-phone').textContent = phone
    document.getElementById('sh-method-lbl').textContent = d.method==='mpesa'?'M-Pesa':'e-Mola'
    document.getElementById('sh-ok-pkg').textContent = curPkg.name+' — '+curPkg.price+' MT'
    shShow('pending'); listenOrder(d.txId)
  } catch { ee.textContent='Erro de ligação. Tente novamente.'; ee.style.display='block'; btn.disabled=false; btn.textContent='Pagar e Encomendar' }
}
function listenOrder(txId) {
  if (evtSrc) evtSrc.close()
  evtSrc = new EventSource('/events/'+txId)
  evtSrc.onmessage = e => { const d=JSON.parse(e.data); if(d.status==='succeeded'){evtSrc.close();shShow('success')} if(d.status==='failed'){evtSrc.close();document.getElementById('sh-fail-msg').textContent=d.error||'Tempo expirou.';shShow('failed')} }
  evtSrc.onerror = () => { evtSrc.close(); setTimeout(()=>listenOrder(txId),3000) }
}

// Init: diarias já visível por defeito (HTML pré-renderizado)
</script>
</body></html>`
}

// ── PÁGINA: Depósito ──────────────────────────────────────────────────────────
function depositPage() { return `<!DOCTYPE html>
<html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Depósito — Net Serviços</title>
<script>(function(){document.addEventListener('contextmenu',e=>e.preventDefault());document.addEventListener('keydown',function(e){const c=e.ctrlKey||e.metaKey;if(e.key==='F12'){e.preventDefault();return false}if(c&&e.shiftKey&&['I','J','C','K'].includes(e.key.toUpperCase())){e.preventDefault();return false}if(c&&['u','U','s','S','a','A','c','C','x','X'].includes(e.key)){e.preventDefault();return false}},true);['copy','cut','selectstart','dragstart'].forEach(ev=>document.addEventListener(ev,e=>e.preventDefault(),true))})()
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;user-select:none;-webkit-user-select:none;}
:root{--bg:#07080f;--s:#0d0f1a;--card:#111422;--b:#1a1e35;--accent:#3b82f6;--green:#10b981;--red:#ef4444;--text:#e8eaf6;--muted:#4a5080;--r:18px;}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;padding:24px;}
.nav-top{width:100%;max-width:460px;display:flex;align-items:center;justify-content:space-between;margin-bottom:28px;}
.nav-logo{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:800;text-decoration:none;color:var(--text);}
.nav-logo-icon{width:30px;height:30px;background:linear-gradient(135deg,var(--green),#059669);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:14px;}
.nav-logo span{color:var(--green);}
.nav-back{font-size:12px;color:var(--muted);text-decoration:none;padding:6px 12px;border:1px solid var(--b);border-radius:8px;}
.nav-back:hover{color:var(--text);border-color:var(--accent);}
.brand-wrap{text-align:center;margin-bottom:24px;}
.brand-icon{width:54px;height:54px;background:linear-gradient(135deg,var(--accent),#6366f1);border-radius:15px;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 12px;box-shadow:0 8px 24px rgba(59,130,246,.3);}
.brand-name{font-size:20px;font-weight:800;}
.brand-name span{color:var(--accent);}
.card{background:var(--card);border:1px solid var(--b);border-radius:var(--r);padding:32px 28px;width:100%;max-width:420px;box-shadow:0 24px 64px rgba(0,0,0,.5);}
.card-title{font-size:20px;font-weight:800;margin-bottom:4px;}
.card-sub{font-size:13px;color:var(--muted);line-height:1.5;margin-bottom:24px;}
.field{margin-bottom:18px;}
.lbl{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:7px;}
.inp-w{position:relative;}
.ico{position:absolute;left:13px;top:50%;transform:translateY(-50%);font-size:15px;color:var(--muted);pointer-events:none;}
input{width:100%;background:var(--s);border:1.5px solid var(--b);border-radius:12px;padding:12px 13px 12px 40px;color:var(--text);font-size:15px;font-family:inherit;outline:none;transition:border-color .15s;}
input:focus{border-color:var(--accent);}
input::placeholder{color:var(--muted);}
.prefix-w input{padding-left:52px;font-size:20px;font-weight:700;}
.pfx{position:absolute;left:13px;font-size:12px;font-weight:700;color:var(--accent);pointer-events:none;}
.hint{font-size:11px;color:var(--muted);margin-top:5px;}
.btn{width:100%;padding:14px;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,var(--accent),#6366f1);color:#fff;margin-top:6px;transition:opacity .2s;}
.btn:hover{opacity:.9;}.btn:active{transform:scale(.99);}.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn-g{background:transparent;border:1.5px solid var(--b);color:var(--muted);margin-top:10px;}
.btn-g:hover{border-color:var(--accent);color:var(--text);}
#s-form,#s-pending,#s-success,#s-failed{display:none;}
.mb{display:inline-flex;align-items:center;gap:5px;padding:4px 11px;border-radius:999px;font-size:11px;font-weight:700;margin-bottom:18px;}
.mb.m{background:rgba(16,185,129,.1);color:var(--green);border:1px solid rgba(16,185,129,.18);}
.mb.e{background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.18);}
.spinner{width:52px;height:52px;border:4px solid var(--b);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:8px auto 22px;}
@keyframes spin{to{transform:rotate(360deg)}}
.big-amt{font-size:38px;font-weight:900;letter-spacing:-1px;}
.big-sub{font-size:13px;color:var(--muted);margin-bottom:24px;}
.pend-ph{display:inline-block;background:rgba(59,130,246,.1);border:1px solid rgba(59,130,246,.2);border-radius:8px;padding:4px 13px;font-size:14px;font-weight:700;color:var(--accent);margin-bottom:18px;}
.psteps{list-style:none;background:var(--s);border:1px solid var(--b);border-radius:12px;padding:12px 16px;text-align:left;}
.psteps li{font-size:12px;color:var(--muted);padding:6px 0;display:flex;align-items:flex-start;gap:8px;border-bottom:1px solid var(--b);}
.psteps li:last-child{border-bottom:none;}
.sn{min-width:18px;height:18px;border-radius:50%;background:rgba(59,130,246,.15);color:var(--accent);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px;}
.res-icon{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;margin:8px auto 18px;}
.res-icon.ok{background:rgba(16,185,129,.12);}
.res-icon.bad{background:rgba(239,68,68,.12);}
.res-t{font-size:20px;font-weight:700;margin-bottom:6px;}
.res-s{font-size:13px;color:var(--muted);line-height:1.6;margin-bottom:22px;}
.err-box{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:10px 14px;font-size:13px;color:#fca5a5;margin-bottom:14px;display:none;}
.tag-ok{color:var(--green);}.tag-bad{color:var(--red);}
.center{text-align:center;}
@media(max-width:460px){.card{padding:24px 18px;}}
</style>
</head><body>

<div class="nav-top">
  <a href="/" class="nav-logo"><div class="nav-logo-icon">🌐</div><div class="nav-logo" style="font-size:15px;font-weight:800">Net <span>Serviços</span></div></a>
  <a href="/" class="nav-back">← Início</a>
</div>

<div class="brand-wrap">
  <div class="brand-icon">💳</div>
  <div class="brand-name">Fazer <span>Depósito</span></div>
</div>

<div class="card">
  <div id="s-form">
    <p class="card-sub">Introduza o número de telemóvel e o valor. Receberá um pedido de PIN.</p>
    <div class="err-box" id="err"></div>
    <div class="field">
      <label class="lbl">Nome (opcional)</label>
      <div class="inp-w"><span class="ico">👤</span><input id="i-name" type="text" placeholder="O seu nome"></div>
    </div>
    <div class="field">
      <label class="lbl">Número de telemóvel</label>
      <div class="inp-w"><span class="ico">📱</span><input id="i-phone" type="tel" placeholder="84 000 0000" maxlength="15" inputmode="tel"></div>
      <div class="hint">84/85 → M-Pesa · 86/87 → e-Mola</div>
    </div>
    <div class="field">
      <label class="lbl">Valor a depositar</label>
      <div class="inp-w prefix-w"><span class="pfx">MZN</span><input id="i-amount" type="number" placeholder="0" min="1" step="1" inputmode="decimal"></div>
    </div>
    <button class="btn" id="btn-dep" onclick="submit()">Depositar</button>
  </div>

  <div id="s-pending">
    <div class="spinner"></div>
    <div class="center">
      <div class="big-amt" id="p-amt"></div>
      <div class="big-sub">MZN</div>
      <div id="p-method" class="mb"></div>
      <div style="font-size:18px;font-weight:700;margin-bottom:6px">Aguardando PIN</div>
      <div class="pend-ph" id="p-phone"></div>
      <p style="font-size:12px;color:var(--muted);margin-bottom:16px;line-height:1.6">Introduza o <strong style="color:var(--text)">PIN</strong> no pedido recebido.</p>
      <ul class="psteps">
        <li><span class="sn">1</span>Verifique o telemóvel — pedido <span id="step-m">M-Pesa</span> recebido</li>
        <li><span class="sn">2</span>Seleccione "Aceitar" e introduza o PIN</li>
        <li><span class="sn">3</span>Esta página actualiza automaticamente</li>
      </ul>
    </div>
  </div>

  <div id="s-success">
    <div class="center">
      <div class="res-icon ok">✓</div>
      <div class="big-amt tag-ok" id="ok-amt"></div>
      <div class="big-sub">MZN</div>
      <div class="res-t">Depósito confirmado!</div>
      <p class="res-s">O pagamento foi processado com sucesso.</p>
      <button class="btn" onclick="reset()">Novo depósito</button>
    </div>
  </div>

  <div id="s-failed">
    <div class="center">
      <div class="res-icon bad">✗</div>
      <div class="big-amt tag-bad" id="fail-amt"></div>
      <div class="big-sub">MZN</div>
      <div class="res-t">Não confirmado</div>
      <p class="res-s" id="fail-reason">O PIN não foi introduzido.</p>
      <button class="btn" onclick="reset()">Tentar novamente</button>
      <button class="btn btn-g" onclick="reset()">Cancelar</button>
    </div>
  </div>
</div>

<script>
let es=null
function show(id){['form','pending','success','failed'].forEach(s=>document.getElementById('s-'+s).style.display=(s===id?'block':'none'))}
function fmt(v){return Number(v).toLocaleString('pt-MZ',{minimumFractionDigits:2,maximumFractionDigits:2})}
async function submit(){
  const phone=document.getElementById('i-phone').value.trim()
  const amount=document.getElementById('i-amount').value.trim()
  const name=document.getElementById('i-name').value.trim()
  const ee=document.getElementById('err');ee.style.display='none'
  if(!phone)return setErr('Introduza o número de telemóvel.')
  if(!amount||Number(amount)<=0)return setErr('Introduza um valor válido.')
  const btn=document.getElementById('btn-dep');btn.disabled=true;btn.textContent='A processar…'
  try{
    const r=await fetch('/api/deposit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,amount:Number(amount),customer_name:name||undefined})})
    const d=await r.json()
    if(!r.ok){setErr(d.error||'Erro.');btn.disabled=false;btn.textContent='Depositar';return}
    const fa=fmt(amount)
    document.getElementById('p-amt').textContent=fa
    document.getElementById('ok-amt').textContent=fa
    document.getElementById('fail-amt').textContent=fa
    document.getElementById('p-phone').textContent=phone
    const me=document.getElementById('p-method'),sm=document.getElementById('step-m')
    if(d.method==='mpesa'){me.className='mb m';me.textContent='M-Pesa';sm.textContent='M-Pesa'}
    if(d.method==='emola'){me.className='mb e';me.textContent='e-Mola';sm.textContent='e-Mola'}
    show('pending');listen(d.txId)
  }catch{setErr('Erro de ligação. Tente novamente.');btn.disabled=false;btn.textContent='Depositar'}
}
function listen(txId){
  if(es)es.close()
  es=new EventSource('/events/'+txId)
  es.onmessage=e=>{const d=JSON.parse(e.data);if(d.status==='succeeded'){es.close();show('success')}if(d.status==='failed'){es.close();document.getElementById('fail-reason').textContent=d.error||'Tempo expirou.';show('failed')}}
  es.onerror=()=>{es.close();setTimeout(()=>listen(txId),3000)}
}
function setErr(m){const e=document.getElementById('err');e.textContent=m;e.style.display='block'}
function reset(){if(es){es.close();es=null};document.getElementById('i-phone').value='';document.getElementById('i-amount').value='';document.getElementById('i-name').value='';document.getElementById('err').style.display='none';const b=document.getElementById('btn-dep');b.disabled=false;b.textContent='Depositar';show('form')}
show('form')
</script>
</body></html>`
}

// ── PÁGINA: Admin Login ───────────────────────────────────────────────────────
function adminLoginPage(err = '') { return `<!DOCTYPE html>
<html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Net Serviços</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#07080f;color:#e8eaf6;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px;}
.card{background:#111422;border:1px solid #1a1e35;border-radius:18px;padding:40px 32px;width:100%;max-width:380px;}
.icon{width:56px;height:56px;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:14px;display:flex;align-items:center;justify-content:center;font-size:26px;margin:0 auto 20px;}
h1{font-size:20px;font-weight:800;text-align:center;margin-bottom:4px;}
.sub{font-size:13px;color:#4a5080;text-align:center;margin-bottom:28px;}
.err{background:rgba(239,68,68,.08);border:1px solid rgba(239,68,68,.2);border-radius:10px;padding:10px 14px;font-size:13px;color:#fca5a5;margin-bottom:16px;text-align:center;}
label{display:block;font-size:11px;font-weight:700;color:#4a5080;text-transform:uppercase;letter-spacing:.7px;margin-bottom:7px;}
input{width:100%;background:#0d0f1a;border:1.5px solid #1a1e35;border-radius:12px;padding:12px 14px;color:#e8eaf6;font-size:15px;font-family:inherit;outline:none;margin-bottom:16px;}
input:focus{border-color:#f59e0b;}
button{width:100%;padding:13px;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,#f59e0b,#d97706);color:#000;}
button:hover{opacity:.9;}
</style></head><body>
<div class="card">
  <div class="icon">🔒</div>
  <h1>Painel Admin</h1>
  <p class="sub">Net Serviços · Área restrita</p>
  ${err ? `<div class="err">${err}</div>` : ''}
  <form method="POST" action="/admin/office">
    <label>Senha de acesso</label>
    <input type="password" name="password" placeholder="••••••••••" autofocus>
    <button type="submit">Entrar</button>
  </form>
</div>
<script>
document.querySelector('form').addEventListener('submit',async function(e){
  e.preventDefault()
  const pwd=this.password.value
  const r=await fetch('/admin/office',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pwd})})
  if(r.redirected){window.location.href=r.url}else if(r.ok){window.location.href='/admin/office'}else{const d=await r.json().catch(()=>({}));alert(d.error||'Senha incorrecta.')}
})
</script>
</body></html>`
}

// ── PÁGINA: Admin Dashboard ───────────────────────────────────────────────────
function adminDashboard(filter = 'all') {
  const today   = new Date().toISOString().slice(0,10)
  const todayOrders = orders.filter(o => o.ts.startsWith(today))
  const pending  = orders.filter(o => o.status === 'pending' || o.status === 'succeeded').length
  const revenue  = todayOrders.filter(o => o.status==='succeeded'||o.status==='activated').reduce((s,o)=>s+o.amount,0)
  const total    = todayOrders.length
  const filtered = filter === 'all' ? orders
                 : filter === 'pending' ? orders.filter(o=>o.status==='pending'||o.status==='succeeded')
                 : orders.filter(o=>o.status===filter)

  const rows = filtered.slice(0, 200).map(o => {
    const dt   = new Date(o.ts)
    const time = dt.toLocaleTimeString('pt-MZ',{hour:'2-digit',minute:'2-digit'})
    const date = dt.toLocaleDateString('pt-MZ',{day:'2-digit',month:'2-digit'})
    const status = o.status === 'pending'  ? '<span class="badge pend">⏳ Pendente</span>'
                 : o.status === 'succeeded'? '<span class="badge succ">✓ Pago</span>'
                 : o.status === 'activated'? '<span class="badge actv">✓ Activado</span>'
                 : '<span class="badge fail">✗ Falhou</span>'
    const typeLabel = o.type === 'bundle' ? `🌐 ${o.bundleLabel||'-'}` : '💳 Depósito'
    const action = (o.status === 'succeeded' && o.type === 'bundle')
      ? `<button class="act-btn" onclick="activate('${o.txId}', this)">Activar</button>`
      : ''
    return `<tr>
      <td>${date} ${time}</td>
      <td>${o.phone}</td>
      <td>${typeLabel}</td>
      <td style="font-weight:700">${o.amount} MT</td>
      <td>${o.method==='mpesa'?'M-Pesa':'e-Mola'}</td>
      <td>${status}</td>
      <td>${action}</td>
    </tr>`
  }).join('')

  return `<!DOCTYPE html>
<html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Net Serviços</title>
<style>
*{box-sizing:border-box;margin:0;padding:0;}
body{background:#07080f;color:#e8eaf6;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;}
.topbar{display:flex;align-items:center;justify-content:space-between;padding:14px 24px;border-bottom:1px solid #1a1e35;background:#0d0f1a;}
.topbar-left{display:flex;align-items:center;gap:10px;}
.tb-icon{width:34px;height:34px;background:linear-gradient(135deg,#f59e0b,#d97706);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:16px;}
.tb-title{font-size:16px;font-weight:800;}
.tb-sub{font-size:11px;color:#4a5080;}
.tb-right{display:flex;align-items:center;gap:10px;}
.logout{font-size:12px;color:#4a5080;text-decoration:none;padding:6px 12px;border:1px solid #1a1e35;border-radius:8px;}
.logout:hover{color:#e8eaf6;border-color:#f59e0b;}
.main{padding:24px;max-width:1100px;margin:0 auto;}
.stats{display:grid;grid-template-columns:repeat(3,1fr);gap:14px;margin-bottom:24px;}
@media(max-width:600px){.stats{grid-template-columns:1fr;}}
.stat{background:#111422;border:1px solid #1a1e35;border-radius:14px;padding:20px;}
.stat-n{font-size:28px;font-weight:900;margin-bottom:4px;}
.stat-l{font-size:12px;color:#4a5080;}
.stat-n.amber{color:#f59e0b;}.stat-n.green{color:#10b981;}.stat-n.blue{color:#3b82f6;}
.filters{display:flex;gap:8px;margin-bottom:16px;flex-wrap:wrap;}
.filter-btn{padding:7px 14px;border-radius:8px;border:1.5px solid #1a1e35;background:transparent;color:#4a5080;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;}
.filter-btn.active,.filter-btn:hover{border-color:#f59e0b;color:#f59e0b;background:rgba(245,158,11,.07);}
.refresh-btn{margin-left:auto;padding:7px 14px;border-radius:8px;border:1.5px solid #1a1e35;background:transparent;color:#4a5080;font-size:12px;font-weight:600;font-family:inherit;cursor:pointer;}
.refresh-btn:hover{color:#e8eaf6;border-color:#3b82f6;}
.table-wrap{background:#111422;border:1px solid #1a1e35;border-radius:14px;overflow:hidden;}
table{width:100%;border-collapse:collapse;}
thead th{padding:12px 14px;text-align:left;font-size:11px;font-weight:700;color:#4a5080;text-transform:uppercase;letter-spacing:.5px;border-bottom:1px solid #1a1e35;white-space:nowrap;}
tbody tr{border-bottom:1px solid #1a1e35;transition:background .1s;}
tbody tr:hover{background:rgba(255,255,255,.02);}
tbody tr:last-child{border-bottom:none;}
td{padding:12px 14px;font-size:13px;white-space:nowrap;}
.badge{display:inline-block;padding:3px 9px;border-radius:6px;font-size:11px;font-weight:700;}
.badge.pend{background:rgba(245,158,11,.1);color:#f59e0b;border:1px solid rgba(245,158,11,.2);}
.badge.succ{background:rgba(16,185,129,.1);color:#10b981;border:1px solid rgba(16,185,129,.2);}
.badge.actv{background:rgba(16,185,129,.15);color:#10b981;border:1px solid rgba(16,185,129,.3);}
.badge.fail{background:rgba(239,68,68,.1);color:#ef4444;border:1px solid rgba(239,68,68,.2);}
.act-btn{padding:5px 12px;border-radius:7px;border:1px solid rgba(16,185,129,.3);background:rgba(16,185,129,.1);color:#10b981;font-size:12px;font-weight:700;font-family:inherit;cursor:pointer;}
.act-btn:hover{background:rgba(16,185,129,.2);}
.empty{padding:48px;text-align:center;color:#4a5080;font-size:14px;}
.section-title{font-size:14px;font-weight:700;margin-bottom:12px;color:#e8eaf6;}
</style></head><body>

<div class="topbar">
  <div class="topbar-left">
    <div class="tb-icon">🔧</div>
    <div><div class="tb-title">Painel Admin</div><div class="tb-sub">Net Serviços</div></div>
  </div>
  <div class="tb-right">
    <a href="/" target="_blank" class="logout">🌐 Site</a>
    <a href="/admin/logout" class="logout">Sair →</a>
  </div>
</div>

<div class="main">
  <div class="stats">
    <div class="stat"><div class="stat-n amber">${pending}</div><div class="stat-l">Pendentes / Por activar</div></div>
    <div class="stat"><div class="stat-n green">${revenue} MT</div><div class="stat-l">Receita hoje</div></div>
    <div class="stat"><div class="stat-n blue">${total}</div><div class="stat-l">Encomendas hoje</div></div>
  </div>

  <div class="section-title">Encomendas</div>
  <div class="filters">
    <button class="filter-btn${filter==='all'?' active':''}"     onclick="setFilter('all')">Todas</button>
    <button class="filter-btn${filter==='pending'?' active':''}" onclick="setFilter('pending')">Pendentes</button>
    <button class="filter-btn${filter==='activated'?' active':''}" onclick="setFilter('activated')">Activadas</button>
    <button class="filter-btn${filter==='failed'?' active':''}"  onclick="setFilter('failed')">Falhadas</button>
    <button class="refresh-btn" onclick="location.reload()">↻ Actualizar</button>
  </div>

  <div class="table-wrap">
    <table>
      <thead><tr>
        <th>Data/Hora</th><th>Telemóvel</th><th>Pacote</th><th>Valor</th><th>Método</th><th>Estado</th><th>Acção</th>
      </tr></thead>
      <tbody>
        ${rows || '<tr><td colspan="7" class="empty">Nenhuma encomenda encontrada.</td></tr>'}
      </tbody>
    </table>
  </div>
</div>

<script>
function setFilter(f){window.location.href='/admin/office?filter='+f}

async function activate(txId, btn){
  if(!confirm('Marcar como activado?')) return
  btn.disabled=true; btn.textContent='...'
  try{
    const r=await fetch('/admin/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({txId})})
    const d=await r.json()
    if(d.ok){btn.closest('tr').querySelector('.badge').outerHTML='<span class="badge actv">✓ Activado</span>';btn.remove()}
    else{alert(d.error||'Erro.');btn.disabled=false;btn.textContent='Activar'}
  }catch{alert('Erro de ligação.');btn.disabled=false;btn.textContent='Activar'}
}

// Auto-refresh a cada 60s
setTimeout(()=>location.reload(), 60000)
</script>
</body></html>`
}

// ── Servidor ──────────────────────────────────────────────────────────────────
await loadOrders()
createServer((req, res) => {
  router(req, res).catch(err => {
    console.error('[Server]', err)
    try { json(res, { error:'Erro interno.' }, 500) } catch {}
  })
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Net Serviços a correr em :${PORT}`)
  console.log(`Admin: /admin/office  |  senha: ${ADMIN_PASS}`)
})
