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
  if (method === 'GET' && path === '/')         { res.writeHead(302,{'Location':'/megas'}); return res.end() }
  if (method === 'GET' && (path === '/static/vodacom.webp' || path === '/favicon.ico')) {
    try { const img = await import('fs/promises').then(f=>f.readFile('./attached_assets/image_1786121779688.webp')); res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'max-age=86400'}); return res.end(img) } catch { res.writeHead(404); return res.end() }
  }
  if (method === 'GET' && path === '/static/voda-anim.gif') {
    try { const gif = await import('fs/promises').then(f=>f.readFile('./attached_assets/VF_Living_Speechmark_Tech_Circle_always_on_1786166674756.gif')); res.writeHead(200,{'Content-Type':'image/gif','Cache-Control':'max-age=86400'}); return res.end(gif) } catch { res.writeHead(404); return res.end() }
  }
  if (method === 'GET' && path === '/megas')    return html(res, megasPage())
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

  // Labels for list section headers
  const listLabels = {diarias:'Diário',semanais:'Semanal',mensais:'Mensal',infinitas:'Diamante'}

  // Helper to build one list card
  const pkgListItem = p =>
    `<div class="pkg-item" onclick="openBuy('${p.id}')">` +
    `<div class="pkg-item-top"><span class="pkg-item-name">${p.name}</span>` +
    `<span class="pkg-item-price">${p.price} MT<span class="pkg-item-arr"> ›</span></span></div>` +
    `<div class="pkg-item-sep"></div>` +
    `<div class="pkg-item-data">` +
    `<svg class="pkg-item-icon" viewBox="0 0 24 24"><path d="M7 16V4"/><path d="M4 7l3-3 3 3"/><path d="M17 8v12"/><path d="M14 17l3 3 3-3"/></svg>` +
    `<span class="pkg-item-size">${p.size}</span></div></div>`

  // Generate one carousel section (no list — list is rendered separately below)
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

  // Combined list of ALL categories — always visible below carousel
  const allListHtml = '<div class="pkg-list">' +
    CATS_ORDER.map(catId =>
      `<div class="pkg-list-head">${listLabels[catId]||''}</div>` +
      CAT_DATA[catId].pkgs.map(pkgListItem).join('')
    ).join('') + '</div>'

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
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Ccircle cx='16' cy='16' r='16' fill='%23cc0000'/%3E%3Ctext x='16' y='22' text-anchor='middle' font-family='Arial,sans-serif' font-weight='bold' font-size='20' fill='%23fff'%3EN%3C/text%3E%3C/svg%3E" type="image/svg+xml">
<script>(function(){document.addEventListener('contextmenu',e=>e.preventDefault());document.addEventListener('keydown',function(e){const c=e.ctrlKey||e.metaKey;if(e.key==='F12'){e.preventDefault();return false}if(c&&e.shiftKey&&['I','J','C','K'].includes(e.key.toUpperCase())){e.preventDefault();return false}if(c&&['u','U','s','S','a','A','c','C','x','X'].includes(e.key)){e.preventDefault();return false}},true);['copy','cut','selectstart','dragstart'].forEach(ev=>document.addEventListener(ev,e=>e.preventDefault(),true))})()
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{background:#f2f2f7;color:#1c1c1e;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden;user-select:none;-webkit-user-select:none;}

/* ── Nav ── */
.nav{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#fff;border-bottom:1px solid #e5e5ea;position:sticky;top:0;z-index:50;}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:#1c1c1e;}
.nav-logo-img{width:36px;height:36px;object-fit:contain;background:#000;border-radius:8px;padding:3px;}
.nav-logo-text{font-size:15px;font-weight:800;}
.nav-logo-text span{color:#cc0000;}
.nav-right{display:flex;align-items:center;gap:4px;}
.nav-icon-btn{background:none;border:none;cursor:pointer;padding:8px;color:#1c1c1e;display:flex;align-items:center;justify-content:center;border-radius:8px;}
.nav-icon-btn:active{background:#f2f2f7;}
.nav-icon-btn svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}

/* ── Search overlay ── */
.search-overlay{position:fixed;inset:0;background:rgba(0,0,0,.45);z-index:200;display:none;backdrop-filter:blur(3px);}
.search-overlay.open{display:flex;flex-direction:column;}
.search-bar{background:#fff;padding:12px 16px;display:flex;align-items:center;gap:10px;}
.search-inp{flex:1;border:none;outline:none;font-size:16px;font-family:inherit;background:transparent;color:#1c1c1e;}
.search-inp::placeholder{color:#8e8e93;}
.search-close{background:none;border:none;cursor:pointer;font-size:22px;color:#8e8e93;padding:4px 8px;}

/* ── Side drawer (menu) ── */
.drawer-overlay{position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:300;display:none;}
.drawer-overlay.open{display:block;}
.drawer{position:fixed;top:0;right:0;bottom:0;width:75%;max-width:280px;background:#fff;z-index:301;transform:translateX(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);padding:0;overflow-y:auto;}
.drawer.open{transform:translateX(0);}
.drawer-head{padding:20px 20px 16px;border-bottom:1px solid #e5e5ea;display:flex;align-items:center;gap:12px;}
.drawer-logo{width:40px;height:40px;object-fit:contain;}
.drawer-brand{font-size:16px;font-weight:800;color:#1c1c1e;}
.drawer-brand span{color:#cc0000;}
.drawer-menu{list-style:none;padding:8px 0;}
.drawer-menu li a{display:flex;align-items:center;gap:14px;padding:14px 20px;font-size:15px;color:#1c1c1e;text-decoration:none;font-weight:500;}
.drawer-menu li a:active{background:#f2f2f7;}
.drawer-menu li a .dm-icon{font-size:18px;width:24px;text-align:center;}
.drawer-divider{height:1px;background:#e5e5ea;margin:4px 0;}

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

/* ── Package list (below carousel) ── */
.pkg-list{padding:8px 16px 24px;}
.pkg-list-head{font-size:13px;color:#636366;font-weight:600;margin:16px 0 10px 4px;}
.pkg-item{background:#fff;border-radius:14px;margin-bottom:10px;overflow:hidden;box-shadow:0 1px 6px rgba(0,0,0,.08);cursor:pointer;}
.pkg-item:active{opacity:.85;}
.pkg-item-top{display:flex;align-items:center;justify-content:space-between;padding:16px 16px 12px;}
.pkg-item-name{font-size:16px;font-weight:600;color:#1c1c1e;}
.pkg-item-price{font-size:16px;font-weight:700;color:#1c1c1e;display:flex;align-items:center;gap:8px;}
.pkg-item-arr{color:#cc0000;font-size:20px;font-weight:300;line-height:1;}
.pkg-item-sep{height:1px;background:#f2f2f7;margin:0 16px;}
.pkg-item-data{display:flex;flex-direction:column;align-items:center;padding:14px 16px 16px;gap:5px;}
.pkg-item-icon{width:26px;height:26px;stroke:#cc0000;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
.pkg-item-size{font-size:13px;color:#636366;}

/* ── Footer (dark) ── */
.site-footer{background:#1c1c1e;border-top:none;padding:32px 20px 0;}
.footer-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px;}
.footer-brand{display:flex;align-items:center;gap:10px;}
.footer-logo-img{width:34px;height:34px;object-fit:contain;background:#000;border-radius:8px;padding:3px;}
.footer-brand-name{font-size:16px;font-weight:800;color:#f2f2f7;}
.footer-brand-name span{color:#cc0000;}
.footer-links{display:flex;flex-direction:column;gap:12px;text-align:right;}
.footer-links a{font-size:13px;color:#8e8e93;text-decoration:none;font-weight:500;}
.footer-links a:active{color:#cc0000;}
.footer-bottom{border-top:1px solid #3a3a3c;padding:20px 0 40px;text-align:center;}
.footer-portal{font-size:13px;font-weight:600;color:#8e8e93;margin-bottom:16px;}
.footer-social{display:flex;justify-content:center;gap:14px;margin-bottom:18px;}
.footer-social a{width:40px;height:40px;border-radius:50%;background:#2c2c2e;display:flex;align-items:center;justify-content:center;color:#8e8e93;text-decoration:none;transition:background .15s,color .15s;flex-shrink:0;}
.footer-social a:active{background:#cc0000;color:#fff;}
.footer-social svg{width:18px;height:18px;fill:currentColor;flex-shrink:0;}
.footer-contact{display:flex;flex-direction:column;gap:10px;margin-bottom:18px;}
.footer-contact-link{display:flex;align-items:center;gap:10px;color:#8e8e93;text-decoration:none;font-size:13px;font-weight:500;}
.footer-contact-link svg{width:18px;height:18px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;}
.footer-contact-wa{color:#25d366;}
.footer-copy{font-size:12px;color:#48484a;line-height:1.7;}

/* ── Note banner ── */
.cat-note{margin:0 20px 16px;padding:10px 14px;background:#fff3cd;border:1px solid #ffc107;border-radius:10px;font-size:12px;color:#856404;line-height:1.5;display:none;}
.cat-note.show{display:block;}

/* ── Bottom sheet (Vodacom style) ── */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;display:none;backdrop-filter:blur(4px);}
.overlay.open{display:block;}
.sheet{position:fixed;bottom:0;left:0;right:0;max-width:480px;margin:0 auto;background:#fff;border-radius:22px 22px 0 0;z-index:101;padding:0;transform:translateY(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);max-height:92vh;overflow-y:auto;}
.sheet.open{transform:translateY(0);}
/* close row */
.sh-top{display:flex;justify-content:flex-end;padding:14px 14px 0;}
.sh-close{background:none;border:none;font-size:20px;color:#636366;cursor:pointer;width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:50%;line-height:1;}
.sh-close:active{background:#f2f2f7;}
/* package info card */
.sh-pkg-card{margin:4px 16px 16px;padding:16px;background:#f5f5f7;border-radius:14px;}
.sh-pkg-row{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.sh-pkg-name{font-size:17px;font-weight:700;color:#1c1c1e;}
.sh-pkg-prc{font-size:17px;font-weight:700;color:#1c1c1e;}
.sh-pkg-icons{display:grid;grid-template-columns:repeat(4,1fr);text-align:center;gap:0;}
.sh-pkg-ico{display:flex;flex-direction:column;align-items:center;gap:5px;}
.sh-pkg-ico svg{width:30px;height:30px;stroke:#cc0000;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
.sh-pkg-ico span{font-size:11px;color:#636366;font-weight:500;}
/* tabs */
.sh-tabs{display:flex;border-bottom:1.5px solid #e5e5ea;}
.sh-tab{flex:1;background:none;border:none;border-bottom:2.5px solid transparent;margin-bottom:-1.5px;font-size:12px;font-weight:600;font-family:inherit;color:#8e8e93;cursor:pointer;padding:12px 4px;text-align:center;line-height:1.35;transition:color .15s;}
.sh-tab.active{color:#cc0000;border-bottom-color:#cc0000;}
/* panels */
.sh-panel{padding:18px 16px 0;}
.sh-lbl{display:block;font-size:15px;font-weight:600;color:#1c1c1e;margin-bottom:8px;}
.sh-inp{width:100%;border:1.5px solid #c7c7cc;border-radius:12px;padding:15px 14px;font-size:16px;font-family:inherit;color:#1c1c1e;background:#fff;outline:none;margin-bottom:16px;transition:border-color .15s;}
.sh-inp:focus{border-color:#cc0000;}
.sh-inp::placeholder{color:#c7c7cc;}
/* via buttons */
.sh-via-lbl{font-size:15px;font-weight:600;color:#1c1c1e;margin-bottom:10px;}
.sh-via-btns{display:flex;gap:12px;margin-bottom:4px;}
.sh-via{flex:1;padding:14px 8px;border:1.5px solid #e5e5ea;border-radius:12px;background:#fff;font-size:14px;font-weight:600;font-family:inherit;color:#8e8e93;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:8px;transition:border-color .15s,color .15s,background .15s;}
.sh-via svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;flex-shrink:0;}
.sh-via.active{border-color:#cc0000;color:#cc0000;background:#fff8f8;}
/* error */
.sh-err{background:#fff0f0;border:1px solid #ffcdd2;border-radius:10px;padding:10px 14px;font-size:13px;color:#cc0000;margin:12px 16px 0;display:none;}
/* próximo button */
.sh-next{width:calc(100% - 32px);margin:16px 16px 36px;padding:17px;border:none;border-radius:14px;font-size:16px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,#e53935,#cc0000);color:#fff;transition:opacity .2s;}
.sh-next:disabled{opacity:.45;cursor:not-allowed;}
.sh-next:active{opacity:.85;}
.sh-hint{display:block;font-size:12px;color:#8e8e93;margin-top:-10px;margin-bottom:14px;padding:0 2px;}
/* states: pending / success / failed */
.sh-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px 20px 44px;text-align:center;}
.sheet.pending-full{top:0!important;border-radius:0!important;max-height:100vh!important;}
#s-pending{height:100%;display:flex;flex-direction:column;}
#s-pending .sh-state{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:80vh;}
.voda-gif{width:220px;height:220px;object-fit:contain;display:block;}
.voda-pin-msg{font-size:18px;font-weight:400;color:#1c1c1e;line-height:1.55;max-width:280px;margin-top:4px;}
.res-icon{width:68px;height:68px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;margin:4px auto 18px;}
.res-icon.ok{background:#e8f5e9;color:#2e7d32;}
.res-icon.bad{background:#ffebee;color:#c62828;}
.res-t{font-size:20px;font-weight:700;text-align:center;margin-bottom:6px;color:#1c1c1e;}
.res-s{font-size:13px;color:#636366;text-align:center;line-height:1.6;margin-bottom:20px;}
.res-box{background:#fff0f0;border:1px solid #ffcdd2;border-radius:12px;padding:14px;text-align:center;margin-bottom:20px;}
.res-box-l{font-size:11px;color:#8e8e93;margin-bottom:4px;}
.res-box-v{font-size:15px;font-weight:700;color:#cc0000;}
.res-btn{width:100%;padding:15px;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;background:#cc0000;color:#fff;margin-bottom:10px;transition:opacity .2s;}
.res-btn:active{opacity:.85;}
.res-btn-g{background:#f2f2f7;color:#636366;}
</style>
</head><body>

<nav class="nav">
  <a href="/" class="nav-logo">
    <img src="/static/vodacom.webp" alt="Net Serviços" class="nav-logo-img">
    <div class="nav-logo-text">Net <span>Serviços</span></div>
  </a>
  <div class="nav-right">
    <button class="nav-icon-btn" onclick="openSearch()" aria-label="Pesquisar">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    </button>
    <button class="nav-icon-btn" onclick="openDrawer()" aria-label="Menu">
      <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
</nav>

<!-- Search overlay -->
<div class="search-overlay" id="search-overlay" onclick="closeSearch(event)">
  <div class="search-bar" onclick="event.stopPropagation()">
    <svg style="width:20px;height:20px;stroke:#8e8e93;fill:none;stroke-width:2;stroke-linecap:round;flex-shrink:0" viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    <input class="search-inp" id="search-inp" type="search" placeholder="Pesquisar pacote…" oninput="searchPkgs(this.value)">
    <button class="search-close" onclick="closeSearch()">✕</button>
  </div>
  <div id="search-results" style="background:#fff;overflow-y:auto;flex:1"></div>
</div>

<!-- Side drawer -->
<div class="drawer-overlay" id="drawer-overlay" onclick="closeDrawer()"></div>
<div class="drawer" id="drawer">
  <div class="drawer-head">
    <img src="/static/vodacom.webp" alt="logo" class="drawer-logo">
    <div class="drawer-brand">Net <span>Serviços</span></div>
  </div>
  <ul class="drawer-menu">
    <li><a href="/"><span class="dm-icon">🏠</span>Início</a></li>
    <li><a href="/megas"><span class="dm-icon">📶</span>Pacotes de Internet</a></li>
    <div class="drawer-divider"></div>
    <li><a href="#" onclick="closeDrawer()"><span class="dm-icon">✕</span>Fechar menu</a></li>
  </ul>
</div>

<div class="offer-header">
  <h2 class="offer-title">Ofertas de Internet</h2>
  <p class="offer-desc">São ofertas diferenciadas e ricas em <strong>DADOS</strong> que te permitem aceder a todas as plataformas e conteúdos de internet para navegares à vontade.</p>
</div>

<div class="tabs-wrap">
  <div class="tabs" id="tab-bar">
    <button class="tab active" onclick="setCat('diarias')">Diárias</button>
    <button class="tab" onclick="setCat('semanais')">Semanais</button>
    <button class="tab" onclick="setCat('mensais')">Mensais</button>
    <button class="tab" onclick="setCat('infinitas')">Diamante</button>
  </div>
</div>

<div class="carousel-area">${allSections}</div>
${allListHtml}

<footer class="site-footer">
  <div class="footer-top">
    <div class="footer-brand">
      <img src="/static/vodacom.webp" alt="Net Serviços" class="footer-logo-img">
      <div class="footer-brand-name">Net <span>Serviços</span></div>
    </div>
    <div class="footer-links">
      <a href="/megas">Pacotes de Internet</a>
    </div>
  </div>
  <div class="footer-bottom">
    <p class="footer-portal">Portal do Fornecedor</p>
    <div class="footer-social">
      <a href="#" aria-label="Facebook">
        <svg viewBox="0 0 24 24"><path d="M18 2h-3a5 5 0 00-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 011-1h3z"/></svg>
      </a>
      <a href="#" aria-label="Instagram">
        <svg viewBox="0 0 24 24"><rect x="2" y="2" width="20" height="20" rx="5" ry="5"/><path d="M16 11.37A4 4 0 1112.63 8 4 4 0 0116 11.37z" fill="none" stroke="currentColor" stroke-width="1.8"/><line x1="17.5" y1="6.5" x2="17.51" y2="6.5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </a>
      <a href="#" aria-label="YouTube">
        <svg viewBox="0 0 24 24"><path d="M22.54 6.42a2.78 2.78 0 00-1.95-1.97C18.88 4 12 4 12 4s-6.88 0-8.59.45A2.78 2.78 0 001.46 6.42 29 29 0 001 12a29 29 0 00.46 5.58 2.78 2.78 0 001.95 1.97C5.12 20 12 20 12 20s6.88 0 8.59-.45a2.78 2.78 0 001.95-1.97A29 29 0 0023 12a29 29 0 00-.46-5.58z"/><polygon points="9.75 15.02 15.5 12 9.75 8.98 9.75 15.02" fill="#1c1c1e"/></svg>
      </a>
      <a href="#" aria-label="X / Twitter">
        <svg viewBox="0 0 24 24"><path d="M4 4l16 16M4 20L20 4" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </a>
      <a href="#" aria-label="LinkedIn">
        <svg viewBox="0 0 24 24"><path d="M16 8a6 6 0 016 6v7h-4v-7a2 2 0 00-2-2 2 2 0 00-2 2v7h-4v-7a6 6 0 016-6zM2 9h4v12H2z"/><circle cx="4" cy="4" r="2"/></svg>
      </a>
    </div>
    <div class="footer-contact">
      <a href="tel:876563910" class="footer-contact-link">
        <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.09 9.8a19.79 19.79 0 01-3.07-8.67A2 2 0 012 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
        <span>876 563 910 — Suporte</span>
      </a>
      <a href="https://wa.me/258876563910" target="_blank" rel="noopener" class="footer-contact-link footer-contact-wa">
        <svg viewBox="0 0 24 24"><path d="M21 11.5a8.38 8.38 0 01-.9 3.8 8.5 8.5 0 01-7.6 4.7 8.38 8.38 0 01-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 01-.9-3.8 8.5 8.5 0 014.7-7.6 8.38 8.38 0 013.8-.9h.5a8.48 8.48 0 018 8v.5z"/></svg>
        <span>876 563 910 — WhatsApp</span>
      </a>
    </div>
    <p class="footer-copy">© 2025 Net Serviços · Todos os direitos reservados</p>
  </div>
</footer>

<div class="overlay" id="overlay" onclick="closeSheet()"></div>
<div class="sheet" id="sheet">

  <!-- ── Compra ── -->
  <div id="s-buy" style="display:none">
    <div class="sh-top"><button class="sh-close" onclick="closeSheet()">✕</button></div>

    <!-- Cartão do pacote -->
    <div class="sh-pkg-card">
      <div class="sh-pkg-row">
        <span class="sh-pkg-name" id="sh-size"></span>
        <span class="sh-pkg-prc"><span id="sh-price"></span> MT</span>
      </div>
      <div class="sh-pkg-icons" id="sh-icons">
        <div class="sh-pkg-ico"><svg viewBox="0 0 24 24"><path d="M7 16V4"/><path d="M4 7l3-3 3 3"/><path d="M17 8v12"/><path d="M14 17l3 3 3-3"/></svg><span id="ico-data">—</span></div>
        <div class="sh-pkg-ico"><svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.09 9.8a19.79 19.79 0 01-3.07-8.67A2 2 0 012 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg><span id="ico-calls">0 MT</span></div>
        <div class="sh-pkg-ico"><svg viewBox="0 0 24 24"><path d="M21 15a2 2 0 01-2 2H7l-4 4V5a2 2 0 012-2h14a2 2 0 012 2z"/></svg><span id="ico-sms">0 SMS</span></div>
        <div class="sh-pkg-ico"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span id="ico-dur">—</span></div>
      </div>
    </div>

    <!-- Tabs -->
    <div class="sh-tabs">
      <button class="sh-tab active" onclick="shSetTab('mim')">Comprar<br>Para Mim</button>
      <button class="sh-tab" onclick="shSetTab('outro')">Comprar<br>Para Outro</button>
      <button class="sh-tab" onclick="shSetTab('req')">Requisitar<br>Oferta</button>
    </div>

    <!-- Tab: Para Mim -->
    <div class="sh-panel" id="sh-tab-mim">
      <label class="sh-lbl">Introduza o seu número</label>
      <input class="sh-inp" id="sh-phone" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric" autocomplete="off" oninput="detectVia(this.value,'via')">
      <span class="sh-hint">M-Pesa: 84 ou 85 · e-Mola: 86 ou 87</span>
      <div class="sh-via-lbl">Activar a oferta via</div>
      <div class="sh-via-btns">
        <button class="sh-via active" id="via-mpesa" onclick="selectVia('mpesa')">
          <svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01"/></svg>M-Pesa
        </button>
        <button class="sh-via" id="via-emola" onclick="selectVia('emola')">
          <svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 12h.01"/></svg>e-Mola
        </button>
      </div>
    </div>

    <!-- Tab: Para Outro -->
    <div class="sh-panel" id="sh-tab-outro" style="display:none">
      <label class="sh-lbl">Introduza o seu número</label>
      <input class="sh-inp" id="sh-phone-payer" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric" autocomplete="off" oninput="detectVia(this.value,'via2')">
      <span class="sh-hint">M-Pesa: 84 ou 85 · e-Mola: 86 ou 87</span>
      <label class="sh-lbl">Introduza o número do beneficiário</label>
      <input class="sh-inp" id="sh-phone-bene" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric" autocomplete="off">
      <span class="sh-hint">M-Pesa: 84 ou 85 · e-Mola: 86 ou 87</span>
      <div class="sh-via-lbl">Activar a oferta via</div>
      <div class="sh-via-btns">
        <button class="sh-via active" id="via2-mpesa" onclick="selectVia2('mpesa')">
          <svg viewBox="0 0 24 24"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18.01"/></svg>M-Pesa
        </button>
        <button class="sh-via" id="via2-emola" onclick="selectVia2('emola')">
          <svg viewBox="0 0 24 24"><rect x="2" y="6" width="20" height="14" rx="2"/><path d="M16 12h.01"/></svg>e-Mola
        </button>
      </div>
    </div>

    <!-- Tab: Requisitar -->
    <div class="sh-panel" id="sh-tab-req" style="display:none">
      <div style="text-align:center;padding:28px 0 12px">
        <div style="font-size:40px;margin-bottom:14px">🔔</div>
        <p style="font-size:14px;color:#636366;line-height:1.6">A funcionalidade <strong style="color:#1c1c1e">Requisitar Oferta</strong> não está disponível neste momento.</p>
      </div>
    </div>

    <div class="sh-err" id="sh-err"></div>
    <button class="sh-next" id="sh-btn" onclick="pay()">Próximo</button>
  </div>

  <!-- ── A aguardar PIN ── -->
  <div id="s-pending" style="display:none">
    <div class="sh-top"><button class="sh-close" onclick="closeSheet()">✕</button></div>
    <div class="sh-state">
      <img src="/static/voda-anim.gif" class="voda-gif" alt="Aguardando">
      <p class="voda-pin-msg">Confirme a ativação da oferta introduzindo o PIN <span id="sh-method-lbl">M-Pesa</span> no seu telemóvel</p>
    </div>
  </div>

  <!-- ── Sucesso ── -->
  <div id="s-success" style="display:none">
    <div class="sh-top"><button class="sh-close" onclick="closeSheet()">✕</button></div>
    <div class="sh-state">
      <div class="res-icon ok">✓</div>
      <div class="res-t">Pedido recebido!</div>
      <p class="res-s">Pagamento confirmado. O seu pacote será activado em <strong style="color:#cc0000">5–15 minutos</strong>.</p>
      <div class="res-box"><div class="res-box-l">Pacote encomendado</div><div class="res-box-v" id="sh-ok-pkg"></div></div>
      <button class="res-btn" onclick="closeSheet()">Comprar outro pacote</button>
    </div>
  </div>

  <!-- ── Falhou ── -->
  <div id="s-failed" style="display:none">
    <div class="sh-top"><button class="sh-close" onclick="closeSheet()">✕</button></div>
    <div class="sh-state">
      <div class="res-icon bad">✗</div>
      <div class="res-t">Pagamento não confirmado</div>
      <p class="res-s" id="sh-fail-msg">O PIN não foi introduzido ou o tempo expirou.</p>
      <button class="res-btn" onclick="shShow('buy')">Tentar novamente</button>
      <button class="res-btn res-btn-g" onclick="closeSheet()">Cancelar</button>
    </div>
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
let shCurTab = 'mim'

function shSetTab(t) {
  shCurTab = t
  ;['mim','outro','req'].forEach((x,i) => {
    document.getElementById('sh-tab-'+x).style.display = x===t ? 'block' : 'none'
    document.querySelectorAll('.sh-tab')[i].classList.toggle('active', x===t)
  })
  document.getElementById('sh-btn').style.display = t==='req' ? 'none' : 'block'
}

function detectVia(val, prefix) {
  const v = val.replace(/\D/g,'')
  if (v.startsWith('84')||v.startsWith('85')) {
    document.getElementById(prefix+'-mpesa').classList.add('active')
    document.getElementById(prefix+'-emola').classList.remove('active')
  } else if (v.startsWith('86')||v.startsWith('87')) {
    document.getElementById(prefix+'-mpesa').classList.remove('active')
    document.getElementById(prefix+'-emola').classList.add('active')
  }
}
function selectVia(m)  { document.getElementById('via-mpesa').classList.toggle('active',m==='mpesa'); document.getElementById('via-emola').classList.toggle('active',m==='emola') }
function selectVia2(m) { document.getElementById('via2-mpesa').classList.toggle('active',m==='mpesa'); document.getElementById('via2-emola').classList.toggle('active',m==='emola') }

function openBuy(id) {
  const all = Object.values(PKGS_ALL).flat()
  const p = all.find(x=>x.id===id); if(!p) return
  curPkg = p
  document.getElementById('sh-size').textContent = p.name
  document.getElementById('sh-price').textContent = p.price
  document.getElementById('ico-data').textContent = p.size
  document.getElementById('ico-dur').textContent  = p.dur
  document.getElementById('ico-calls').textContent = p.calls ? 'Ilim.' : '0 MT'
  document.getElementById('ico-sms').textContent   = p.calls ? '+ SMS' : '0 SMS'
  document.getElementById('sh-phone').value = ''
  document.getElementById('sh-err').style.display = 'none'
  const btn = document.getElementById('sh-btn'); btn.disabled=false; btn.textContent='Próximo'; btn.style.display='block'
  shSetTab('mim')
  selectVia('mpesa')
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
function shShow(s) {
  ['buy','pending','success','failed'].forEach(x=>document.getElementById('s-'+x).style.display=(x===s?'block':'none'))
  const sh=document.getElementById('sheet')
  if(s==='pending'){sh.classList.add('pending-full')}else{sh.classList.remove('pending-full')}
}

async function pay() {
  const raw = shCurTab==='outro'
    ? document.getElementById('sh-phone-payer').value.trim()
    : document.getElementById('sh-phone').value.trim()
  const phone = raw.replace(/\D/g,'')
  const ee = document.getElementById('sh-err'); ee.style.display='none'
  if (!phone) { ee.textContent='Introduza o número de telemóvel.'; ee.style.display='block'; return }
  if (phone.length !== 9) { ee.textContent='O número deve ter exactamente 9 dígitos.'; ee.style.display='block'; return }
  if (!/^(84|85|86|87)/.test(phone)) { ee.textContent='Número inválido. Use 84/85 (M-Pesa) ou 86/87 (e-Mola).'; ee.style.display='block'; return }
  const btn = document.getElementById('sh-btn'); btn.disabled=true; btn.textContent='A processar…'
  try {
    const r = await fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,bundleId:curPkg.id})})
    const d = await r.json()
    if (!r.ok) { ee.textContent=d.error||'Erro ao processar.'; ee.style.display='block'; btn.disabled=false; btn.textContent='Próximo'; return }
    document.getElementById('sh-method-lbl').textContent = d.method==='mpesa'?'M-Pesa':'e-Mola'
    document.getElementById('sh-ok-pkg').textContent = curPkg.name+' — '+curPkg.price+' MT'
    shShow('pending'); listenOrder(d.txId)
  } catch { ee.textContent='Erro de ligação. Tente novamente.'; ee.style.display='block'; btn.disabled=false; btn.textContent='Próximo' }
}
function listenOrder(txId) {
  if (evtSrc) evtSrc.close()
  evtSrc = new EventSource('/events/'+txId)
  evtSrc.onmessage = e => { const d=JSON.parse(e.data); if(d.status==='succeeded'){evtSrc.close();shShow('success')} if(d.status==='failed'){evtSrc.close();document.getElementById('sh-fail-msg').textContent=d.error||'Tempo expirou.';shShow('failed')} }
  evtSrc.onerror = () => { evtSrc.close(); setTimeout(()=>listenOrder(txId),3000) }
}

// ── Search ──
function openSearch() {
  document.getElementById('search-overlay').classList.add('open')
  setTimeout(()=>document.getElementById('search-inp').focus(),100)
}
function closeSearch(e) {
  if (e && e.target !== document.getElementById('search-overlay')) return
  document.getElementById('search-overlay').classList.remove('open')
  document.getElementById('search-inp').value = ''
  document.getElementById('search-results').innerHTML = ''
}
function searchPkgs(q) {
  const res = document.getElementById('search-results')
  if (!q.trim()) { res.innerHTML = ''; return }
  const all = Object.values(PKGS_ALL).flat()
  const found = all.filter(p => p.name.toLowerCase().includes(q.toLowerCase()) || String(p.price).includes(q) || p.size.toLowerCase().includes(q.toLowerCase()))
  if (!found.length) { res.innerHTML = '<p style="padding:20px 16px;color:#8e8e93;font-size:14px">Nenhum pacote encontrado.</p>'; return }
  res.innerHTML = found.map(p =>
    '<div data-id="'+p.id+'" onclick="closeSearch();openBuy(this.dataset.id)" style="display:flex;align-items:center;justify-content:space-between;padding:14px 16px;border-bottom:1px solid #e5e5ea;cursor:pointer">' +
    '<div><div style="font-size:15px;font-weight:600;color:#1c1c1e">'+p.name+'</div>' +
    '<div style="font-size:12px;color:#8e8e93;margin-top:2px">'+p.size+' · '+p.dur+'</div></div>' +
    '<div style="font-size:16px;font-weight:700;color:#cc0000">'+p.price+' MT</div></div>'
  ).join('')
}

// ── Drawer ──
function openDrawer()  { document.getElementById('drawer').classList.add('open'); document.getElementById('drawer-overlay').classList.add('open') }
function closeDrawer() { document.getElementById('drawer').classList.remove('open'); document.getElementById('drawer-overlay').classList.remove('open') }

// Init: diarias já visível por defeito (HTML pré-renderizado)
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
