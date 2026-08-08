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
  if (method === 'GET' && path === '/static/vodacom.webp') {
    try { const img = await import('fs/promises').then(f=>f.readFile('./attached_assets/image_1786121779688.webp')); res.writeHead(200,{'Content-Type':'image/webp','Cache-Control':'max-age=86400'}); return res.end(img) } catch { res.writeHead(404); return res.end() }
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
  const listLabels = {diarias:'Diário',semanais:'Semanal',mensais:'Mensal',infinitas:'Infinitas'}

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
<script>(function(){document.addEventListener('contextmenu',e=>e.preventDefault());document.addEventListener('keydown',function(e){const c=e.ctrlKey||e.metaKey;if(e.key==='F12'){e.preventDefault();return false}if(c&&e.shiftKey&&['I','J','C','K'].includes(e.key.toUpperCase())){e.preventDefault();return false}if(c&&['u','U','s','S','a','A','c','C','x','X'].includes(e.key)){e.preventDefault();return false}},true);['copy','cut','selectstart','dragstart'].forEach(ev=>document.addEventListener(ev,e=>e.preventDefault(),true))})()
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;-webkit-tap-highlight-color:transparent;}
body{background:#f2f2f7;color:#1c1c1e;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;overflow-x:hidden;user-select:none;-webkit-user-select:none;}

/* ── Nav ── */
.nav{display:flex;align-items:center;justify-content:space-between;padding:10px 16px;background:#fff;border-bottom:1px solid #e5e5ea;position:sticky;top:0;z-index:50;}
.nav-logo{display:flex;align-items:center;gap:10px;text-decoration:none;color:#1c1c1e;}
.nav-logo-img{width:36px;height:36px;object-fit:contain;}
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

/* ── Footer ── */
.site-footer{background:#fff;border-top:1px solid #e5e5ea;padding:28px 20px 44px;}
.footer-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:20px;}
.footer-brand{display:flex;align-items:center;gap:10px;}
.footer-logo-img{width:34px;height:34px;object-fit:contain;}
.footer-brand-name{font-size:16px;font-weight:800;color:#1c1c1e;}
.footer-brand-name span{color:#cc0000;}
.footer-links{display:flex;flex-direction:column;gap:12px;text-align:right;}
.footer-links a{font-size:13px;color:#636366;text-decoration:none;font-weight:500;}
.footer-links a:active{color:#cc0000;}
.footer-bottom{border-top:1px solid #f2f2f7;padding-top:16px;text-align:center;}
.footer-copy{font-size:12px;color:#8e8e93;line-height:1.7;}

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
    <button class="tab" onclick="setCat('infinitas')">Infinitas</button>
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
    <p class="footer-copy">© 2025 Net Serviços · Todos os direitos reservados</p>
  </div>
</footer>

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
