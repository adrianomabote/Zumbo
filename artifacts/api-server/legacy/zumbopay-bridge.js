/**
 * Megabyte — Plataforma de internet e pagamentos em Moçambique
 * Node.js puro · zero dependências externas
 */

import { createServer }                              from 'http'
import { createHmac, timingSafeEqual, randomBytes, randomUUID }  from 'crypto'
import { readFile, writeFile, rename }               from 'fs/promises'

// ── Configuração ──────────────────────────────────────────────────────────────
const PORT                 = process.env.PORT || 5000
const SITE_URL             = process.env.SITE_URL || 'https://megabyte.live'
const UUID_RE              = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const WALLET_MPESA         = UUID_RE.test(String(process.env.WALLET_MPESA || ''))
  ? process.env.WALLET_MPESA
  : 'd9a21461-8ff3-4929-8015-efd89268a068'
const WALLET_EMOLA         = UUID_RE.test(String(process.env.WALLET_EMOLA || ''))
  ? process.env.WALLET_EMOLA
  : '93a03d6d-f361-4602-90e1-c62889b45346'
const ADMIN_PASS           = process.env.ADMIN_PASS
const PAYMENT_MODE         = String(
  process.env.NET_SERVICOS_PAYMENT_MODE ||
  (process.env.NODE_ENV === 'production' ? 'live' : 'mock')
).toLowerCase()
const isTestMode           = PAYMENT_MODE === 'mock' || PAYMENT_MODE === 'test'
const ORDERS_FILE          = './orders.json'
const USERS_FILE           = './users.json'
const RECHARGE_CREDITS_FILE = './recharge-credits.json'

function adminToken() {
  return createHmac('sha256', (process.env.PAGAR_WEBHOOK_SECRET || '') + ADMIN_PASS).update('netservicos:admin').digest('hex')
}
function checkAdminCookie(req) {
  const cookies = req.headers.cookie || ''
  const m = cookies.match(/(?:^|;\s*)nsa=([^;]*)/)
  return m ? m[1] === adminToken() : false
}

// ── Catálogo de pacotes ───────────────────────────────────────────────────────
const BUNDLES = new Map([
  ['n04',{label:'780 MB', price:20,  cat:'normal'}],
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

// ── Armazenamento local persistente na VPS ─────────────────────────────────────
async function dbInit() {
  console.log('[DB] sem PostgreSQL externo — a usar ficheiros locais na VPS')
}
async function storeLoad(k, file) {
  try { return JSON.parse(await readFile(file, 'utf8')) } catch { return null }
}
async function storeSave(k, data, file) {
  try { await writeFile(file, JSON.stringify(data, null, 2)) } catch {}
}
async function writeJsonAtomic(file, data) {
  const tempFile = `${file}.tmp`
  await writeFile(tempFile, JSON.stringify(data, null, 2))
  await rename(tempFile, file)
}

// ── Estado em memória ─────────────────────────────────────────────────────────
const transactions  = new Map()
const sseClients    = new Map()
let   orders        = []           // persiste em ORDERS_FILE
let   rechargeCredits = []         // diário de créditos de saldo recuperável
let   rechargeCreditQueue = Promise.resolve()

// ── Anti-brute-force: login ───────────────────────────────────────────────────
const loginAttempts = new Map()   // ip → { count, lockedUntil }
const MAX_ATTEMPTS  = 5
const LOCK_MS       = 15 * 60 * 1000

function checkBruteForce(ip) {
  const rec = loginAttempts.get(ip)
  if (!rec) return null
  if (rec.lockedUntil && Date.now() < rec.lockedUntil) {
    const mins = Math.ceil((rec.lockedUntil - Date.now()) / 60000)
    return `Acesso bloqueado por ${mins} min. Demasiadas tentativas incorrectas.`
  }
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) loginAttempts.delete(ip)
  return null
}
function recordFailedLogin(ip) {
  const rec = loginAttempts.get(ip) || { count: 0, lockedUntil: null }
  if (rec.lockedUntil && Date.now() >= rec.lockedUntil) { rec.count = 0; rec.lockedUntil = null }
  rec.count++
  if (rec.count >= MAX_ATTEMPTS) { rec.lockedUntil = Date.now() + LOCK_MS; rec.count = 0 }
  loginAttempts.set(ip, rec)
  return MAX_ATTEMPTS - rec.count
}
function clearLoginAttempts(ip) { loginAttempts.delete(ip) }
function safeEqual(a, b) {
  const ha = createHmac('sha256', 'cmp').update(a).digest()
  const hb = createHmac('sha256', 'cmp').update(b).digest()
  return timingSafeEqual(ha, hb)
}

// ── Utilizadores ──────────────────────────────────────────────────────────────
let users = []
async function loadUsers() { const d = await storeLoad('users', USERS_FILE); if (d) users = d }
async function saveUsers() { await storeSave('users', users, USERS_FILE) }
function findUserByPhone(p) { return users.find(u=>u.phone===p) }
function findUserById(id)   { return users.find(u=>u.id===id) }
function hashPwd(pass, salt){ return createHmac('sha256', salt + ADMIN_PASS).update(pass).digest('hex') }
function mkUserToken(u)     { return createHmac('sha256', ADMIN_PASS + 'u3').update(u.id+':'+u.phone).digest('hex') }
function checkUserCookie(req) {
  const m = (req.headers.cookie||'').match(/(?:^|;\s*)nsu=([^.;]+)\.([^;]+)/)
  if (!m) return null
  const user = findUserById(m[1])
  if (!user) return null
  try {
    const exp = mkUserToken(user)
    return timingSafeEqual(Buffer.from(m[2],'hex'), Buffer.from(exp,'hex')) ? user : null
  } catch { return null }
}
function userCookieHeader(u) {
  return `nsu=${u.id}.${mkUserToken(u)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`
}

// ── Gateway: chaves de API para terceiros ─────────────────────────────────────
const GWKEYS_FILE = './gateway-keys.json'
let gwKeys = []   // [{ id, name, key, secret, active, createdAt, txCount, totalAmount }]
// Chave principal fixa — sobrevive a deploys (o disco do Render é efémero)
const GW_BUILTIN = {
  id: 'principal',
  name: 'Chave Principal (fixa)',
  key: process.env.GW_MASTER_KEY,
  secret: process.env.GW_MASTER_SECRET,
  active: true, createdAt: '2026-08-08T00:00:00.000Z', txCount: 0, totalAmount: 0, builtin: true,
}
async function loadGwKeys() {
  const d = await storeLoad('gwkeys', GWKEYS_FILE); if (d) gwKeys = d
  if (!gwKeys.some(g => g.id === GW_BUILTIN.id)) gwKeys.unshift(GW_BUILTIN)
}
async function saveGwKeys() { await storeSave('gwkeys', gwKeys, GWKEYS_FILE) }
function findGwKey(k) {
  if (!k) return null
  const rec = gwKeys.find(g => g.key === k)
  return rec && rec.active ? rec : null
}
function gwAuth(req, body) {
  const hdr = req.headers['x-api-key'] || ''
  const auth = req.headers['authorization'] || ''
  const bearer = auth.startsWith('Bearer ') ? auth.slice(7) : ''
  return findGwKey(hdr || bearer || body?.api_key)
}
function gwSign(secret, payload) {
  return createHmac('sha256', secret).update(payload).digest('hex')
}
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}
function isPrivateIp(ip) {
  if (ip.includes(':')) {   // IPv6
    const l = ip.toLowerCase()
    return l === '::1' || l.startsWith('fc') || l.startsWith('fd') || l.startsWith('fe80') || l.startsWith('::ffff:')
  }
  const p = ip.split('.').map(Number)
  return p[0] === 10 || p[0] === 127 || p[0] === 0 ||
    (p[0] === 172 && p[1] >= 16 && p[1] <= 31) ||
    (p[0] === 192 && p[1] === 168) ||
    (p[0] === 169 && p[1] === 254) ||   // link-local / metadata
    (p[0] === 100 && p[1] >= 64 && p[1] <= 127)
}
async function gwValidateCallbackUrl(raw) {
  let u
  try { u = new URL(raw) } catch { return null }
  if (u.protocol !== 'https:') return null
  if (/^\d+\.\d+\.\d+\.\d+$/.test(u.hostname) || u.hostname.includes(':')) {
    if (isPrivateIp(u.hostname)) return null
  } else {
    try {
      const { lookup } = await import('dns/promises')
      const addrs = await lookup(u.hostname, { all: true })
      if (addrs.some(a => isPrivateIp(a.address))) return null
    } catch { return null }
  }
  return u.href
}
// Transição terminal única: conta estatísticas + envia callback, só 1 vez por tx
function gwFinalize(tx) {
  if (tx.type !== 'gateway' || tx.gwDone) return
  if (tx.status !== 'succeeded' && tx.status !== 'failed') return
  tx.gwDone = true
  if (tx.status === 'succeeded') {
    const gk = gwKeys.find(g => g.id === tx.gwKeyId)
    if (gk) { gk.txCount = (gk.txCount||0)+1; gk.totalAmount = (gk.totalAmount||0)+tx.amount; saveGwKeys().catch(()=>{}) }
  }
  gwForwardCallback(tx).catch(()=>{})
}
async function gwForwardCallback(tx) {
  if (!tx.callbackUrl) return
  const gk = gwKeys.find(g => g.id === tx.gwKeyId)
  const payload = JSON.stringify({
    event: tx.status === 'succeeded' ? 'payment.succeeded' : 'payment.failed',
    txId: tx.id, reference: tx.extRef || null,
    amount: tx.amount, phone: tx.phone, method: tx.method,
    error: tx.error || null, ts: new Date().toISOString(),
  })
  const headers = { 'Content-Type':'application/json' }
  if (gk) headers['X-Gateway-Signature'] = gwSign(gk.secret, payload)
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(tx.callbackUrl, { method:'POST', headers, body: payload, redirect:'error', signal: AbortSignal.timeout(10000) })
      if (r.ok) { console.log(`[Gateway] callback → ${tx.callbackUrl} OK`); return }
    } catch {}
    await new Promise(r => setTimeout(r, 3000 * (i+1)))
  }
  console.error(`[Gateway] callback falhou 3x: ${tx.callbackUrl}`)
}

// ── Persistência de encomendas ────────────────────────────────────────────────
async function loadOrders() { const d = await storeLoad('orders', ORDERS_FILE); if (d) orders = d }
async function saveOrders() { await storeSave('orders', orders, ORDERS_FILE) }
async function loadRechargeCredits() {
  const d = await storeLoad('recharge-credits', RECHARGE_CREDITS_FILE)
  if (Array.isArray(d)) rechargeCredits = d
}
async function saveRechargeCredits() { await writeJsonAtomic(RECHARGE_CREDITS_FILE, rechargeCredits) }
function trackOrder(tx, extra = {}) {
  const rec = {
    txId: tx.id, type: tx.type || 'bundle', phone: tx.phone,
    beneficiaryPhone: tx.beneficiaryPhone || null,
    bundleId: tx.bundleId || null, bundleLabel: tx.bundleLabel || null,
    amount: tx.amount, method: tx.method, status: 'pending',
    sourceId: tx.sourceId || null,
    ts: tx.ts, activatedAt: null, userId: tx.userId || null, ...extra,
  }
  orders.unshift(rec)
  saveOrders()
  return rec
}
async function updateOrderStatus(txId, status, extra = {}) {
  const rec = orders.find(o => o.txId === txId)
  if (!rec) return
  Object.assign(rec, { status, ...extra })
  await saveOrders()
  if (status !== 'succeeded' || rec.type !== 'bundle') return

  try {
    const delivery = await enqueueUssdDelivery(rec)
    Object.assign(rec, {
      deliveryId: delivery.id,
      deliveryStatus: delivery.status,
      deliveryFailureReason: delivery.failureReason || null,
    })
    await saveOrders()
  } catch (e) {
    rec.deliveryStatus = 'failed'
    rec.deliveryFailureReason = e.message || 'Não foi possível enfileirar a entrega USSD.'
    await saveOrders()
    console.error('[USSD] enqueue error:', rec.deliveryFailureReason)
  }
}
function creditRechargeOnce(tx) {
  const work = rechargeCreditQueue.then(() => creditRechargeOnceLocked(tx))
  rechargeCreditQueue = work.catch(() => {})
  return work
}
async function creditRechargeOnceLocked(tx) {
  if (tx.type !== 'recharge' || !tx.userId) return false
  const rec = orders.find(o => o.txId === tx.id)
  const user = findUserById(tx.userId)
  if (!user) return false
  let journal = rechargeCredits.find(entry => entry.txId === tx.id)
  if (!journal) {
    journal = { txId:tx.id, userId:tx.userId, amount:tx.amount, balanceApplied:false }
    rechargeCredits.push(journal)
    await saveRechargeCredits()
  }
  const appliedCredits = user.rechargeCredits || []
  if (!appliedCredits.includes(tx.id)) {
    user.balance = (user.balance||0) + tx.amount
    user.rechargeCredits = [...appliedCredits, tx.id]
    await writeJsonAtomic(USERS_FILE, users)
  }
  if (!journal.balanceApplied) {
    journal.balanceApplied = true
    await saveRechargeCredits()
  }
  if (rec && !rec.rechargeCredited) {
    rec.rechargeCredited = true
    await writeJsonAtomic(ORDERS_FILE, orders)
  }
  return true
}
async function recoverRechargeCredits() {
  for (const credit of rechargeCredits) {
    if (!credit.balanceApplied) {
      await creditRechargeOnce({ id:credit.txId, type:'recharge', userId:credit.userId, amount:credit.amount })
    }
  }
}

function bundleUssdSequence(bundleLabel, beneficiaryPhone) {
  // Sequência USSD Vodacom Mozambique — validar no telefone dedicado antes de produção
  return [`*111#`, `Enviar pacote ${bundleLabel} para ${beneficiaryPhone}`]
}

async function enqueueUssdDelivery(order) {
  const mainPort = process.env.MAIN_API_PORT
  const secret   = process.env.SESSION_SECRET
  if (!mainPort || !secret) throw new Error('Servidor de entregas USSD não configurado.')
  const beneficiaryPhone = order.beneficiaryPhone || order.phone
  if (!beneficiaryPhone) throw new Error('Número do beneficiário ausente.')
  const body = JSON.stringify({
    paymentId:           order.txId,
    idempotencyKey:      `order-${order.txId}`,
    beneficiaryPhone,
    packageLabel:        order.bundleLabel || 'Pacote de dados',
    ussdSequence:        bundleUssdSequence(order.bundleLabel || 'Pacote de dados', beneficiaryPhone),
  })
  try {
    const res = await fetch(`http://localhost:${mainPort}/api/ussd-agent/internal/paid-deliveries`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', 'x-internal-delivery-key': secret },
      body,
      signal:  AbortSignal.timeout(5000),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) {
      throw new Error(data.error || `Servidor recusou enfileiramento: ${res.status}`)
    }
    console.log(`[USSD] Entrega enfileirada para ${beneficiaryPhone}`)
    return data.delivery
  } catch (e) {
    if (e.name === 'AbortError' || e.name === 'TimeoutError') {
      throw new Error('Tempo esgotado ao contactar o servidor de entregas USSD.')
    }
    throw e
  }
}

async function retryUssdDelivery(order) {
  const mainPort = process.env.MAIN_API_PORT
  const secret = process.env.SESSION_SECRET
  if (!mainPort || !secret) throw new Error('Servidor de entregas USSD não configurado.')

  const hasExistingDelivery = Boolean(order.deliveryId)
  const endpoint = hasExistingDelivery
    ? `/api/ussd-agent/admin/deliveries/${encodeURIComponent(order.deliveryId)}/retry`
    : '/api/ussd-agent/internal/paid-deliveries'
  const body = hasExistingDelivery
    ? undefined
    : JSON.stringify({
      paymentId: order.txId,
      idempotencyKey: `order-${order.txId}`,
      beneficiaryPhone: order.beneficiaryPhone || order.phone,
      packageLabel: order.bundleLabel || 'Pacote de dados',
      ussdSequence: bundleUssdSequence(order.bundleLabel || 'Pacote de dados', order.beneficiaryPhone || order.phone),
    })
  const res = await fetch(`http://localhost:${mainPort}${endpoint}`, {
    method: 'POST',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      'x-internal-delivery-key': secret,
    },
    body,
    signal: AbortSignal.timeout(5000),
  })
  const data = await res.json().catch(() => ({}))
  if (!res.ok) throw new Error(data.error || `Servidor recusou a repetição: ${res.status}`)
  return data.delivery
}

async function refreshDeliveryStates() {
  const mainPort = process.env.MAIN_API_PORT
  const secret = process.env.SESSION_SECRET
  if (!mainPort || !secret) return
  try {
    const res = await fetch(`http://localhost:${mainPort}/api/ussd-agent/admin/deliveries`, {
      headers: { 'x-internal-delivery-key': secret },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return
    const data = await res.json().catch(() => ({}))
    if (!Array.isArray(data.deliveries)) return
    let changed = false
    for (const delivery of data.deliveries) {
      const key = String(delivery.idempotencyKey || '')
      if (!key.startsWith('order-')) continue
      const rec = orders.find(order => order.txId === key.slice('order-'.length))
      if (!rec) continue
      const next = {
        deliveryId: delivery.id,
        deliveryStatus: delivery.status,
        deliveryFailureReason: delivery.failureReason || null,
      }
      if (delivery.status === 'completed' && rec.status === 'succeeded') {
        next.status = 'activated'
        next.activatedAt = delivery.updatedAt || new Date().toISOString()
      }
      if (Object.entries(next).some(([field, value]) => rec[field] !== value)) {
        Object.assign(rec, next)
        changed = true
      }
    }
    if (changed) await saveOrders()
  } catch (e) {
    console.error('[USSD] Falha ao actualizar estados no painel:', e.message)
  }
}

async function refreshPagarForwardingStates() {
  const mainPort = process.env.MAIN_API_PORT
  const secret = process.env.SESSION_SECRET
  if (!mainPort || !secret) return
  try {
    const res = await fetch(`http://localhost:${mainPort}/api/pagar/admin/webhook-deliveries`, {
      headers: { 'x-internal-payment-key': secret },
      signal: AbortSignal.timeout(5000),
    })
    if (!res.ok) return
    const data = await res.json().catch(() => ({}))
    if (!Array.isArray(data.events)) return
    let changed = false
    for (const event of data.events) {
      const identifiers = [event.reference, event.operationId].filter(Boolean).map(String)
      const rec = orders.find(order => identifiers.includes(String(order.sourceId)) ||
        identifiers.includes(String(order.pagarRef)) || identifiers.includes(String(order.txId)))
      if (!rec) continue
      const next = {
        pagarForwardingEventId: event.eventId,
        pagarForwardingStatus: event.forwardingStatus,
        pagarForwardingAttempts: Number(event.forwardingAttempts || 0),
        pagarForwardingFailureReason: event.forwardingLastError || null,
        pagarForwardingNextRetryAt: event.forwardingNextRetryAt || null,
      }
      if (Object.entries(next).some(([field, value]) => rec[field] !== value)) {
        Object.assign(rec, next)
        changed = true
      }
    }
    if (changed) await saveOrders()
  } catch (e) {
    console.error('[Pagar] Falha ao actualizar estados de encaminhamento:', e.message)
  }
}
function json(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders })
  res.end(body)
}
function csvCell(value) {
  const text = value === null || value === undefined ? '' : String(value)
  return `"${text.replace(/"/g, '""')}"`
}
function csvDate(value) {
  return value ? new Date(value).toISOString() : ''
}
function historyCsv(type) {
  const isGateway = type === 'gateway'
  const records = orders.filter(o => isGateway ? o.type === 'gateway' : o.type !== 'gateway')
  const headers = isGateway
    ? ['ID', 'Data / Hora', 'Referência interna', 'Canal', 'Pagador', 'Valor (MT)', 'Método', 'Estado', 'Referência externa']
    : ['ID', 'Data / Hora', 'Pagador', 'Beneficiário', 'Oferta', 'Valor (MT)', 'Método', 'Estado', 'Activado em', 'Referência ZumboPay', 'Entrega USSD', 'Encaminhamento Pagar']
  const rows = records.map(o => isGateway
    ? [
        o.txId,
        csvDate(o.ts),
        `GW-${o.txId}`,
        o.gwKeyId === 'principal' ? 'Canal principal' : `Canal privado · ${o.gwKeyId || 'privado'}`,
        o.phone,
        o.amount,
        ({ mpesa: 'M-Pesa', emola: 'e-Mola' }[o.method] || o.method),
        o.status,
        o.extRef || '',
      ]
    : [
        o.txId,
        csvDate(o.ts),
        o.phone,
        o.beneficiaryPhone || o.phone,
        o.bundleLabel || '',
        o.amount,
        ({ mpesa: 'M-Pesa', emola: 'e-Mola' }[o.method] || o.method),
        o.status,
        csvDate(o.activatedAt),
        o.zumboRef || '',
        o.deliveryStatus || '',
        o.pagarForwardingStatus || '',
      ])
  return [headers, ...rows].map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'
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
function normalizeLocalPhone(p) {
  const digits = String(p || '').replace(/\D/g,'')
  return digits.startsWith('258') ? digits.slice(3) : digits
}
function isSupportedLocalPhone(p) {
  return /^(84|85|86|87)\d{7}$/.test(normalizeLocalPhone(p))
}
function publicUser(user) {
  return { id:user.id, name:user.name, phone:user.phone, balance:user.balance||0 }
}
function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''))
}

function notifyTx(txId, data) {
  const clients = sseClients.get(txId)
  if (!clients) return
  const msg = `data: ${JSON.stringify(data)}\n\n`
  for (const r of clients) { try { r.write(msg) } catch {} }
}

async function initiateCharge(tx, customerName) {
  if (isTestMode) {
    tx.ref = `test-${tx.sourceId || tx.id}`
    tx.status = 'succeeded'
    console.log(`[ZumboPay] TEST charge simulated for ${tx.id}`)
    await updateOrderStatus(tx.id, 'succeeded', { zumboRef: tx.ref })
    await creditRechargeOnce(tx)
    notifyTx(tx.id, { status:'succeeded', method:tx.method, testMode:true })
    gwFinalize(tx)
    return
  }
  try {
    const resp = await fetch(`http://localhost:${process.env.MAIN_API_PORT}/api/pagar/internal/payments`, {
      method: 'POST',
      headers: { 'Content-Type':'application/json', 'x-internal-payment-key':process.env.SESSION_SECRET },
      body: JSON.stringify({
        localTransactionId: tx.id,
        sourceId: tx.sourceId,
        reference: `net-${tx.id}`,
        title: customerName,
        description: customerName,
        amountMzn: tx.amount,
        method: tx.method === 'mpesa' ? 'MPESA' : 'EMOLA',
        payerPhone: tx.phone,
        idempotencyKey: `pagar-${tx.id}`,
      }),
    })
    const data = await resp.json().catch(()=>({}))
    console.log(`[Pagar] POST /payments → ${resp.status}`, JSON.stringify({ status:data.status, reference:data.reference }))
    if (resp.status === 202) {
      tx.ref = data.reference || `net-${tx.id}`; tx.status = 'pending'
      notifyTx(tx.id, { status:'pending', method:tx.method })
      await updateOrderStatus(tx.id, 'pending', { pagarRef: tx.ref })
      scheduleTimeout(tx); return
    }
    const msg = data.error || data.message || `Erro ${resp.status}`
    tx.status = 'failed'; tx.error = msg
    notifyTx(tx.id, { status:'failed', error:msg, method:tx.method })
    await updateOrderStatus(tx.id, 'failed'); gwFinalize(tx)
  } catch (err) {
    console.error('[Pagar]', err.message)
    tx.status = 'failed'; tx.error = 'Erro de ligação. Tente novamente.'
    notifyTx(tx.id, { status:'failed', error:tx.error, method:tx.method })
    await updateOrderStatus(tx.id, 'failed'); gwFinalize(tx)
  }
}

function scheduleTimeout(tx) {
  setTimeout(async () => {
    if (tx.status !== 'pending') return
    tx.status = 'failed'; tx.error = 'Tempo esgotado. O PIN não foi introduzido.'
    notifyTx(tx.id, { status:'failed', error:tx.error, method:tx.method })
    await updateOrderStatus(tx.id, 'failed'); gwFinalize(tx)
  }, 5 * 60 * 1000)
}

// ── Router ────────────────────────────────────────────────────────────────────
async function router(req, res) {
  const method = req.method
  const path   = req.url.split('?')[0]
  res.setHeader('Access-Control-Allow-Origin', '*')

  const staticPath = path.startsWith('/static/')
  const readOnlyPath = [
    '/', '/megas', '/ping', '/favicon.ico', '/manifest.json', '/sw.js',
    '/api/config', '/api/bundles', '/api/auth/me', '/api/auth/logout',
  ].includes(path) || staticPath
  const accountSetupPath = ['/api/auth/register', '/api/auth/login'].includes(path)
  const adminLoginPath = path === '/admin/office'
  if (!isLiveConfiguration && !(method === 'GET' && readOnlyPath) && !accountSetupPath && !adminLoginPath) {
    return json(res, {
      error: 'Operações temporariamente indisponíveis enquanto a configuração segura do serviço não é concluída.',
    }, 503)
  }

  // ── Páginas públicas ──────────────────────────────────────────────────────
  if (method === 'GET' && path === '/')         { res.writeHead(302,{'Location':'/megas'}); return res.end() }
  // ── Ficheiros estáticos (servidos de ./public/) ───────────────────────────
  const STATIC_MAP = {
    '/static/vodacom.webp'        :['public/vodacom.webp'        ,'image/webp'],
    '/favicon.ico'                :['public/vodacom.webp'        ,'image/webp'],
    '/static/vodafone-logo.jpg'   :['public/vodafone-logo.jpg'   ,'image/jpeg'],
    '/static/voda-anim.gif'       :['public/voda-anim.gif'       ,'image/gif'],
    '/static/coins.png'           :['public/coins.png'           ,'image/png'],
    '/static/offer-soprati.webp'  :['public/offer-soprati.webp'  ,'image/webp'],
    '/static/offer-ya.webp'       :['public/offer-ya.webp'       ,'image/webp'],
    '/static/offer-bomdia.webp'   :['public/offer-bomdia.webp'   ,'image/webp'],
    '/static/offer-turnonoite.webp':['public/offer-turnonoite.webp','image/webp'],
    '/static/offer-jackpot.webp'  :['public/offer-jackpot.webp'  ,'image/webp'],
    '/static/icon-192.png'        :['public/icon-192.png'        ,'image/png'],
    '/static/icon-512.png'        :['public/icon-512.png'        ,'image/png'],
    '/static/icon-maskable-512.png':['public/icon-maskable-512.png','image/png'],
  }
  if (method === 'GET' && STATIC_MAP[path]) {
    const [file, mime] = STATIC_MAP[path]
    try {
      const data = await import('fs/promises').then(f=>f.readFile(`./${file}`))
      res.writeHead(200,{'Content-Type':mime,'Cache-Control':'max-age=86400'})
      return res.end(data)
    } catch { res.writeHead(404); return res.end() }
  }
  if (method === 'GET' && path === '/static/icon.svg') {
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512"><image href="/api/legacy/static/icon-512.png?v=4" width="512" height="512"/></svg>`
    res.writeHead(200,{'Content-Type':'image/svg+xml','Cache-Control':'max-age=86400'}); return res.end(svg)
  }
  if (method === 'GET' && path === '/manifest.json') {
    const manifest = JSON.stringify({
      name:'Megabyte',short_name:'Megabyte',
      description:'Pacotes de internet Vodacom com pagamento M-Pesa',
       start_url:'/',scope:'/',display:'standalone',
      background_color:'#f2f2f7',theme_color:'#cc0000',orientation:'portrait-primary',
      icons:[
         {src:'/api/legacy/static/icon-192.png?v=4',sizes:'192x192',type:'image/png',purpose:'any'},
         {src:'/api/legacy/static/icon-512.png?v=4',sizes:'512x512',type:'image/png',purpose:'any'},
         {src:'/api/legacy/static/icon-maskable-512.png?v=4',sizes:'512x512',type:'image/png',purpose:'maskable'}
      ]
    })
    res.writeHead(200,{'Content-Type':'application/manifest+json','Cache-Control':'max-age=3600'}); return res.end(manifest)
  }
  if (method === 'GET' && path === '/sw.js') {
    const sw = `
const CACHE='ns-v6';
const PRECACHE=['/api/legacy/manifest.json','/api/legacy/static/icon-192.png?v=4','/api/legacy/static/icon-512.png?v=4','/api/legacy/static/icon-maskable-512.png?v=4','/api/legacy/static/vodafone-logo.jpg','/api/legacy/static/coins.png'];
self.addEventListener('install',e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(PRECACHE)).then(()=>self.skipWaiting()))});
self.addEventListener('activate',e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()))});
self.addEventListener('fetch',e=>{
  if(e.request.method!=='GET')return;
  const url=new URL(e.request.url);
  if(url.pathname.startsWith('/api/')||url.pathname.startsWith('/admin')||url.pathname.startsWith('/events/'))return;
  // Páginas HTML: network-first (nunca servir versão antiga após deploy)
  if(e.request.mode==='navigate'||url.pathname==='/megas'){
    e.respondWith(fetch(e.request).then(r=>{if(r&&r.status===200){const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c))}return r}).catch(()=>caches.match(e.request)));
    return;
  }
  // Estáticos: cache-first com actualização em segundo plano
  e.respondWith(caches.match(e.request).then(cached=>{const fresh=fetch(e.request).then(r=>{if(r&&r.status===200){const c=r.clone();caches.open(CACHE).then(ca=>ca.put(e.request,c))}return r}).catch(()=>null);return cached||fresh}));
});
`
    res.writeHead(200,{'Content-Type':'application/javascript','Cache-Control':'no-cache'}); return res.end(sw)
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
    return json(res, {
      registered: Boolean(process.env.PAGAR_WEBHOOK_SECRET),
      url: process.env.PAGAR_WEBHOOK_URL || null,
      active: Boolean(process.env.PAGAR_API_KEY && process.env.PAGAR_SIGNING_SECRET),
    })
  }

  // ── API encomenda de megas ────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/order') {
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const user = checkUserCookie(req)
    if (!user) return json(res, { error:'Faça login para comprar um pacote.' }, 401)
    const { phone, beneficiaryPhone, bundleId } = body
    const bundle = BUNDLES.get(bundleId)
    if (!bundle) return json(res, { error:'Pacote inválido.' }, 400)
    const purchaseFor = String(body.purchaseFor || '').toLowerCase()
    const isSelfPurchase = purchaseFor === 'self' || (!purchaseFor && !beneficiaryPhone)
    const payerPhone = normalizeLocalPhone(phone)
    const selectedMethod = String(body.paymentMethod || body.method || '').toLowerCase()
    if (!isSupportedLocalPhone(payerPhone)) return json(res, { error:'Número de pagamento inválido. Use M-Pesa 84/85 ou e-Mola 86/87.' }, 400)
    if (!isSelfPurchase && !beneficiaryPhone) return json(res, { error:'Introduza o número do beneficiário.' }, 400)
    const beneficiary = isSelfPurchase ? normalizeLocalPhone(user.phone) : normalizeLocalPhone(beneficiaryPhone)
    if (!isSelfPurchase && beneficiary && detectMethod(normalizeMsisdn(beneficiary)) !== 'mpesa')
      return json(res, { error:'Número do beneficiário inválido. Use apenas uma faixa 84 ou 85.' }, 400)
    const msisdn = normalizeMsisdn(payerPhone), detectedMethod = detectMethod(msisdn)
    const meth = selectedMethod || detectedMethod
    if (!['mpesa','emola'].includes(meth) || meth !== detectedMethod)
      return json(res, { error:'O método escolhido não corresponde ao número de pagamento.' }, 400)
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'bundle', bundleId, bundleLabel:bundle.label, phone:payerPhone, beneficiaryPhone:beneficiary, msisdn, amount:bundle.price, method:meth, status:'pending', ref:null, error:null, sourceId:randomUUID(), ts:new Date().toISOString(), userId:user.id }
    transactions.set(txId, tx)
    trackOrder(tx)
    json(res, { txId, status:'pending', method:meth })
    initiateCharge(tx, `Mega ${bundle.label}`)
    return
  }

  if (method === 'POST' && path === '/internal/pagar-event') {
    const raw = await readBody(req)
    let body = {}
    try { body = JSON.parse(raw.toString()) } catch {}
    if (!process.env.SESSION_SECRET || req.headers['x-internal-payment-key'] !== process.env.SESSION_SECRET) {
      return json(res, { error:'Origem não autorizada.' }, 401)
    }
    const status = body.eventType === 'payment.succeeded' ? 'succeeded' : body.eventType === 'payment.failed' ? 'failed' : null
    if (!status) return json(res, { ok:true })
    const rec = orders.find(o => o.sourceId === body.reference || o.sourceId === body.operationId ||
      o.txId === body.reference || o.pagarRef === body.reference || o.pagarRef === body.operationId)
    const tx = [...transactions.values()].find(t => t.id === body.reference || t.sourceId === body.reference ||
      t.id === body.operationId || t.sourceId === body.operationId)
    const target = tx || rec
    if (!target) return json(res, { ok:true })
    const txId = target.id || target.txId
    const liveTx = transactions.get(txId) || { id:txId, type:rec?.type, amount:rec?.amount, phone:rec?.phone, method:rec?.method,
      extRef:rec?.extRef, callbackUrl:rec?.callbackUrl, gwKeyId:rec?.gwKeyId, status:rec?.status }
    const duplicate = liveTx.status === status
    liveTx.status = status
    if (body.reference) liveTx.ref = body.reference
    if (status === 'failed') liveTx.error = 'Pagamento recusado.'
    transactions.set(txId, liveTx)
    await updateOrderStatus(txId, status, { pagarRef: body.reference || null })
    if (!duplicate) {
      if (status === 'succeeded') await creditRechargeOnce(liveTx)
      notifyTx(txId, { status, method:liveTx.method, error:liveTx.error || null })
      gwFinalize(liveTx)
    }
    return json(res, { ok:true })
  }

  // Pagar webhooks are handled by the parent Express server at /api/pagar/webhook.
  if (method === 'POST' && path === '/webhook') {
    return json(res, { error:'Use /api/pagar/webhook.' }, 410)
  }

  // Public read-only metadata used by the storefront during startup.
  if (method === 'GET' && path === '/api/config') {
    return json(res, {
      ok: true,
      paymentMode: isTestMode ? 'test' : 'live',
      minAmountMzn: 20,
      maxAmountMzn: 40000,
    })
  }
  if (method === 'GET' && path === '/api/bundles') {
    return json(res, Array.from(BUNDLES, ([id, bundle]) => ({ id, ...bundle })))
  }

  // ── Auth: Criar conta ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/auth/register') {
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { name, phone, password } = body
    if (!name||!name.trim())       return json(res, { error:'Nome é obrigatório.' }, 400)
    if (!isSupportedLocalPhone(phone))
                                   return json(res, { error:'Número inválido. Use M-Pesa 84/85 ou e-Mola 86/87.' }, 400)
    if (!password||password.length < 6) return json(res, { error:'Senha deve ter pelo menos 6 caracteres.' }, 400)
    const ph = normalizeLocalPhone(phone)
    if (findUserByPhone(ph))       return json(res, { error:'Este número já tem uma conta.' }, 409)
    const salt = randomBytes(16).toString('hex')
    const user = { id: randomBytes(6).toString('hex'), name: name.trim(), phone: ph, passwordHash: hashPwd(password, salt), salt, balance: 0, createdAt: new Date().toISOString() }
    users.push(user)
    await saveUsers()
    const pub = publicUser(user)
    return json(res, { ok:true, user:pub }, 201, { 'Set-Cookie': userCookieHeader(user) })
  }

  // ── Auth: Entrar ──────────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/auth/login') {
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { phone, password } = body
    const ph = String(phone||'').replace(/\D/g,'')
    const user = findUserByPhone(ph)
    if (!user || hashPwd(password||'', user.salt) !== user.passwordHash)
      return json(res, { error:'Número ou senha incorrectos.' }, 401)
    const pub = publicUser(user)
    return json(res, { ok:true, user:pub }, 200, { 'Set-Cookie': userCookieHeader(user) })
  }

  // ── Auth: Sair ────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/auth/logout') {
    return json(res, { ok:true }, 200, { 'Set-Cookie': 'nsu=; Path=/; Max-Age=0' })
  }

  // ── Auth: Eu ──────────────────────────────────────────────────────────────
  if (method === 'GET' && path === '/api/auth/me') {
    const user = checkUserCookie(req)
    if (!user) return json(res, { error:'Não autenticado.' }, 401)
    return json(res, publicUser(user))
  }

  // ── Auth: actualizar perfil ───────────────────────────────────────────────
  if (method === 'POST' && path === '/api/auth/profile') {
    const user = checkUserCookie(req)
    if (!user) return json(res, { error:'Não autenticado.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const name = String(body.name || '').trim()
    const phone = normalizeLocalPhone(body.phone)
    if (!name) return json(res, { error:'Nome é obrigatório.' }, 400)
    if (!isSupportedLocalPhone(phone)) return json(res, { error:'Número inválido. Use M-Pesa 84/85 ou e-Mola 86/87.' }, 400)
    const existing = findUserByPhone(phone)
    if (existing && existing.id !== user.id) return json(res, { error:'Este número já tem uma conta.' }, 409)
    user.name = name
    user.phone = phone
    await saveUsers()
    return json(res, { ok:true, user:publicUser(user) }, 200, { 'Set-Cookie': userCookieHeader(user) })
  }

  // ── Auth: alterar senha ───────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/auth/change-password') {
    const user = checkUserCookie(req)
    if (!user) return json(res, { error:'Não autenticado.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const currentPassword = String(body.currentPassword || '')
    const newPassword = String(body.newPassword || '')
    if (!currentPassword || hashPwd(currentPassword, user.salt) !== user.passwordHash)
      return json(res, { error:'A senha actual está incorrecta.' }, 400)
    if (newPassword.length < 6) return json(res, { error:'A nova senha deve ter pelo menos 6 caracteres.' }, 400)
    const salt = randomBytes(16).toString('hex')
    user.salt = salt
    user.passwordHash = hashPwd(newPassword, salt)
    await saveUsers()
    return json(res, { ok:true })
  }

  // ── Recarga de crédito ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/recharge') {
    const user = checkUserCookie(req)
    if (!user) return json(res, { error:'Faça login para recarregar.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const amount = parseInt(body.amount)
    if (!amount || amount < 20) return json(res, { error:'O valor mínimo para recarregar é 20 MT.' }, 400)
    const msisdn = normalizeMsisdn(user.phone), meth = detectMethod(msisdn)
    if (!meth) return json(res, { error:'Número de conta inválido para STK Push.' }, 400)
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'recharge', bundleId:null, bundleLabel:`Recarga ${amount} MT`, phone:user.phone, beneficiaryPhone:null, msisdn, amount, method:meth, status:'pending', ref:null, error:null, sourceId:randomUUID(), ts:new Date().toISOString(), userId:user.id }
    transactions.set(txId, tx)
    trackOrder(tx)
    json(res, { txId, status:'pending', method:meth })
    initiateCharge(tx, `Recarga Megabyte ${amount} MT`)
    return
  }

  // ── Compra com crédito ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/buy-credit') {
    const user = checkUserCookie(req)
    if (!user) return json(res, { error:'Faça login para comprar com crédito.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { bundleId, beneficiaryPhone } = body
    const purchaseFor = String(body.purchaseFor || '').toLowerCase()
    const isSelfPurchase = purchaseFor === 'self' || (!purchaseFor && !beneficiaryPhone)
    const bundle = BUNDLES.get(bundleId)
    if (!bundle) return json(res, { error:'Pacote inválido.' }, 400)
    const beneficiary = isSelfPurchase ? normalizeLocalPhone(user.phone) : normalizeLocalPhone(beneficiaryPhone)
    if (!isSelfPurchase && beneficiary && detectMethod(normalizeMsisdn(beneficiary)) !== 'mpesa')
      return json(res, { error:'Número do beneficiário inválido. Use apenas uma faixa 84 ou 85.' }, 400)
    if ((user.balance||0) < bundle.price) return json(res, { error:`Saldo insuficiente. Tens ${user.balance||0} MT, precisas de ${bundle.price} MT.` }, 402)
    user.balance = (user.balance||0) - bundle.price
    await saveUsers()
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'bundle', bundleId, bundleLabel:bundle.label, phone:user.phone, beneficiaryPhone:beneficiary, msisdn:normalizeMsisdn(user.phone), amount:bundle.price, method:'credit', status:'succeeded', ref:'credit-'+txId, error:null, ts:new Date().toISOString(), userId:user.id }
    transactions.set(txId, tx)
    trackOrder(tx)
    await updateOrderStatus(txId, 'succeeded')
    return json(res, { ok:true, txId, newBalance:user.balance })
  }

  // ── Gateway: documentação para programadores ──────────────────────────────
  if (method === 'GET' && path === '/gateway/docs') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    return res.end(`GATEWAY DE PAGAMENTOS M-PESA — NET SERVIÇOS
=============================================
Documentação para integrar pagamentos M-Pesa (Moçambique) num site externo.
Base URL: ${SITE_URL}

AUTENTICAÇÃO
------------
Todos os pedidos levam o header:
  X-API-Key: gw_live_...          (chave fornecida pelo administrador)
Também existe um SEGREDO (gwsec_...) usado apenas para verificar callbacks (ver abaixo).
NUNCA exponha a chave nem o segredo no frontend/browser — use-os só no servidor.

1) INICIAR PAGAMENTO (STK Push — o cliente recebe o pedido de PIN no telemóvel)
-------------------------------------------------------------------------------
POST ${SITE_URL}/gateway/api/pay
Headers:
  Content-Type: application/json
  X-API-Key: gw_live_...
Corpo JSON:
  {
    "phone": "84xxxxxxx",             // obrigatório, número M-Pesa (84/85) ou e-Mola (86/87)
    "amount": 100,                    // obrigatório, valor inteiro em MT (meticais)
    "reference": "pedido-123",        // opcional, a sua referência interna (máx 64 chars)
    "description": "Compra na loja",  // opcional, guardada apenas nos registos internos (máx 120 chars)
    "callback_url": "https://seusite.com/api/pagamento-confirmado"  // opcional, HTTPS público
  }
Resposta 202:
  {
    "ok": true,
    "txId": "a1b2c3d4e5f6",
    "status": "pending",
    "method": "mpesa",
    "statusUrl": "${SITE_URL}/gateway/api/status/a1b2c3d4e5f6"
  }
Erros: 400 (dados inválidos), 401 (chave inválida/inactiva).

2) CONSULTAR ESTADO (polling)
-----------------------------
GET ${SITE_URL}/gateway/api/status/<txId>
Header: X-API-Key: gw_live_...
Resposta 200:
  {
    "ok": true, "txId": "...", "status": "pending" | "succeeded" | "failed",
    "amount": 100, "phone": "84xxxxxxx", "method": "mpesa",
    "reference": "pedido-123", "error": null | "motivo da falha", "ts": "2026-..."
  }
Recomendação: consultar a cada 3-5 segundos até status deixar de ser "pending".
O pagamento expira ao fim de 5 minutos se o cliente não introduzir o PIN (status "failed").

3) CALLBACK AUTOMÁTICO (opcional, recomendado)
----------------------------------------------
Se enviou "callback_url" no passo 1, quando o pagamento termina o gateway faz:
POST <callback_url>
Headers:
  Content-Type: application/json
  X-Gateway-Signature: <hmac>
Corpo JSON:
  {
    "event": "payment.succeeded" | "payment.failed",
    "txId": "...", "reference": "pedido-123",
    "amount": 100, "phone": "84xxxxxxx", "method": "mpesa",
    "error": null | "motivo", "ts": "2026-..."
  }
Responda com HTTP 2xx. Em caso de falha, o gateway tenta 3 vezes.

VERIFICAR A ASSINATURA do callback (Node.js):
  import { createHmac, timingSafeEqual } from 'crypto'
  // rawBody = corpo do pedido EXACTAMENTE como recebido (string, antes de JSON.parse)
  const esperado = createHmac('sha256', 'gwsec_...').update(rawBody).digest('hex')
  const recebido = req.headers['x-gateway-signature'] || ''
  const valido = recebido.length === esperado.length &&
    timingSafeEqual(Buffer.from(recebido), Buffer.from(esperado))
  // Se "valido" for false, ignore o callback (pode ser falso).
Mesmo com callback, confirme sempre com o endpoint de estado (passo 2) antes de entregar o produto.

EXEMPLO COMPLETO (curl)
-----------------------
curl -X POST ${SITE_URL}/gateway/api/pay \\
  -H "Content-Type: application/json" \\
  -H "X-API-Key: gw_live_SUA_CHAVE" \\
  -d '{"phone":"84xxxxxxx","amount":50,"reference":"pedido-1"}'

curl ${SITE_URL}/gateway/api/status/TXID_RECEBIDO \\
  -H "X-API-Key: gw_live_SUA_CHAVE"

NOTAS
-----
- Moeda: meticais (MT). M-Pesa Moçambique (números 84/85) ou e-Mola (86/87).
- Guarde o txId associado ao seu pedido para conferir o estado.
- Use "reference" para reconciliar os pagamentos com os seus pedidos.
- Estados finais: "succeeded" (pago) ou "failed" (falhou/expirou). Não há reversão automática.
`)
  }

  // ── Gateway: iniciar pagamento (API para terceiros) ──────────────────────
  if (method === 'POST' && path === '/gateway/api/pay') {
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const gk = gwAuth(req, body)
    if (!gk) return json(res, { error:'Chave de API inválida ou inactiva. Use o header X-API-Key.' }, 401)
    const amount = Math.round(Number(body.amount))
    if (!amount || amount < 1) return json(res, { error:'Valor (amount) inválido.' }, 400)
    const msisdn = normalizeMsisdn(body.phone), meth = detectMethod(msisdn)
    if (!meth) return json(res, { error:'Número inválido. Use M-Pesa 84/85 ou e-Mola 86/87.' }, 400)
    let callbackUrl = null
    if (body.callback_url) {
      callbackUrl = await gwValidateCallbackUrl(body.callback_url)
      if (!callbackUrl) return json(res, { error:'callback_url inválido. Use um endereço HTTPS público.' }, 400)
    }
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'gateway', bundleId:null, bundleLabel:`Gateway: ${gk.name}`, phone:String(body.phone), beneficiaryPhone:null, msisdn, amount, method:meth, status:'pending', ref:null, error:null, sourceId:randomUUID(), ts:new Date().toISOString(), gwKeyId:gk.id, extRef: body.reference ? String(body.reference).slice(0,64) : null, callbackUrl }
    transactions.set(txId, tx)
    trackOrder(tx, { gwKey: gk.name, gwKeyId: gk.id, extRef: tx.extRef, callbackUrl })
    json(res, { ok:true, txId, status:'pending', method:meth, statusUrl:`${SITE_URL}/gateway/api/status/${txId}` }, 202)
    if (body.description) tx.extDesc = String(body.description).slice(0,120)
    initiateCharge(tx, tx.extDesc || tx.extRef || 'Pagamento Megabyte')
    return
  }

  // ── Gateway: consultar estado ─────────────────────────────────────────────
  const gwStP = parseParams('/gateway/api/status/:txId', path)
  if (method === 'GET' && gwStP) {
    const gk = gwAuth(req, null)
    if (!gk) return json(res, { error:'Chave de API inválida ou inactiva. Use o header X-API-Key.' }, 401)
    const tx = transactions.get(gwStP.txId)
    if (tx && tx.type === 'gateway' && tx.gwKeyId === gk.id)
      return json(res, { ok:true, txId:tx.id, status:tx.status, amount:tx.amount, phone:tx.phone, method:tx.method, reference:tx.extRef, error:tx.error||null, ts:tx.ts })
    // fallback: após reinício do servidor, procura no registo persistente
    const rec = orders.find(o => o.txId === gwStP.txId && o.type === 'gateway' && o.gwKeyId === gk.id)
    if (!rec) return json(res, { error:'Transacção não encontrada.' }, 404)
    return json(res, { ok:true, txId:rec.txId, status:rec.status, amount:rec.amount, phone:rec.phone, method:rec.method, reference:rec.extRef||null, error:null, ts:rec.ts })
  }

  // ── Admin: gestão de chaves do gateway ────────────────────────────────────
  if (path === '/admin/gateway/keys' && method === 'POST') {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const name = String(body.name||'').trim()
    if (!name) return json(res, { error:'Nome do projecto é obrigatório.' }, 400)
    const rec = { id: randomBytes(6).toString('hex'), name, key: 'gw_live_'+randomBytes(24).toString('hex'), secret: 'gwsec_'+randomBytes(24).toString('hex'), active: true, createdAt: new Date().toISOString(), txCount: 0, totalAmount: 0 }
    gwKeys.push(rec)
    await saveGwKeys()
    return json(res, { ok:true, key: rec }, 201)
  }
  const gwKeyP = parseParams('/admin/gateway/keys/:id/:action', path)
  if (method === 'POST' && gwKeyP) {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    const rec = gwKeys.find(g => g.id === gwKeyP.id)
    if (!rec) return json(res, { error:'Chave não encontrada.' }, 404)
    if (gwKeyP.action === 'toggle') { rec.active = !rec.active; await saveGwKeys(); return json(res, { ok:true, active:rec.active }) }
    if (gwKeyP.action === 'rename') {
      let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
      const newName = String(body.name || '').trim()
      if (!newName) return json(res, { error:'Nome é obrigatório.' }, 400)
      rec.name = newName; await saveGwKeys(); return json(res, { ok:true, name:rec.name })
    }
    if (gwKeyP.action === 'delete') {
      if (rec.builtin) return json(res, { error:'A chave principal é fixa e não pode ser eliminada. Pode desactivá-la.' }, 400)
      gwKeys = gwKeys.filter(g => g.id !== rec.id); await saveGwKeys(); return json(res, { ok:true })
    }
    return json(res, { error:'Acção inválida.' }, 400)
  }

  // ── Admin: editar utilizador ──────────────────────────────────────────────
  if (method === 'POST' && path.startsWith('/admin/users/')) {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    const uid = path.split('/')[3]
    const user = findUserById(uid)
    if (!user) return json(res, { error:'Utilizador não encontrado.' }, 404)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    if (body.name  !== undefined) user.name  = String(body.name).trim()
    if (body.phone !== undefined) user.phone = String(body.phone).replace(/\D/g,'')
    if (body.balanceDelta !== undefined) user.balance = Math.max(0, (user.balance||0) + Number(body.balanceDelta))
    if (body.newPassword  && body.newPassword.length >= 6) {
      user.salt = randomBytes(16).toString('hex')
      user.passwordHash = hashPwd(body.newPassword, user.salt)
    }
    await saveUsers()
    return json(res, { ok:true, user:{ id:user.id, name:user.name, phone:user.phone, balance:user.balance } })
  }

  // ── Admin panel ───────────────────────────────────────────────────────────
  if (path === '/admin/office') {
    if (method === 'GET') {
      if (!checkAdminCookie(req)) return html(res, adminLoginPage())
      await refreshPagarForwardingStates()
      await refreshDeliveryStates()
      const q = parseQuery(req)
      return html(res, adminDashboard(q.filter || 'all', q.page))
    }
    if (method === 'POST') {
      const ip = (req.headers['x-forwarded-for']||'').split(',')[0].trim() || req.socket?.remoteAddress || 'unknown'
      const lockMsg = checkBruteForce(ip)
      if (lockMsg) return html(res, adminLoginPage(lockMsg))
      let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
      if (body.password && safeEqual(body.password, ADMIN_PASS)) {
        clearLoginAttempts(ip)
        const token = adminToken()
        return redirect(res, '/admin/office', { 'Set-Cookie': `nsa=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=86400` })
      }
      const remaining = recordFailedLogin(ip)
      const hint = remaining > 0 ? ` ${remaining} tentativa(s) restante(s).` : ' Conta bloqueada por 15 min.'
      return html(res, adminLoginPage('Senha incorrecta.' + hint))
    }
  }

  if (method === 'POST' && path === '/admin/activate') {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const rec = orders.find(o => o.txId === body.txId)
    if (!rec || rec.type !== 'bundle') return json(res, { error:'Encomenda Megabyte não encontrada.' }, 404)
    rec.status = 'activated'; rec.activatedAt = new Date().toISOString()
    await saveOrders()
    return json(res, { ok:true })
  }

  if (method === 'POST' && path === '/admin/retry-delivery') {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const rec = orders.find(o => o.txId === body.txId)
    if (!rec || rec.type !== 'bundle') return json(res, { error:'Encomenda não encontrada.' }, 404)
    if (rec.status !== 'succeeded' && rec.status !== 'activated') {
      return json(res, { error:'Só pagamentos confirmados podem ser reenviados.' }, 400)
    }
    try {
      const delivery = await retryUssdDelivery(rec)
      Object.assign(rec, {
        deliveryId: delivery.id,
        deliveryStatus: delivery.status,
        deliveryFailureReason: null,
      })
      if (rec.status === 'activated' && delivery.status !== 'completed') {
        rec.status = 'succeeded'
        rec.activatedAt = null
      }
      await saveOrders()
      return json(res, { ok:true, delivery })
    } catch (e) {
      rec.deliveryStatus = 'failed'
      rec.deliveryFailureReason = e.message || 'Não foi possível repetir a entrega USSD.'
      await saveOrders()
      return json(res, { error:rec.deliveryFailureReason }, 502)
    }
  }

  if (method === 'POST' && path === '/admin/retry-pagar-forwarding') {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const eventId = String(body.eventId || '')
    const mainPort = process.env.MAIN_API_PORT
    const secret = process.env.SESSION_SECRET
    if (!eventId || !mainPort || !secret) return json(res, { error:'Encaminhamento Pagar não configurado.' }, 400)
    try {
      const upstream = await fetch(`http://localhost:${mainPort}/api/pagar/admin/webhook-deliveries/${encodeURIComponent(eventId)}/retry`, {
        method: 'POST',
        headers: { 'x-internal-payment-key': secret },
        signal: AbortSignal.timeout(5000),
      })
      const data = await upstream.json().catch(() => ({}))
      if (!upstream.ok) return json(res, { error: data.error || 'Não foi possível repetir o encaminhamento.' }, 502)
      return json(res, { ok:true, event:data.event })
    } catch (e) {
      return json(res, { error: e.message || 'Não foi possível contactar o servidor de pagamentos.' }, 502)
    }
  }

  if (method === 'POST' && path === '/admin/manual-credit') {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const phone   = String(body.phone || '').replace(/\D/g,'')
    const amount  = Math.round(Number(body.amount))
    const zumboRef = String(body.zumboRef || '').trim()
    if (!phone || phone.length < 9)  return json(res, { error:'Número de telefone inválido.' }, 400)
    if (!amount || amount < 1)       return json(res, { error:'Valor inválido.' }, 400)
    if (!zumboRef)                   return json(res, { error:'Referência ZumboPay obrigatória.' }, 400)
    // Evitar duplicados pela referência ZumboPay
    if (orders.some(o => o.zumboRef === zumboRef && o.status === 'succeeded')) {
      return json(res, { error:`Referência ${zumboRef} já foi creditada anteriormente.` }, 409)
    }
    const u = findUserByPhone(phone) || users.find(u => u.phone === phone || u.phone === '258'+phone || ('258'+u.phone) === phone)
    if (!u) return json(res, { error:`Utilizador com número ${phone} não encontrado.` }, 404)
    u.balance = (u.balance || 0) + amount
    await saveUsers()
    // Registar no histórico de ordens
    const txId = randomBytes(6).toString('hex')
    const rec = { txId, type:'manual-credit', phone: u.phone, beneficiaryPhone: null, bundleId: null,
      bundleLabel:`Crédito Manual ${amount} MT`, amount, method:'manual', status:'succeeded',
      ts: new Date().toISOString(), activatedAt: new Date().toISOString(), userId: u.id,
      zumboRef, adminNote: `Crédito manual pelo admin — ref ZumboPay: ${zumboRef}` }
    orders.unshift(rec)
    await saveOrders()
    console.log(`[Admin] Crédito manual: ${u.phone} +${amount} MT ref:${zumboRef} novo saldo:${u.balance}`)
    return json(res, { ok:true, phone: u.phone, name: u.name, newBalance: u.balance })
  }

  if (method === 'GET' && path === '/admin/logout') {
    return redirect(res, '/admin/office', { 'Set-Cookie': 'nsa=; Path=/; Max-Age=0' })
  }

  if (method === 'GET' && path === '/admin/orders.json') {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    return json(res, orders)
  }

  if (method === 'GET' && (path === '/admin/history/export' || path === '/admin/export')) {
    if (!checkAdminCookie(req)) return json(res, { error:'Não autorizado.' }, 401)
    const q = parseQuery(req)
    const type = String(q.type || q.scope || '').toLowerCase()
    if (type !== 'megabyte' && type !== 'gateway') {
      return json(res, { error:'Tipo de histórico inválido.' }, 400)
    }
    const filename = `historico-${type}.csv`
    const body = `\uFEFF${historyCsv(type)}`
    res.writeHead(200, {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': Buffer.byteLength(body),
      'Cache-Control': 'no-store',
    })
    return res.end(body)
  }

  // ── API pública de transações (Bearer token = ADMIN_PASS ou cookie admin) ────
  if (method === 'GET' && path === '/api/transactions') {
    const auth  = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const authed = checkAdminCookie(req) || (token && safeEqual(token, ADMIN_PASS))
    if (!authed) return json(res, { error:'Não autorizado. Inclua o header: Authorization: Bearer <senha_admin>' }, 401)
    const q     = parseQuery(req)
    const page  = Math.max(1, parseInt(q.page)  || 1)
    const limit = Math.min(100, Math.max(1, parseInt(q.limit) || 50))
    const megabyteTransactions = orders.filter(o => o.type !== 'gateway')
    const total = megabyteTransactions.length
    const data  = megabyteTransactions.slice((page - 1) * limit, page * limit).map(o => ({
      id:          o.txId,
      phone:       o.phone,
      beneficiary: o.beneficiaryPhone || o.phone,
      amount:      o.amount,
      method:      o.method,
      bundle:      o.bundleLabel || null,
      status:      o.status,
      ts:          o.ts,
      activatedAt: o.activatedAt || null,
    }))
    return json(res, { ok:true, total, page, limit, pages: Math.ceil(total/limit), data })
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
<title>Megas — Megabyte</title>
<link rel="canonical" href="${SITE_URL}/megas">
<meta property="og:title" content="Megabyte — Pacotes de Internet">
<meta property="og:description" content="Ofertas de internet Vodacom com pagamento M-Pesa. Activa o teu pacote em segundos.">
<meta property="og:url" content="${SITE_URL}/megas">
<meta property="og:image" content="${SITE_URL}/static/icon-512.png">
<meta property="og:type" content="website">
<link rel="icon" href="/static/icon-192.png?v=4" type="image/png" sizes="192x192">
<link rel="manifest" href="/manifest.json">
<meta name="theme-color" content="#cc0000">
<meta name="mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="apple-mobile-web-app-title" content="Megabyte">
<link rel="apple-touch-icon" href="/static/icon-192.png?v=4">
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

/* ── Footer (dark) ── */
.site-footer{background:#1c1c1e;border-top:none;padding:32px 20px 0;}
.footer-top{display:flex;align-items:flex-start;justify-content:space-between;margin-bottom:24px;}
.footer-brand{display:flex;align-items:center;gap:10px;}
.footer-logo-wrap{width:36px;height:36px;border-radius:8px;background:#1c1c1e;overflow:hidden;flex-shrink:0;}
.footer-logo-img{width:36px;height:36px;object-fit:contain;display:block;mix-blend-mode:screen;}
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
.footer-support{margin-bottom:24px;}
.footer-support-title{font-size:11px;font-weight:700;color:#636366;letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px;}
.footer-support-cards{display:flex;flex-direction:column;gap:8px;}
.footer-support-card{display:flex;align-items:center;gap:12px;background:#2c2c2e;border-radius:10px;padding:9px 14px;text-decoration:none;transition:background .15s;}
.footer-support-card:active{background:#3a3a3c;}
.footer-support-icon{width:32px;height:32px;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;}
.footer-support-icon svg{width:16px;height:16px;}
.footer-support-icon.phone{background:#34c759;}
.footer-support-icon.phone svg{stroke:#fff;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
.footer-support-icon.whatsapp{background:#25d366;}
.footer-support-icon.whatsapp svg{fill:#fff;}
.footer-support-label{font-size:12px;font-weight:600;color:#f2f2f7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.footer-copy{font-size:12px;color:#48484a;line-height:1.7;}

/* ── Banner instalar PWA ── */
.pwa-banner{display:none;position:fixed;bottom:0;left:0;right:0;z-index:400;background:#fff;border-top:1px solid #e5e5ea;padding:12px 16px;align-items:center;gap:12px;box-shadow:0 -4px 20px rgba(0,0,0,.12);}
.pwa-banner.show{display:flex;}
.pwa-banner-icon{flex-shrink:0;width:44px;height:44px;border-radius:10px;overflow:hidden;background:#cc0000;display:flex;align-items:center;justify-content:center;}
.pwa-banner-icon img{width:100%;height:100%;object-fit:cover;}
.pwa-banner-text{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;}
.pwa-banner-text strong{font-size:14px;font-weight:700;color:#1c1c1e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pwa-banner-text span{font-size:12px;color:#636366;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.pwa-banner-install{flex-shrink:0;padding:8px 18px;border-radius:8px;background:#cc0000;color:#fff;font-size:13px;font-weight:700;font-family:inherit;border:none;cursor:pointer;}
.pwa-banner-install:active{background:#a00000;}
.pwa-banner-close{flex-shrink:0;background:none;border:none;cursor:pointer;padding:6px;color:#636366;display:flex;align-items:center;justify-content:center;}
.pwa-banner-close svg{width:18px;height:18px;}

/* ── Veja mais ofertas ── */
.more-offers{padding:32px 16px 8px;max-width:480px;margin:0 auto;}
.more-offers-title{font-size:18px;font-weight:800;color:#1c1c1e;margin-bottom:20px;text-align:center;}
.more-offers-list{display:flex;flex-direction:column;gap:18px;}
.mo-card{background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 2px 10px rgba(0,0,0,.09);border:1px solid #e5e5ea;}
.mo-img-wrap{width:100%;aspect-ratio:4/3;overflow:hidden;background:#f2f2f7;}
.mo-img{width:100%;height:100%;object-fit:cover;display:block;}
.mo-body{padding:16px 16px 14px;}
.mo-name{font-size:20px;font-weight:700;color:#1c1c1e;margin-bottom:6px;}
.mo-desc{font-size:14px;color:#3a3a3c;line-height:1.5;margin-bottom:14px;}
.mo-footer{display:flex;align-items:center;justify-content:space-between;}
.mo-price{font-size:14px;font-weight:800;color:#1c1c1e;}
.mo-btn{padding:8px 20px;border-radius:8px;border:1.5px solid #1c1c1e;background:#fff;color:#1c1c1e;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;transition:background .12s,color .12s;}
.mo-btn:active{background:#1c1c1e;color:#fff;}

/* ── Modal de detalhe ── */
.mo-modal{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:300;overflow-y:auto;}
.mo-modal.open{display:block;}
.mo-modal-inner{background:#fff;min-height:100%;display:flex;flex-direction:column;}
.mo-modal-hero{position:relative;width:100%;aspect-ratio:4/3;background:#f2f2f7;overflow:hidden;}
.mo-modal-img{width:100%;height:100%;object-fit:cover;display:block;}
.mo-modal-close{position:absolute;top:14px;right:14px;width:36px;height:36px;border-radius:50%;background:rgba(0,0,0,.45);border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;}
.mo-modal-close svg{width:18px;height:18px;stroke:#fff;}
.mo-modal-body{padding:24px 20px 48px;background:#f9f9f9;flex:1;}
.mo-modal-bread{font-size:12px;color:#636366;margin-bottom:20px;line-height:1.4;}
.mo-bread-link{color:#636366;text-decoration:none;}
.mo-bread-link:active{text-decoration:underline;}
.mo-bread-current{color:#cc0000;font-weight:700;}
.mo-modal-name{font-size:22px;font-weight:800;color:#1c1c1e;margin-bottom:14px;text-align:center;}
.mo-modal-text{font-size:15px;color:#3a3a3c;line-height:1.7;text-align:justify;}

/* ── Note banner ── */
.cat-note{margin:0 20px 16px;padding:10px 14px;background:#fff3cd;border:1px solid #ffc107;border-radius:10px;font-size:12px;color:#856404;line-height:1.5;display:none;}
.cat-note.show{display:block;}

/* ── Bottom sheet (Vodacom style) ── */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:100;display:none;backdrop-filter:blur(4px);}
.overlay.open{display:block;}
.sheet{position:fixed;bottom:0;left:0;right:0;max-width:480px;margin:0 auto;background:#fff;border-radius:22px 22px 0 0;z-index:101;padding:0;transform:translateY(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);height:min(92dvh,720px);max-height:92dvh;overflow:hidden;display:flex;flex-direction:column;touch-action:pan-y;}
.sheet.open{transform:translateY(0);}
.sheet>div[id^="s-"]{min-height:0;overflow-y:auto;overscroll-behavior:contain;-webkit-overflow-scrolling:touch;padding-bottom:env(safe-area-inset-bottom);}
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
.sh-next{position:sticky;bottom:0;width:calc(100% - 32px);margin:16px 16px max(18px, env(safe-area-inset-bottom));padding:17px;border:none;border-radius:14px;font-size:16px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,#e53935,#cc0000);color:#fff;transition:opacity .2s;box-shadow:0 -10px 18px rgba(255,255,255,.92);}
.sh-next:disabled{opacity:.45;cursor:not-allowed;}
.sh-next:active{opacity:.85;}
.sh-hint{display:block;font-size:12px;color:#8e8e93;margin-top:-10px;margin-bottom:14px;padding:0 2px;}
.sh-recipient{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:0 2px 4px;padding:12px 14px;border:1px solid #e5e5ea;border-radius:12px;background:#f8f8fa;}
.sh-recipient-label{font-size:12px;color:#636366;}
.sh-recipient-phone{font-size:14px;font-weight:700;color:#1c1c1e;white-space:nowrap;}
/* states: pending / success / failed */
.sh-state{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:10px 20px 44px;text-align:center;}
.sheet.pending-full{bottom:auto!important;top:50%!important;left:50%!important;right:auto!important;width:88%!important;max-width:380px!important;height:auto!important;max-height:calc(100dvh - 40px)!important;margin:0!important;border-radius:22px!important;overflow-y:auto!important;box-shadow:0 20px 60px rgba(0,0,0,.24);transform:translate(-50%,-50%)!important;}
#s-pending{display:flex;flex-direction:column;}
#s-pending .sh-state{padding:32px 24px 40px;}
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

/* ── Balance pill no nav ── */
.nav-balance{display:none;align-items:center;gap:6px;background:#fff0f0;border:1px solid #ffcdd2;border-radius:20px;padding:5px 6px 5px 12px;flex:1;max-width:220px;margin:0 6px;}
.nav-bal-ico{width:16px;height:16px;flex-shrink:0;object-fit:contain;}
.nav-bal-val{font-size:13px;font-weight:700;color:#cc0000;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;}
.nav-rech-btn{background:#cc0000;color:#fff;border:none;border-radius:14px;padding:5px 11px;font-size:11px;font-weight:700;font-family:inherit;cursor:pointer;white-space:nowrap;flex-shrink:0;}
.nav-rech-btn:active{opacity:.85;}

/* ── Drawer auth ── */
.drawer-auth-row{display:flex;gap:8px;padding:4px 16px 12px;}
.drawer-auth-btn{flex:1;display:flex;align-items:center;justify-content:center;gap:7px;padding:10px 12px;border-radius:12px;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;border:none;transition:opacity .12s;}
.drawer-auth-btn svg{width:16px;height:16px;flex-shrink:0;}
.drawer-auth-btn--primary{background:#cc0000;color:#fff;}
.drawer-auth-btn--primary:active{opacity:.82;}
.drawer-auth-btn--secondary{background:#f2f2f7;color:#1c1c1e;border:1.5px solid #e5e5ea;}
.drawer-auth-btn--secondary:active{background:#e5e5ea;}
.drawer-user-row{padding:14px 20px;display:flex;flex-direction:column;gap:4px;background:#f9f9fb;}
.drawer-user-name{font-size:14px;font-weight:700;color:#1c1c1e;}
.drawer-user-phone{font-size:12px;color:#636366;}
.drawer-user-bal{font-size:13px;color:#cc0000;font-weight:700;}

/* ── Método de pagamento (via-btns) ── */
.via-section{padding:4px 16px 12px;}
.via-section-lbl{font-size:11px;font-weight:700;color:#8e8e93;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;padding:0 2px;}
 .via-btns{display:flex;gap:8px;width:100%;}
 .via-btn{flex:1;display:flex;align-items:center;gap:8px;padding:12px 10px;border-radius:10px;border:1.5px solid #e5e5ea;background:#fff;cursor:pointer;font-family:inherit;text-align:left;transition:border-color .15s,background .15s;}
 .via-btn.active{border-color:#cc0000;background:#fff0f0;}
.via-btn:disabled{opacity:.45;cursor:not-allowed;}
.via-btn-icon{flex-shrink:0;display:flex;align-items:center;justify-content:center;}
.via-btn-icon svg{width:16px;height:16px;}
.via-btn-label{font-size:12px;font-weight:700;color:#1c1c1e;line-height:1.2;}
.via-btn-sub{font-size:11px;color:#8e8e93;margin-top:1px;}
.via-btn.active .via-btn-label{color:#cc0000;}
.via-btn.active .via-btn-sub{color:#cc0000;}
.profile-section-title{font-size:14px;font-weight:800;color:#1c1c1e;margin:4px 0 12px;}
.profile-section-heading{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;}
.profile-section-heading .profile-section-title{margin:4px 0;}
.profile-edit-btn{width:34px;height:34px;display:flex;align-items:center;justify-content:center;border:1px solid #e5e5ea;border-radius:10px;background:#fff;color:#cc0000;cursor:pointer;transition:background .15s,border-color .15s;}
.profile-edit-btn:hover,.profile-edit-btn:focus-visible{background:#fff0f0;border-color:#ffcdd2;outline:none;}
.profile-edit-btn svg{width:18px;height:18px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round;}
.profile-summary{display:flex;flex-direction:column;gap:12px;padding:14px 16px;background:#f8f8fa;border:1px solid #e5e5ea;border-radius:14px;}
.profile-summary-row{display:flex;align-items:center;justify-content:space-between;gap:16px;}
.profile-summary-row span{font-size:13px;color:#8e8e93;}
.profile-summary-row strong{font-size:15px;color:#1c1c1e;text-align:right;overflow-wrap:anywhere;}
.profile-edit-form{display:flex;flex-direction:column;gap:12px;}
.profile-edit-form .auth-inp{margin:0;}
.profile-edit-hint{font-size:12px;color:#8e8e93;margin-top:-4px;}
.profile-edit-actions{display:flex;gap:10px;}
.profile-edit-actions button{flex:1;}
.profile-cancel-btn{padding:15px;border:1.5px solid #e5e5ea;border-radius:14px;background:#fff;color:#636366;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;}
.profile-cancel-btn:active{background:#f2f2f7;}
.profile-save-btn{margin:0;}
.profile-divider{height:1px;background:#e5e5ea;margin:8px 0 18px;}
.via-credit-bal{display:block;font-size:11px;font-weight:700;color:#065f46;margin-top:1px;}

/* ── Auth modal ── */
.auth-modal{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:500;display:none;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);}
.auth-card{background:#fff;border-radius:24px;width:100%;max-width:380px;max-height:calc(100dvh - 40px);box-shadow:0 20px 60px rgba(0,0,0,.2);transform:translateY(30px) scale(.97);opacity:0;transition:transform .28s cubic-bezier(.32,.72,0,1),opacity .2s;overflow-y:auto;}
.auth-card.open{transform:translateY(0) scale(1);opacity:1;}
.auth-card-head{padding:24px 24px 0;text-align:center;}
.auth-card-logo{width:48px;height:48px;object-fit:contain;margin:0 auto 8px;}
.auth-card-title{font-size:20px;font-weight:800;color:#1c1c1e;margin-bottom:4px;}
.auth-card-sub{font-size:13px;color:#8e8e93;}
.auth-tabs{display:flex;gap:0;margin:18px 24px 0;border-radius:12px;overflow:hidden;background:#f2f2f7;}
.auth-tab{flex:1;padding:10px;border:none;background:none;font-size:13px;font-weight:600;color:#8e8e93;cursor:pointer;font-family:inherit;border-radius:12px;transition:background .15s,color .15s;}
.auth-tab.active{background:#fff;color:#cc0000;box-shadow:0 1px 4px rgba(0,0,0,.1);}
.auth-body{padding:20px 24px 24px;display:flex;flex-direction:column;gap:12px;}
.auth-inp{width:100%;padding:14px 16px;border:1.5px solid #e5e5ea;border-radius:14px;font-size:15px;font-family:inherit;color:#1c1c1e;outline:none;background:#fff;transition:border-color .15s;}
.auth-inp:focus{border-color:#cc0000;}
.auth-inp::placeholder{color:#c7c7cc;}
.auth-btn{width:100%;padding:15px;border:none;border-radius:14px;background:#cc0000;color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;transition:opacity .15s;}
.auth-btn:disabled{opacity:.5;cursor:not-allowed;}
.auth-btn:not(:disabled):active{opacity:.85;}
.auth-switch{text-align:center;font-size:13px;color:#8e8e93;}
.auth-switch a{color:#cc0000;font-weight:600;text-decoration:none;cursor:pointer;}
.auth-err{background:#fff0f0;border:1px solid #ffcdd2;border-radius:10px;padding:10px 14px;font-size:13px;color:#cc0000;display:none;}
.auth-close{position:absolute;top:16px;right:16px;background:none;border:none;cursor:pointer;color:#8e8e93;padding:6px;border-radius:8px;}
.auth-close:active{background:#f2f2f7;}
.auth-card-wrap{position:relative;}
 .profile-modal{padding:0;align-items:stretch;justify-content:stretch;background:#fff;backdrop-filter:none;}
 .profile-modal .auth-card-wrap{width:100%;height:100%;}
 .profile-modal .auth-card{width:100%;max-width:none;height:100%;max-height:none;border-radius:0;box-shadow:none;overflow-y:auto;}
 .profile-modal .auth-card-head{text-align:left;padding:28px 24px 0;}
 .profile-modal .auth-card-head>div:first-child{justify-content:flex-start!important;}

/* ── Recharge modal (reutiliza .auth-modal + .auth-card) ── */
.rech-amount-wrap{position:relative;}
.rech-amount-prefix{position:absolute;left:16px;top:50%;transform:translateY(-50%);font-size:15px;font-weight:700;color:#1c1c1e;}
.rech-inp{padding-left:40px;}

/* ── Success credit ── */
.credit-badge{display:inline-flex;align-items:center;gap:5px;background:#fff0f0;border:1px solid #ffcdd2;border-radius:20px;padding:4px 12px;font-size:12px;font-weight:700;color:#cc0000;margin-bottom:14px;}
</style>
</head><body>

<nav class="nav">
  <a href="/" class="nav-logo">
    <img src="/static/vodacom.webp" alt="Megabyte" class="nav-logo-img">
    <div class="nav-logo-text">Mega<span>byte</span></div>
  </a>
  <div id="nav-balance" class="nav-balance">
    <img src="/static/coins.png" class="nav-bal-ico" alt="saldo">
    <span class="nav-bal-val" id="nav-bal-val">0 MT</span>
    <button class="nav-rech-btn" onclick="openRechargeDialog()">Recarregar</button>
  </div>
  <div class="nav-right">
    <button class="nav-icon-btn" id="nav-search-btn" onclick="openSearch()" aria-label="Pesquisar">
      <svg viewBox="0 0 24 24"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
    </button>
    <button class="nav-icon-btn" onclick="openDrawer()" aria-label="Menu">
      <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
  </div>
</nav>
${isTestMode ? '<div style="background:#fff3cd;color:#664d03;border-bottom:1px solid #ffecb5;padding:9px 16px;text-align:center;font-size:12px;font-weight:700;">MODO DE TESTE — os pagamentos desta preview são simulados e não movimentam dinheiro.</div>' : ''}

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
    <div class="drawer-brand">Mega<span>byte</span></div>
  </div>
  <ul class="drawer-menu">
    <li><a href="/">
      <span class="dm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 01-2 2H5a2 2 0 01-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg></span>
      Início
    </a></li>
    <li><a href="/megas">
      <span class="dm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12.55a11 11 0 0114.08 0M1.42 9a16 16 0 0121.16 0M8.53 16.11a6 6 0 016.95 0M12 20h.01"/></svg></span>
      Pacotes de Internet
    </a></li>
    <div class="drawer-divider"></div>
    <!-- Logged out -->
    <div id="drawer-logged-out">
      <div class="drawer-auth-row">
        <button class="drawer-auth-btn drawer-auth-btn--primary" onclick="closeDrawer();openAuthDialog('register')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 00-4-4H6a4 4 0 00-4 4v2"/><circle cx="9" cy="7" r="4"/><line x1="19" y1="8" x2="19" y2="14"/><line x1="22" y1="11" x2="16" y2="11"/></svg>
          Criar Conta
        </button>
        <button class="drawer-auth-btn drawer-auth-btn--secondary" onclick="closeDrawer();openAuthDialog('login')">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4"/><polyline points="10 17 15 12 10 7"/><line x1="15" y1="12" x2="3" y2="12"/></svg>
          Entrar
        </button>
      </div>
    </div>
    <!-- Logged in -->
    <div id="drawer-logged-in" style="display:none">
      <li class="drawer-user-row">
        <span class="drawer-user-name" id="drawer-user-name">—</span>
        <span class="drawer-user-phone" id="drawer-user-phone">—</span>
        <span class="drawer-user-bal" id="drawer-user-bal">0 MT</span>
      </li>
      <li><a href="#" onclick="closeDrawer();openProfileDialog()">
        <span class="dm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0116 0"/></svg></span>
        Meu Perfil
      </a></li>
      <li><a href="#" onclick="closeDrawer();openRechargeDialog()">
        <span class="dm-icon"><img src="/static/coins.png" style="width:20px;height:20px;vertical-align:middle" alt="saldo"></span>
        Recarregar Saldo
      </a></li>
      <li><a href="#" onclick="logoutUser()">
        <span class="dm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg></span>
        Sair da Conta
      </a></li>
    </div>
    <div class="drawer-divider"></div>
    <li><a href="#" onclick="closeDrawer()">
      <span class="dm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
      Fechar menu
    </a></li>
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

<!-- ── Veja mais ofertas ── -->
<section class="more-offers" id="mais-ofertas">
  <h2 class="more-offers-title">Veja mais ofertas</h2>
  <div class="more-offers-list">

    <div class="mo-card">
      <div class="mo-img-wrap"><img src="/static/offer-soprati.webp" alt="Ofertas SóPraTi" class="mo-img"></div>
      <div class="mo-body">
        <div class="mo-name">Ofertas SóPraTi</div>
        <div class="mo-desc">Serviço de Ofertas personalizadas de acordo com o perfil de cada cliente.</div>
        <div class="mo-footer">
          <span class="mo-price">A partir de 20 MT</span>
          <button class="mo-btn" onclick="openOffer('soprati')">Ver mais</button>
        </div>
      </div>
    </div>

    <div class="mo-card">
      <div class="mo-img-wrap"><img src="/static/offer-ya.webp" alt="Yá" class="mo-img"></div>
      <div class="mo-body">
        <div class="mo-name">Yá</div>
        <div class="mo-desc">Mais megas e minutos para a malta jovem.</div>
        <div class="mo-footer">
          <span class="mo-price">A partir de 2 MT</span>
          <button class="mo-btn" onclick="openOffer('ya')">Ver mais</button>
        </div>
      </div>
    </div>

    <div class="mo-card">
      <div class="mo-img-wrap"><img src="/static/offer-bomdia.webp" alt="Bom Dia" class="mo-img"></div>
      <div class="mo-body">
        <div class="mo-name">Bom Dia</div>
        <div class="mo-desc">Bom Dia é o serviço em que podes activar uma oferta de Voz ou Dados, diariamente, no horário das 0h as 12h.</div>
        <div class="mo-footer">
          <span class="mo-price">A partir de 2 MT</span>
          <button class="mo-btn" onclick="openOffer('bomdia')">Ver mais</button>
        </div>
      </div>
    </div>

    <div class="mo-card">
      <div class="mo-img-wrap"><img src="/static/offer-turnonoite.webp" alt="Turno da Noite" class="mo-img"></div>
      <div class="mo-body">
        <div class="mo-name">Turno da Noite</div>
        <div class="mo-desc">As melhores ofertas para manter aquele papo durante à noite.</div>
        <div class="mo-footer">
          <span class="mo-price">A partir de 5 MT</span>
          <button class="mo-btn" onclick="openOffer('turnonoite')">Ver mais</button>
        </div>
      </div>
    </div>

    <div class="mo-card">
      <div class="mo-img-wrap"><img src="/static/offer-jackpot.webp" alt="Todas Redes Jackpot" class="mo-img"></div>
      <div class="mo-body">
        <div class="mo-name">Todas Redes Jackpot</div>
        <div class="mo-desc">É uma oferta de voz para todas as redes que permite aumentar as tuas chamadas em até 4X mais.</div>
        <div class="mo-footer">
          <span class="mo-price">A partir de 2 MT</span>
          <button class="mo-btn" onclick="openOffer('jackpot')">Ver mais</button>
        </div>
      </div>
    </div>

  </div>
</section>

<!-- ── Banner instalar app ── -->
<div class="pwa-banner" id="pwa-banner">
  <div class="pwa-banner-icon">
    <img src="/static/icon.svg" alt="Megabyte">
  </div>
  <div class="pwa-banner-text">
      <strong>Mega<span style="color:#cc0000">byte</span></strong>
    <span>Instala a app no teu telemóvel</span>
  </div>
  <button class="pwa-banner-install" id="pwa-install-btn">Instalar</button>
  <button class="pwa-banner-close" id="pwa-dismiss-btn" aria-label="Fechar">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
  </button>
</div>

<!-- Modal de detalhe de oferta -->
<div class="mo-modal" id="mo-modal" onclick="if(event.target===this)closeOffer()">
  <div class="mo-modal-inner" id="mo-modal-inner">
    <div class="mo-modal-hero">
      <img id="mo-modal-img" src="" alt="" class="mo-modal-img">
      <button class="mo-modal-close" onclick="closeOffer()">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
    </div>
    <div class="mo-modal-body">
      <div class="mo-modal-bread"><a href="/" class="mo-bread-link">Início</a> / <a href="#mais-ofertas" class="mo-bread-link" onclick="closeOffer();event.preventDefault();setTimeout(()=>{document.getElementById('mais-ofertas').scrollIntoView({behavior:'smooth'})},180)">Ofertas</a> / <span id="mo-modal-bread" class="mo-bread-current"></span></div>
      <h2 class="mo-modal-name" id="mo-modal-name"></h2>
      <p class="mo-modal-text" id="mo-modal-text"></p>
    </div>
  </div>
</div>

<footer class="site-footer">
  <div class="footer-top">
    <div class="footer-brand">
      <div class="footer-logo-wrap"><img src="/static/vodafone-logo.jpg" alt="Megabyte" class="footer-logo-img"></div>
      <div class="footer-brand-name">Mega<span>byte</span></div>
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
    <div class="footer-support">
      <p class="footer-support-title">Apoio ao Cliente</p>
      <div class="footer-support-cards">
        <a href="tel:876563910" class="footer-support-card">
          <div class="footer-support-icon phone">
            <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.09 9.8a19.79 19.79 0 01-3.07-8.67A2 2 0 012 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
          </div>
          <span class="footer-support-label">Suporte via Chamada</span>
        </a>
        <a href="https://wa.me/258876563910" target="_blank" rel="noopener" class="footer-support-card">
          <div class="footer-support-icon whatsapp">
            <svg viewBox="0 0 24 24" fill="#fff"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.118 1.528 5.847L.057 23.882a.5.5 0 00.606.63l6.266-1.643A11.94 11.94 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.907 0-3.686-.528-5.204-1.443l-.374-.22-3.878 1.018 1.037-3.785-.241-.389A9.96 9.96 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
          </div>
          <span class="footer-support-label">Suporte via WhatsApp</span>
        </a>
      </div>
    </div>
    <p class="footer-copy">© 2025 Megabyte · Todos os direitos reservados</p>
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
       <label class="sh-lbl">O seu número de pagamento</label>
       <input class="sh-inp" id="sh-phone" type="tel" placeholder="Número que vai pagar" maxlength="9" inputmode="numeric" autocomplete="off">
       <span class="sh-hint">M-Pesa: 84/85 · e-Mola: 86/87</span>
      <div class="sh-recipient">
        <span class="sh-recipient-label">Os megas serão enviados para</span>
        <strong class="sh-recipient-phone" id="sh-recipient-phone">—</strong>
      </div>
    </div>

    <!-- Tab: Para Outro -->
    <div class="sh-panel" id="sh-tab-outro" style="display:none">
       <label class="sh-lbl">Número de pagamento</label>
      <input class="sh-inp" id="sh-phone-payer" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric" autocomplete="off">
      <label class="sh-lbl">Introduza o número do beneficiário</label>
      <input class="sh-inp" id="sh-phone-bene" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric" autocomplete="off">
    </div>

    <!-- Tab: Requisitar -->
    <div class="sh-panel" id="sh-tab-req" style="display:none">
      <div style="text-align:center;padding:28px 0 12px">
        <div style="font-size:40px;margin-bottom:14px">🔔</div>
        <p style="font-size:14px;color:#636366;line-height:1.6">A funcionalidade <strong style="color:#1c1c1e">Requisitar Oferta</strong> não está disponível neste momento.</p>
      </div>
    </div>

    <!-- Método de pagamento -->
    <div class="via-section" id="via-section">
      <div class="via-section-lbl">Método de pagamento</div>
      <div class="via-btns">
        <button class="via-btn mobile-money active" data-via="mobile-money" onclick="selectPayVia('mobile-money')">
          <span class="via-btn-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
          </span>
          <div>
             <div class="via-btn-label">M-Pesa / e-Mola</div>
          </div>
        </button>
        <button class="via-btn" id="via-credit" data-via="credit" onclick="selectPayVia('credit')">
          <span class="via-btn-icon">
            <img src="/static/coins.png" style="width:18px;height:18px" alt="crédito">
          </span>
          <div>
            <div class="via-btn-label">Crédito</div>
          </div>
        </button>
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

  <!-- ── Compra com crédito: sucesso imediato ── -->
  <div id="s-success-credit" style="display:none">
    <div class="sh-top"><button class="sh-close" onclick="closeSheet()">✕</button></div>
    <div class="sh-state">
      <div class="res-icon ok">✓</div>
      <span class="credit-badge"><img src="/static/coins.png" style="width:14px;height:14px;vertical-align:middle;margin-right:4px" alt="">Pago com Crédito</span>
      <div class="res-t">Pedido recebido!</div>
      <p class="res-s">Crédito debitado. O seu pacote será activado em <strong style="color:#cc0000">5–15 minutos</strong>.</p>
      <div class="res-box"><div class="res-box-l">Pacote encomendado</div><div class="res-box-v" id="sh-ok-pkg-credit"></div></div>
      <button class="res-btn" onclick="closeSheet()">Comprar outro pacote</button>
    </div>
  </div>

  <!-- ── A aguardar PIN de recarga ── -->
  <div id="s-recharging" style="display:none">
    <div class="sh-top"><button class="sh-close" onclick="closeSheet()">✕</button></div>
    <div class="sh-state">
      <img src="/static/voda-anim.gif" class="voda-gif" alt="Aguardando">
      <p class="voda-pin-msg">Confirme o pagamento introduzindo o PIN <span id="rech-method-lbl">M-Pesa</span> no seu telemóvel</p>
    </div>
  </div>

  <!-- ── Recarga: sucesso ── -->
  <div id="s-recharge-ok" style="display:none">
    <div class="sh-top"><button class="sh-close" onclick="closeSheet()">✕</button></div>
    <div class="sh-state">
      <div class="res-icon ok">✓</div>
      <div class="res-t">Crédito adicionado!</div>
      <p class="res-s">O saldo foi actualizado na sua conta.</p>
      <div class="res-box"><div class="res-box-l">Novo saldo</div><div class="res-box-v" id="sh-rech-bal">—</div></div>
      <button class="res-btn" onclick="closeSheet()">Fechar</button>
    </div>
  </div>

  <!-- ── Recarga: falhou ── -->
  <div id="s-recharge-fail" style="display:none">
    <div class="sh-top"><button class="sh-close" onclick="closeSheet()">✕</button></div>
    <div class="sh-state">
      <div class="res-icon bad">✗</div>
      <div class="res-t">Recarga não confirmada</div>
      <p class="res-s">O PIN não foi introduzido ou o tempo expirou.</p>
      <button class="res-btn" onclick="closeSheet();openRechargeDialog()">Tentar novamente</button>
      <button class="res-btn res-btn-g" onclick="closeSheet()">Cancelar</button>
    </div>
  </div>

</div>

<!-- ── Modal: Auth (Criar Conta / Entrar) ── -->
<div class="auth-modal" id="auth-modal" onclick="if(event.target===this)closeAuthDialog()">
  <div class="auth-card-wrap">
    <div class="auth-card" id="auth-card">
      <button class="auth-close" onclick="closeAuthDialog()">
        <svg viewBox="0 0 24 24" style="width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="auth-card-head">
        <img src="/static/vodacom.webp" alt="logo" class="auth-card-logo">
        <div class="auth-card-title">Mega<span style="color:#cc0000">byte</span></div>
        <div class="auth-card-sub">Para comprar, precisa de uma conta</div>
      </div>
      <div class="auth-tabs">
        <button class="auth-tab active" onclick="authSetTab('register')">Criar Conta</button>
        <button class="auth-tab" onclick="authSetTab('login')">Entrar</button>
      </div>

      <!-- Criar Conta -->
      <div id="auth-panel-register" class="auth-body">
        <input class="auth-inp" id="reg-name" type="text" placeholder="Nome completo" autocomplete="name">
        <input class="auth-inp" id="reg-phone" type="tel" placeholder="Número de telemóvel (9 dígitos)" maxlength="9" inputmode="numeric">
        <input class="auth-inp" id="reg-pass" type="password" placeholder="Criar senha (mín. 6 caracteres)" autocomplete="new-password">
        <input class="auth-inp" id="reg-pass2" type="password" placeholder="Confirmar senha" autocomplete="new-password">
        <div class="auth-err" id="reg-err"></div>
        <button class="auth-btn" id="reg-btn" onclick="registerUser()">Criar Conta</button>
        <div class="auth-switch">Já tem conta? <a onclick="authSetTab('login')">Entrar</a></div>
      </div>

      <!-- Entrar -->
      <div id="auth-panel-login" class="auth-body" style="display:none">
        <input class="auth-inp" id="login-phone" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric">
        <input class="auth-inp" id="login-pass" type="password" placeholder="Senha" autocomplete="current-password">
        <div class="auth-err" id="login-err"></div>
        <button class="auth-btn" id="login-btn" onclick="loginUser()">Entrar</button>
        <div class="auth-switch">Não tem conta? <a onclick="authSetTab('register')">Criar Conta</a></div>
      </div>
    </div>
  </div>
</div>

<!-- ── Modal: Recarga de saldo ── -->
<div class="auth-modal" id="recharge-modal" onclick="if(event.target===this)closeRechargeDialog()">
  <div class="auth-card-wrap">
    <div class="auth-card" id="recharge-card">
      <button class="auth-close" onclick="closeRechargeDialog()">
        <svg viewBox="0 0 24 24" style="width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="auth-card-head">
        <div style="margin-bottom:12px;display:flex;justify-content:center"><img src="/static/coins.png" style="width:56px;height:56px" alt="saldo"></div>
        <div class="auth-card-title">Recarregar Saldo</div>
         <div class="auth-card-sub">M-Pesa ou e-Mola, conforme o seu número</div>
      </div>
      <div class="auth-body">
        <div class="rech-amount-wrap">
          <span class="rech-amount-prefix">MT</span>
           <input class="auth-inp rech-inp" id="rech-amount" type="number" min="20" placeholder="Mínimo 20 MT" inputmode="numeric">
        </div>
        <div class="auth-err" id="rech-err"></div>
         <button class="auth-btn" id="rech-btn" onclick="submitRecharge()">Continuar</button>
      </div>
    </div>
  </div>
</div>

<!-- ── Modal: Meu Perfil ── -->
<div class="auth-modal profile-modal" id="profile-modal" onclick="if(event.target===this)closeProfileDialog()">
  <div class="auth-card-wrap">
    <div class="auth-card" id="profile-card">
      <button class="auth-close" onclick="closeProfileDialog()">
        <svg viewBox="0 0 24 24" style="width:20px;height:20px;stroke:currentColor;fill:none;stroke-width:2.5;stroke-linecap:round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
      </button>
      <div class="auth-card-head">
        <div style="margin-bottom:12px;display:flex;justify-content:center"><span style="width:56px;height:56px;border-radius:50%;background:#fff0f0;color:#cc0000;display:flex;align-items:center;justify-content:center;font-size:26px">👤</span></div>
        <div class="auth-card-title">Meu Perfil</div>
        <div class="auth-card-sub">Consulta e actualiza os teus dados</div>
      </div>
      <div class="auth-body">
        <div class="profile-section-heading">
          <div class="profile-section-title">Dados pessoais</div>
          <button class="profile-edit-btn" id="profile-edit-btn" type="button" onclick="startProfileEdit()" aria-label="Editar dados pessoais" title="Editar dados pessoais">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 013 3L8 18l-4 1 1-4Z"/></svg>
          </button>
        </div>
        <div class="profile-summary" id="profile-summary">
          <div class="profile-summary-row"><span>Nome</span><strong id="profile-name-value">—</strong></div>
          <div class="profile-summary-row"><span>Número da conta</span><strong id="profile-phone-value">—</strong></div>
        </div>
        <div class="profile-edit-form" id="profile-edit-form" style="display:none">
          <input class="auth-inp" id="profile-name" type="text" placeholder="Nome completo" autocomplete="name">
          <input class="auth-inp" id="profile-phone" type="tel" placeholder="Número da conta (9 dígitos)" maxlength="9" inputmode="numeric" autocomplete="tel">
          <span class="profile-edit-hint">O número da conta deve ter exactamente 9 dígitos.</span>
          <div class="auth-err" id="profile-err"></div>
          <div class="profile-edit-actions">
            <button class="profile-cancel-btn" type="button" onclick="cancelProfileEdit()">Cancelar</button>
            <button class="auth-btn profile-save-btn" id="profile-btn" onclick="saveProfile()">Guardar</button>
          </div>
        </div>
        <div class="profile-divider"></div>
        <div class="profile-section-title">Alterar senha</div>
        <input class="auth-inp" id="profile-current-pass" type="password" placeholder="Senha actual" autocomplete="current-password">
        <input class="auth-inp" id="profile-new-pass" type="password" placeholder="Nova senha (mín. 6 caracteres)" autocomplete="new-password">
        <input class="auth-inp" id="profile-new-pass2" type="password" placeholder="Confirmar nova senha" autocomplete="new-password">
        <div class="auth-err" id="password-err"></div>
        <button class="auth-btn" id="password-btn" onclick="changePassword()">Alterar senha</button>
      </div>
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

// ── Auth state ──────────────────────────────────────────────────────────────
const authState = { user: null, pendingPkg: null }

async function checkAuth() {
  try {
    const r = await fetch('/api/auth/me')
    if (r.ok) authState.user = await r.json()
  } catch {}
  updateNavAuth()
}
function updateNavAuth() {
  const u = authState.user
  const nb = document.getElementById('nav-balance')
  const nbv = document.getElementById('nav-bal-val')
  const dlo = document.getElementById('drawer-logged-out')
  const dli = document.getElementById('drawer-logged-in')
  const srch = document.getElementById('nav-search-btn')
  if (u) {
    nb.style.display = 'flex'
    nbv.textContent = (u.balance||0).toLocaleString('pt-MZ') + ' MT'
    dlo.style.display = 'none'
    dli.style.display = 'block'
    document.getElementById('drawer-user-name').textContent = u.name
    document.getElementById('drawer-user-phone').textContent = u.phone
    document.getElementById('drawer-user-bal').textContent = (u.balance||0).toLocaleString('pt-MZ') + ' MT saldo'
    if (srch) srch.style.display = 'none'
  } else {
    nb.style.display = 'none'
    dlo.style.display = 'block'
    dli.style.display = 'none'
    if (srch) srch.style.display = 'flex'
  }
}
function phoneMethod(phone) {
  const digits = String(phone || '').replace(/\\D/g,'')
  if (/^(84|85)\\d{7}$/.test(digits)) return 'mpesa'
  if (/^(86|87)\\d{7}$/.test(digits)) return 'emola'
  return null
}
function paymentMethodLabel(method) {
  return method === 'emola' ? 'e-Mola' : 'M-Pesa'
}
function openAuthDialog(tab) {
  authSetTab(tab || 'register')
  document.getElementById('auth-modal').style.display = 'flex'
  setTimeout(() => document.getElementById('auth-card').classList.add('open'), 10)
}
function closeAuthDialog() {
  document.getElementById('auth-card').classList.remove('open')
  setTimeout(() => { document.getElementById('auth-modal').style.display = 'none' }, 250)
}
function authSetTab(t) {
  document.getElementById('auth-panel-register').style.display = t==='register' ? 'flex' : 'none'
  document.getElementById('auth-panel-login').style.display    = t==='login'    ? 'flex' : 'none'
  document.querySelectorAll('.auth-tab').forEach((b,i) => b.classList.toggle('active', (i===0&&t==='register')||(i===1&&t==='login')))
}
async function registerUser() {
  const name=document.getElementById('reg-name').value.trim()
  const phone=document.getElementById('reg-phone').value.trim().replace(/\\D/g,'')
  const pass=document.getElementById('reg-pass').value
  const pass2=document.getElementById('reg-pass2').value
  const err=document.getElementById('reg-err'); err.style.display='none'
  if (!name){err.textContent='Introduza o seu nome.';err.style.display='block';return}
   if (!phoneMethod(phone)){err.textContent='Número inválido. Use M-Pesa 84/85 ou e-Mola 86/87.';err.style.display='block';return}
  if (pass.length<6){err.textContent='Senha deve ter pelo menos 6 caracteres.';err.style.display='block';return}
  if (pass!==pass2){err.textContent='As senhas não coincidem.';err.style.display='block';return}
  const btn=document.getElementById('reg-btn'); btn.disabled=true; btn.textContent='A criar conta…'
  try {
    const r=await fetch('/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,phone,password:pass})})
    const d=await r.json()
    if(!r.ok){err.textContent=d.error||'Erro ao criar conta.';err.style.display='block';btn.disabled=false;btn.textContent='Criar Conta';return}
    authState.user=d.user; updateNavAuth(); closeAuthDialog()
    if(authState.pendingPkg){const id=authState.pendingPkg;authState.pendingPkg=null;setTimeout(()=>openBuyDirect(id),300)}
  } catch{err.textContent='Erro de ligação.';err.style.display='block';btn.disabled=false;btn.textContent='Criar Conta'}
}
async function loginUser() {
  const phone=document.getElementById('login-phone').value.trim().replace(/\\D/g,'')
  const pass=document.getElementById('login-pass').value
  const err=document.getElementById('login-err'); err.style.display='none'
  if(!phone){err.textContent='Introduza o número.';err.style.display='block';return}
  if(!pass){err.textContent='Introduza a senha.';err.style.display='block';return}
  const btn=document.getElementById('login-btn'); btn.disabled=true; btn.textContent='A entrar…'
  try {
    const r=await fetch('/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({phone,password:pass})})
    const d=await r.json()
    if(!r.ok){err.textContent=d.error||'Credenciais inválidas.';err.style.display='block';btn.disabled=false;btn.textContent='Entrar';return}
    authState.user=d.user; updateNavAuth(); closeAuthDialog()
    if(authState.pendingPkg){const id=authState.pendingPkg;authState.pendingPkg=null;setTimeout(()=>openBuyDirect(id),300)}
  } catch{err.textContent='Erro de ligação.';err.style.display='block';btn.disabled=false;btn.textContent='Entrar'}
}
async function logoutUser() {
  await fetch('/api/auth/logout').catch(()=>{})
  authState.user=null; updateNavAuth(); closeDrawer()
}

function renderProfileSummary() {
  const u = authState.user || {}
  document.getElementById('profile-name-value').textContent = u.name || '—'
  document.getElementById('profile-phone-value').textContent = u.phone || '—'
}
function setProfileEditMode(editing) {
  document.getElementById('profile-summary').style.display = editing ? 'none' : 'flex'
  document.getElementById('profile-edit-form').style.display = editing ? 'flex' : 'none'
  document.getElementById('profile-edit-btn').style.display = editing ? 'none' : 'flex'
}
function startProfileEdit() {
  if (!authState.user) return
  document.getElementById('profile-name').value = authState.user.name || ''
  document.getElementById('profile-phone').value = authState.user.phone || ''
  document.getElementById('profile-err').style.display = 'none'
  setProfileEditMode(true)
  setTimeout(() => document.getElementById('profile-name').focus(), 0)
}
function cancelProfileEdit() {
  document.getElementById('profile-err').style.display = 'none'
  setProfileEditMode(false)
}
function openProfileDialog() {
  if (!authState.user) { openAuthDialog('login'); return }
  document.getElementById('profile-name').value = authState.user.name || ''
  document.getElementById('profile-phone').value = authState.user.phone || ''
  renderProfileSummary()
  setProfileEditMode(false)
  ;['profile-err','password-err'].forEach(id => {
    const el = document.getElementById(id)
    el.style.display='none'
    el.style.color=''
    el.style.background=''
    el.style.borderColor=''
  })
  ;['profile-current-pass','profile-new-pass','profile-new-pass2'].forEach(id => { document.getElementById(id).value='' })
  document.getElementById('profile-modal').style.display='flex'
  setTimeout(() => document.getElementById('profile-card').classList.add('open'), 10)
}
function closeProfileDialog() {
  document.getElementById('profile-card').classList.remove('open')
  setTimeout(() => { document.getElementById('profile-modal').style.display='none' }, 250)
}
async function saveProfile() {
  const name=document.getElementById('profile-name').value.trim()
  const phone=document.getElementById('profile-phone').value.trim().replace(/\\D/g,'')
  const err=document.getElementById('profile-err'); err.style.display='none'
  if (!name) { err.textContent='Introduza o seu nome.'; err.style.display='block'; return }
  if (!phoneMethod(phone)) { err.textContent='Número inválido. Use M-Pesa 84/85 ou e-Mola 86/87.'; err.style.display='block'; return }
  const btn=document.getElementById('profile-btn'); btn.disabled=true; btn.textContent='A guardar…'
  try {
    const r=await fetch('/api/auth/profile',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name,phone})})
    const d=await r.json()
    if (!r.ok) { err.textContent=d.error||'Não foi possível guardar os dados.'; err.style.display='block'; return }
    authState.user=d.user; updateNavAuth(); renderProfileSummary(); syncSelfPurchaseRecipient(); setProfileEditMode(false); closeProfileDialog()
  } catch { err.textContent='Erro de ligação.'; err.style.display='block' }
  finally { btn.disabled=false; btn.textContent='Guardar dados' }
}
async function changePassword() {
  const currentPassword=document.getElementById('profile-current-pass').value
  const newPassword=document.getElementById('profile-new-pass').value
  const newPassword2=document.getElementById('profile-new-pass2').value
  const err=document.getElementById('password-err'); err.style.display='none'
  if (!currentPassword) { err.textContent='Introduza a senha actual.'; err.style.display='block'; return }
  if (newPassword.length<6) { err.textContent='A nova senha deve ter pelo menos 6 caracteres.'; err.style.display='block'; return }
  if (newPassword!==newPassword2) { err.textContent='As novas senhas não coincidem.'; err.style.display='block'; return }
  const btn=document.getElementById('password-btn'); btn.disabled=true; btn.textContent='A alterar…'
  try {
    const r=await fetch('/api/auth/change-password',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({currentPassword,newPassword})})
    const d=await r.json()
    if (!r.ok) { err.textContent=d.error||'Não foi possível alterar a senha.'; err.style.display='block'; return }
    ;['profile-current-pass','profile-new-pass','profile-new-pass2'].forEach(id => { document.getElementById(id).value='' })
    err.textContent='Senha alterada com sucesso.'
    err.style.color='#2e7d32'; err.style.background='#e8f5e9'; err.style.borderColor='#a5d6a7'; err.style.display='block'
  } catch { err.textContent='Erro de ligação.'; err.style.display='block' }
  finally { btn.disabled=false; btn.textContent='Alterar senha' }
}

// ── Recarga ──────────────────────────────────────────────────────────────────
function openRechargeDialog() {
  document.getElementById('rech-amount').value=''
  document.getElementById('rech-err').style.display='none'
  const btn=document.getElementById('rech-btn'); btn.disabled=false; btn.textContent='Continuar'
  document.getElementById('recharge-modal').style.display='flex'
  setTimeout(()=>document.getElementById('recharge-card').classList.add('open'),10)
}
function closeRechargeDialog() {
  document.getElementById('recharge-card').classList.remove('open')
  setTimeout(()=>{document.getElementById('recharge-modal').style.display='none'},250)
}
async function submitRecharge() {
  const amount=parseInt(document.getElementById('rech-amount').value)
  const err=document.getElementById('rech-err'); err.style.display='none'
  if(!amount||amount<20){err.textContent='O valor mínimo para recarregar é 20 MT.';err.style.display='block';return}
  const btn=document.getElementById('rech-btn'); btn.disabled=true; btn.textContent='A processar…'
  try {
    const r=await fetch('/api/recharge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})})
    const d=await r.json()
    if(!r.ok){err.textContent=d.error||'Erro ao processar.';err.style.display='block';btn.disabled=false;btn.textContent='Continuar';return}
    closeRechargeDialog()
    document.getElementById('rech-method-lbl').textContent=paymentMethodLabel(d.method)
    document.getElementById('overlay').classList.add('open')
    setTimeout(()=>document.getElementById('sheet').classList.add('open'),10)
    shShow('recharging')
    listenRecharge(d.txId, amount)
  } catch{err.textContent='Erro de ligação.';err.style.display='block';btn.disabled=false;btn.textContent='Continuar'}
}
function listenRecharge(txId, amount) {
  const es=new EventSource('/events/'+txId)
  es.onmessage=e=>{
    const d=JSON.parse(e.data)
    if(d.status==='succeeded'){
      es.close()
      fetch('/api/auth/me').then(r=>r.json()).then(u=>{authState.user=u;updateNavAuth()}).catch(()=>{})
      document.getElementById('sh-rech-bal').textContent=(authState.user?.balance||0)+' MT (estimado)'
      shShow('recharge-ok')
    }
    if(d.status==='failed'){es.close();shShow('recharge-fail')}
  }
  es.onerror=()=>{es.close();setTimeout(()=>listenRecharge(txId,amount),3000)}
}

// ── Sheet ──────────────────────────────────────────────────────────────────
let shCurTab = 'mim'
let payVia = 'mobile-money'

function shSetTab(t) {
  shCurTab = t
  ;['mim','outro','req'].forEach((x,i) => {
    document.getElementById('sh-tab-'+x).style.display = x===t ? 'block' : 'none'
    document.querySelectorAll('.sh-tab')[i].classList.toggle('active', x===t)
  })
  const showBtn = t !== 'req'
  document.getElementById('sh-btn').style.display = showBtn ? 'block' : 'none'
  document.getElementById('via-section').style.display = showBtn ? 'block' : 'none'
}

function selectPayVia(v) {
  payVia = v
  document.querySelectorAll('.via-btn').forEach(b => b.classList.toggle('active', b.dataset.via===v))
  const btn = document.getElementById('sh-btn')
  if (v === 'credit') {
    const bal = authState.user?.balance || 0
    const price = curPkg?.price || 0
    if (bal < price) {
      btn.textContent = 'Saldo insuficiente (' + bal.toLocaleString('pt-MZ') + ' MT)'
      btn.disabled = true
    } else {
      btn.textContent = 'Pagar ' + price + ' MT com Crédito'
      btn.disabled = false
    }
  } else {
    btn.textContent = 'Próximo'
    btn.disabled = false
  }
}
function updateCreditBtn() {
  const btn = document.getElementById('via-credit')
  if (!btn) return
  btn.disabled = false
}

function openBuy(id) {
  if (!authState.user) { authState.pendingPkg = id; openAuthDialog('register'); return }
  openBuyDirect(id)
}
function syncSelfPurchaseRecipient() {
  const recipient = document.getElementById('sh-recipient-phone')
  if (recipient) recipient.textContent = authState.user?.phone || '—'
}
function openBuyDirect(id) {
  const all = Object.values(PKGS_ALL).flat()
  const p = all.find(x=>x.id===id); if(!p) return
  curPkg = p
  document.getElementById('sh-size').textContent = p.name
  document.getElementById('sh-price').textContent = p.price
  document.getElementById('ico-data').textContent = p.size
  document.getElementById('ico-dur').textContent  = p.dur
  document.getElementById('ico-calls').textContent = p.calls ? 'Ilim.' : '0 MT'
  document.getElementById('ico-sms').textContent   = p.calls ? '+ SMS' : '0 SMS'
  const selfInput = document.getElementById('sh-phone')
  selfInput.value = ''
  selfInput.readOnly = false
  selfInput.title = ''
  selfInput.placeholder = 'Número que vai pagar'
  syncSelfPurchaseRecipient()
  document.getElementById('sh-err').style.display = 'none'
  payVia = 'mobile-money'
  document.querySelectorAll('.via-btn').forEach(b => b.classList.toggle('active', b.dataset.via===payVia))
  updateCreditBtn()
  const btn = document.getElementById('sh-btn'); btn.disabled=false; btn.textContent='Próximo'; btn.style.display='block'
  shSetTab('mim')
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
  const ALL=['buy','pending','success','failed','success-credit','recharging','recharge-ok','recharge-fail']
  ALL.forEach(x=>{ const el=document.getElementById('s-'+x); if(el) el.style.display=(x===s?'block':'none') })
  const sh=document.getElementById('sheet')
  const centered=['pending','recharging']
  if(centered.includes(s)){sh.classList.add('pending-full')}else{sh.classList.remove('pending-full')}
}

function getPhoneFromSheet() {
  if (shCurTab==='outro') {
    const phone=document.getElementById('sh-phone-payer').value.trim().replace(/\\D/g,'')
    const bene=document.getElementById('sh-phone-bene').value.trim().replace(/\\D/g,'')
    return { phone, beneficiaryPhone:bene, purchaseFor:'other', error: !phone?'Introduza o seu número de pagamento.':!phoneMethod(phone)?'Número de pagamento incompatível. M-Pesa: 84/85 · e-Mola: 86/87.':!bene?'Introduza o número do beneficiário.':phoneMethod(bene)!=='mpesa'?'Número do beneficiário inválido. Use apenas 84 ou 85.':null }
  }
  const phone=document.getElementById('sh-phone').value.trim().replace(/\\D/g,'')
  return { phone, beneficiaryPhone:null, purchaseFor:'self', error: !authState.user?'Faça login para comprar para si.':!phoneMethod(phone)?'Número de pagamento incompatível. M-Pesa: 84/85 · e-Mola: 86/87.':null }
}

async function pay() {
  if (payVia === 'credit') { await payWithCredit(); return }
  const ee = document.getElementById('sh-err'); ee.style.display='none'
  const {phone, beneficiaryPhone, purchaseFor, error} = getPhoneFromSheet()
  if (error) { ee.textContent=error; ee.style.display='block'; return }
  const btn = document.getElementById('sh-btn'); btn.disabled=true; btn.textContent='A processar…'
  try {
    const payload={phone,bundleId:curPkg.id,paymentMethod:phoneMethod(phone),purchaseFor}; if(beneficiaryPhone) payload.beneficiaryPhone=beneficiaryPhone
    const r = await fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    const d = await r.json()
    if (!r.ok) { ee.textContent=d.error||'Erro ao processar.'; ee.style.display='block'; btn.disabled=false; btn.textContent='Próximo'; return }
    document.getElementById('sh-method-lbl').textContent = paymentMethodLabel(d.method || phoneMethod(phone))
    document.getElementById('sh-ok-pkg').textContent = curPkg.name+' — '+curPkg.price+' MT'
    shShow('pending'); listenOrder(d.txId)
  } catch { ee.textContent='Erro de ligação. Tente novamente.'; ee.style.display='block'; btn.disabled=false; btn.textContent='Próximo' }
}
async function payWithCredit() {
  const ee = document.getElementById('sh-err'); ee.style.display='none'
  const {phone, beneficiaryPhone, purchaseFor, error} = getPhoneFromSheet()
  if (shCurTab !== 'req' && error) { ee.textContent=error; ee.style.display='block'; return }
  const btn=document.getElementById('sh-btn'); btn.disabled=true; btn.textContent='A debitar crédito…'
  try {
    const payload={bundleId:curPkg.id,purchaseFor}
    if(beneficiaryPhone) payload.beneficiaryPhone=beneficiaryPhone
    const r=await fetch('/api/buy-credit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    const d=await r.json()
    if(!r.ok){ee.textContent=d.error||'Erro.';ee.style.display='block';selectPayVia('credit');return}
    authState.user.balance=d.newBalance; updateNavAuth()
    document.getElementById('sh-ok-pkg-credit').textContent=curPkg.name+' — '+curPkg.price+' MT'
    shShow('success-credit')
  } catch{ee.textContent='Erro de ligação.';ee.style.display='block';selectPayVia('credit')}
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

// ── PWA Install ─────────────────────────────────────────────────────────────
const _pwaBanner = document.getElementById('pwa-banner')
const _pwaKey = 'pwa-dismissed'
function showPwaInstallBanner() {
  if (_pwaBanner && !sessionStorage.getItem(_pwaKey)) _pwaBanner.classList.add('show')
}
function hidePwaInstallBanner() {
  _pwaBanner?.classList.remove('show')
}
window.addEventListener('message', event => {
  if (event.origin !== window.location.origin) return
  const type = event.data?.type
  if (type === 'pwa-install-available') showPwaInstallBanner()
  if (type === 'pwa-installed') hidePwaInstallBanner()
  if (type === 'pwa-install-result') {
    hidePwaInstallBanner()
    if (event.data.outcome === 'dismissed') sessionStorage.removeItem(_pwaKey)
  }
})
document.getElementById('pwa-install-btn')?.addEventListener('click', () => {
  hidePwaInstallBanner()
  window.parent.postMessage({ type: 'pwa-install-request' }, window.location.origin)
})
document.getElementById('pwa-dismiss-btn')?.addEventListener('click', () => {
  hidePwaInstallBanner()
  sessionStorage.setItem(_pwaKey, '1')
})

// ── Mais ofertas ─────────────────────────────────────────────────────────────
const OFFERS = {
  soprati: {
    name: 'Ofertas SóPraTi',
    img: '/static/offer-soprati.webp',
    text: 'Serviço de ofertas personalizadas, apresentadas no menu *109#, que vão de encontro ao comportamento do cliente.'
  },
  ya: {
    name: 'Yá',
    img: '/static/offer-ya.webp',
    text: 'YÁ é uma iniciativa da Vodacom que pretende introduzir ofertas e acções relevantes para o segmento jovem. Todo Cliente jovem com idade compreendida entre 16 à 25 anos, é convidado a experimentar as primeiras ofertas exclusivas para este segmento e partilhar a novidade com amigos e familiares.'
  },
  bomdia: {
    name: 'Bom Dia',
    img: '/static/offer-bomdia.webp',
    text: 'Bom Dia é o serviço em que podes activar uma oferta de Voz ou Dados, diariamente, no horário das 0h as 12h. Para activar só tens que digitar o código USSD *126# e seguir as instruções.'
  },
  turnonoite: {
    name: 'Turno da Noite',
    img: '/static/offer-turnonoite.webp',
    text: 'É um serviço da Vodacom que lhe dá acesso à ofertas de Voz mais acessíveis para falares dentro da rede entre 22h até as 06h.'
  },
  jackpot: {
    name: 'Todas Redes Jackpot',
    img: '/static/offer-jackpot.webp',
    text: 'É uma oferta de voz para todas as redes que permite aumentar as tuas chamadas em até 4X mais, a partir de 2MT.'
  }
}
function openOffer(id) {
  const o = OFFERS[id]; if (!o) return
  document.getElementById('mo-modal-img').src = o.img
  document.getElementById('mo-modal-img').alt = o.name
  document.getElementById('mo-modal-bread').textContent = o.name
  document.getElementById('mo-modal-name').textContent = o.name
  document.getElementById('mo-modal-text').textContent = o.text
  const modal = document.getElementById('mo-modal')
  modal.classList.add('open')
  modal.scrollTop = 0
  document.body.style.overflow = 'hidden'
}
function closeOffer() {
  document.getElementById('mo-modal').classList.remove('open')
  document.body.style.overflow = ''
}

// Init: diarias já visível por defeito (HTML pré-renderizado)
checkAuth()
</script>
</body></html>`
}


// ── Admin: Login ──────────────────────────────────────────────────────────────
function adminLoginPage(err = '') {
  return `<!DOCTYPE html><html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Megabyte</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:#f2f2f7;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;align-items:center;justify-content:center;}
.card{background:#fff;border-radius:18px;padding:36px 28px;width:100%;max-width:340px;box-shadow:0 2px 16px rgba(0,0,0,.08);}
.logo{display:flex;align-items:center;gap:10px;justify-content:center;margin-bottom:28px;}
.logo img{width:36px;height:36px;object-fit:contain;border-radius:8px;}
.logo-text{font-size:18px;font-weight:800;color:#1c1c1e;}
.logo-text span{color:#cc0000;}
h2{font-size:17px;font-weight:700;color:#1c1c1e;margin-bottom:6px;text-align:center;}
p{font-size:13px;color:#636366;text-align:center;margin-bottom:24px;}
label{display:block;font-size:13px;font-weight:600;color:#1c1c1e;margin-bottom:7px;}
input{width:100%;border:1.5px solid #c7c7cc;border-radius:12px;padding:14px;font-size:15px;font-family:inherit;color:#1c1c1e;outline:none;transition:border-color .15s;margin-bottom:16px;}
input:focus{border-color:#cc0000;}
.err{background:#fff0f0;border:1px solid #ffcdd2;border-radius:10px;padding:10px 14px;font-size:13px;color:#cc0000;margin-bottom:14px;display:${err?'block':'none'};}
button{width:100%;padding:15px;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;background:#cc0000;color:#fff;}
button:active{opacity:.85;}
</style></head><body>
<div class="card">
  <div class="logo">
    <img src="/static/vodacom.webp" alt="logo">
    <div class="logo-text">Mega<span>byte</span></div>
  </div>
  <h2>Área Reservada</h2>
  <p>Acesso exclusivo a administradores</p>
  <form method="POST" action="/admin/office" onsubmit="handleLogin(event)">
    <label for="pw">Senha</label>
    <input type="password" id="pw" name="password" placeholder="••••••••••" autocomplete="current-password" required>
    <div class="err">${err}</div>
    <button type="submit">Entrar</button>
  </form>
</div>
<script>
function handleLogin(e){
  e.preventDefault()
  const pw=document.getElementById('pw').value
  fetch('/admin/office',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({password:pw})})
    .then(r=>r.redirected?window.location.href=r.url:r.text().then(t=>{document.open();document.write(t);document.close()}))
    .catch(()=>{})
}
</script>
</body></html>`
}

// ── Admin: Dashboard ──────────────────────────────────────────────────────────
const ADMIN_HISTORY_PAGE_SIZE = 50

function adminDashboard(filter = 'all', requestedPage = 1) {
  const megabyteTransactions = orders.filter(o => o.type !== 'gateway')
  const gatewayTransactions = orders.filter(o => o.type === 'gateway')
  const counts = { all:0, pending:0, succeeded:0, activated:0, failed:0 }
  let totalReceived = 0
  megabyteTransactions.forEach(o => {
    counts.all++
    if (counts[o.status] !== undefined) counts[o.status]++
    if (o.status==='succeeded'||o.status==='activated') totalReceived += (o.amount||0)
  })
  const gatewayCounts = { all: gatewayTransactions.length, pending: 0, succeeded: 0, failed: 0 }
  let gatewayTotalReceived = 0
  gatewayTransactions.forEach(o => {
    if (gatewayCounts[o.status] !== undefined) gatewayCounts[o.status]++
    if (o.status === 'succeeded') gatewayTotalReceived += (o.amount || 0)
  })

  const filterMap = {
    all:       megabyteTransactions,
    users:     users,
    gateway:   gwKeys,
    'gateway-transactions': gatewayTransactions,
    pending:   megabyteTransactions.filter(o=>o.status==='pending'),
    succeeded: megabyteTransactions.filter(o=>o.status==='succeeded'),
    activated: megabyteTransactions.filter(o=>o.status==='activated'),
    'delivery-failed': megabyteTransactions.filter(o=>['failed','manual_intervention'].includes(o.deliveryStatus)),
    'payment-forwarding': megabyteTransactions.filter(o=>['pending','forwarding','failed'].includes(o.pagarForwardingStatus)),
    failed:    megabyteTransactions.filter(o=>o.status==='failed'),
  }
  const filtered = filterMap[filter] ?? megabyteTransactions
  const isGatewayView = filter === 'gateway' || filter === 'gateway-transactions'
  const isHistoryView = filter !== 'users' && filter !== 'gateway' && filter !== 'manual-credit'
  const totalPages = Math.max(1, Math.ceil(filtered.length / ADMIN_HISTORY_PAGE_SIZE))
  const parsedPage = Number.parseInt(requestedPage, 10)
  const page = Math.min(totalPages, Math.max(1, Number.isFinite(parsedPage) ? parsedPage : 1))
  const visible = isHistoryView
    ? filtered.slice((page - 1) * ADMIN_HISTORY_PAGE_SIZE, page * ADMIN_HISTORY_PAGE_SIZE)
    : filtered
  const activeTotal = isGatewayView ? gatewayTotalReceived : totalReceived
  const statsCards = isGatewayView
    ? `<div class="stat-card s-all"><div class="stat-num">${gatewayCounts.all}</div><div class="stat-lbl">Total do Gateway</div></div>
       <div class="stat-card s-conf"><div class="stat-num">${gatewayCounts.succeeded}</div><div class="stat-lbl">Pagamentos Confirmados</div></div>
       <div class="stat-card s-pend"><div class="stat-num">${gatewayCounts.pending}</div><div class="stat-lbl">A aguardar Pagamento</div></div>
       <div class="stat-card s-fail"><div class="stat-num">${gatewayCounts.failed}</div><div class="stat-lbl">Pagamentos Falhados</div></div>`
    : `<div class="stat-card s-all"><div class="stat-num">${counts.all}</div><div class="stat-lbl">Total Megabyte</div></div>
       <div class="stat-card s-conf"><div class="stat-num">${counts.succeeded}</div><div class="stat-lbl">Pagamentos Confirmados</div></div>
       <div class="stat-card s-act"><div class="stat-num">${counts.activated}</div><div class="stat-lbl">Activações Concluídas</div></div>
       <div class="stat-card s-pend"><div class="stat-num">${counts.pending}</div><div class="stat-lbl">A aguardar Pagamento</div></div>`

  const SL = { pending:'A aguardar pagamento', succeeded:'Pagamento confirmado', activated:'Activado', failed:'Falhado' }
  const SC = { pending:'#92400e', succeeded:'#065f46', activated:'#1e3a8a', failed:'#991b1b' }
  const SBG= { pending:'#fef3c7', succeeded:'#d1fae5', activated:'#dbeafe', failed:'#fee2e2' }
  const ML = { mpesa:'M-Pesa', emola:'e-Mola' }

  const navSections = [
    { label: 'Megabyte', items: [
      { f:'all',       label:'Pagamentos Megabyte',   icon:'M3 7h18M3 12h18M3 17h18' },
      { f:'succeeded', label:'Pendentes de Activação', icon:'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
      { f:'activated', label:'Activações Confirmadas', icon:'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
      { f:'delivery-failed', label:'Falhas de Entrega USSD', icon:'M12 9v4m0 4h.01M10.29 3.86l-8.18 14a2 2 0 001.74 3h16.3a2 2 0 001.74-3l-8.18-14a2 2 0 00-3.48 0z' },
      { f:'payment-forwarding', label:'Encaminhamentos Pagar', icon:'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
      { f:'pending',   label:'A aguardar Pagamento',   icon:'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z' },
      { f:'failed',    label:'Pagamentos Falhados',    icon:'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z' },
    ]},
    { label: 'Gateway Privado', items: [
      { f:'gateway-transactions', label:'Transacções do Gateway', icon:'M2 12h20M12 2v20M5 5l14 14M19 5L5 19' },
      { f:'gateway', label:'Chaves de API', icon:'M21 2l-2 2m-7.61 7.61a5.5 5.5 0 11-7.778 7.778 5.5 5.5 0 017.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4' },
    ]},
    { label: 'Utilizadores', items: [
      { f:'users', label:'Contas de Utilizadores', icon:'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75' },
    ]},
    { label: 'Ferramentas', items: [
      { f:'manual-credit', label:'Crédito Manual', icon:'M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z' },
    ]},
  ]
  const allNavItems = navSections.flatMap(s=>s.items)

  const sidebarLinks = navSections.map(s=>
    `<div class="sidebar-section">${s.label}</div>` +
    s.items.map(n=>`
    <a href="/admin/office?filter=${n.f}" class="nav-link${filter===n.f?' active':''}">
      <svg viewBox="0 0 24 24"><path d="${n.icon}" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>
      <span>${n.label}</span>
      <span class="nav-count">${filterMap[n.f]?.length||0}</span>
    </a>`).join('')
  ).join('')

  const pageTitle = allNavItems.find(n=>n.f===filter)?.label || 'Pagamentos Megabyte'

  // ── Vista especial: tabela ZumboPay ─────────────────────────────────────────
  const zumboTable = null
  /*
  const legacyZumboTable = false && filter === 'zumbo'
    ? (filtered.length === 0
        ? `<div class="empty"><div class="empty-icon">📭</div><p>Nenhuma transacção encontrada.</p></div>`
        : `<div class="zumbo-panel">
  <div class="zumbo-info">
    <svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:#065f46;fill:none;stroke-width:2;stroke-linecap:round;flex-shrink:0"><path d="M12 2a10 10 0 100 20A10 10 0 0012 2zm0 9v4m0-7h.01"/></svg>
    Todas as cobranças processadas via ZumboPay neste projecto. Endpoint API:
    <code>/api/transactions</code> com header <code>Authorization: Bearer &lt;senha_admin&gt;</code>
  </div>
  <div class="ztable-wrap">
  <table class="ztable">
    <thead><tr>
      <th>Data / Hora</th><th>Referência ZumboPay</th><th>Número (Pagador)</th><th>Beneficiário</th><th>Oferta</th><th>Valor</th><th>Método</th><th>Estado</th>
    </tr></thead>
    <tbody>
    ${filtered.map(o=>{
      const dt  = new Date(o.ts)
      const ds  = dt.toLocaleDateString('pt-MZ',{day:'2-digit',month:'short',year:'numeric'})
                + ' ' + dt.toLocaleTimeString('pt-MZ',{hour:'2-digit',minute:'2-digit'})
      const benef = o.beneficiaryPhone || o.phone
      const sc  = {pending:'#92400e',succeeded:'#065f46',activated:'#1e3a8a',failed:'#991b1b'}
      const sbg = {pending:'#fef3c7',succeeded:'#d1fae5',activated:'#dbeafe',failed:'#fee2e2'}
      const sl  = {pending:'Aguardar',succeeded:'Confirmado',activated:'Activado',failed:'Falhado'}
      const zref = o.zumboRef || '—'
      return `<tr>
        <td class="zt-date">${ds}</td>
        <td><span style="font-family:monospace;font-size:12px;color:#1c1c1e;font-weight:600">${zref}</span></td>
        <td class="zt-phone">${o.phone}</td>
        <td class="zt-phone">${benef}${benef!==o.phone?' <em>(outro)</em>':''}</td>
        <td>${o.bundleLabel||'—'}</td>
        <td class="zt-amount">${o.amount} MT</td>
        <td><span class="method-tag">M-Pesa</span></td>
        <td><span class="badge" style="color:${sc[o.status]||'#636366'};background:${sbg[o.status]||'#f2f2f7'}">${sl[o.status]||o.status}</span></td>
      </tr>`
    }).join('')}
    </tbody>
  </table>
  </div>
</div>`)
    : null */

  // ── Vista: Gateway (chaves de API) ─────────────────────────────────────────
  const gatewayView = filter === 'gateway'
    ? `<div class="zumbo-panel">
  <div class="zumbo-info">
    <svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:#065f46;fill:none;stroke-width:2;stroke-linecap:round;flex-shrink:0"><path d="M12 2a10 10 0 100 20A10 10 0 0012 2zm0 9v4m0-7h.01"/></svg>
    <div>Crie chaves para outros sites cobrarem via M-Pesa através deste gateway.<br>
    <strong>Iniciar pagamento:</strong> <code>POST ${SITE_URL}/gateway/api/pay</code> com header <code>X-API-Key: &lt;chave&gt;</code> e corpo JSON <code>{"phone":"84xxxxxxx","amount":100,"reference":"pedido-123","callback_url":"https://seusite.com/confirmar"}</code><br>
    <strong>Consultar estado:</strong> <code>GET ${SITE_URL}/gateway/api/status/&lt;txId&gt;</code> com o mesmo header. Estados: <code>pending</code>, <code>succeeded</code>, <code>failed</code>.<br>
    Se enviar <code>callback_url</code>, o site de terceiros recebe um POST com o resultado, assinado com HMAC-SHA256 do segredo no header <code>X-Gateway-Signature</code>.</div>
  </div>
  <div style="background:#fff;border:1px solid #e5e5ea;border-radius:14px;padding:16px;margin-bottom:18px;display:flex;gap:8px;">
    <input id="gw-name" type="text" placeholder="Nome do projecto (ex: Loja XYZ)" style="flex:1;padding:12px 14px;border:1.5px solid #e5e5ea;border-radius:10px;font-size:14px;font-family:inherit;outline:none;">
    <button onclick="gwCreate()" style="padding:12px 20px;border:none;border-radius:10px;background:#cc0000;color:#fff;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;">Criar chave</button>
  </div>
  ${gwKeys.length === 0
    ? `<div class="empty"><div class="empty-icon">🔑</div><p>Nenhuma chave criada ainda.</p></div>`
    : gwKeys.map(g => `<div class="order-card">
  <div class="card-header">
    <div class="card-left">
      <div class="card-badge-row">
        <span class="badge" style="color:${g.active?'#065f46':'#991b1b'};background:${g.active?'#d1fae5':'#fee2e2'}">${g.active?'Activa':'Desactivada'}</span>
        <strong style="font-size:15px">${escapeHtml(g.name)}</strong>
      </div>
      <div class="card-date">Criada em ${new Date(g.createdAt).toLocaleDateString('pt-MZ',{day:'2-digit',month:'short',year:'numeric'})} · ${g.txCount||0} pagamentos · ${(g.totalAmount||0).toLocaleString('pt-MZ')} MT</div>
    </div>
  </div>
  <div class="card-divider"></div>
  <div class="card-body">
    <div class="info-row"><span class="info-label">Chave (X-API-Key)</span>
      <div class="info-value bene-row"><span class="mono" style="font-family:monospace;font-size:11px">${g.key.slice(0,16)}…</span>
      <button class="copy-btn" onclick="copyNum('${g.key}',this)">Copiar</button></div></div>
    <div class="info-row"><span class="info-label">Segredo (assinatura)</span>
      <div class="info-value bene-row"><span class="mono" style="font-family:monospace;font-size:11px">${g.secret.slice(0,14)}…</span>
      <button class="copy-btn" onclick="copyNum('${g.secret}',this)">Copiar</button></div></div>
  </div>
  <div class="card-footer" style="display:flex;gap:8px">
    <button class="uedit-btn" style="flex:1" onclick="gwToggle('${g.id}')">${g.active?'Desactivar':'Activar'}</button>
    <button class="uedit-btn" style="flex:1" onclick="gwRename('${g.id}','${escapeHtml(g.name).replace(/'/g,"\\'")}')">Renomear</button>
    ${g.builtin ? '' : `<button class="uedit-btn" style="flex:1;color:#cc0000;border-color:#ffcdd2" onclick="gwDelete('${g.id}',this.dataset.n)" data-n="${escapeHtml(g.name)}">Eliminar</button>`}
  </div>
</div>`).join('')}
</div>`
    : null

  // ── Vista: histórico operacional do gateway privado ───────────────────────
  const gatewayTransactionsView = filter === 'gateway-transactions'
    ? (filtered.length === 0
        ? `<div class="gateway-panel"><div class="gateway-intro"><div class="gateway-mark">◎</div><div><strong>Nenhum pagamento do gateway</strong><p>As operações iniciadas por canais autorizados aparecerão aqui.</p></div></div><div class="empty"><div class="empty-icon">⌁</div><p>Ainda não há transacções para acompanhar.</p></div></div>`
        : `<div class="gateway-panel">
  <div class="gateway-intro">
    <div class="gateway-mark">◎</div>
    <div><strong>Histórico do Gateway privado</strong><p>Visão operacional Megabyte. Referências e descrições fornecidas por sistemas externos não são exibidas neste painel.</p></div>
  </div>
  <div class="ztable-wrap gateway-table-wrap">
  <table class="ztable gateway-table">
    <thead><tr>
      <th>Data / Hora</th><th>Referência interna</th><th>Canal</th><th>Pagador</th><th>Valor</th><th>Método</th><th>Estado</th>
    </tr></thead>
    <tbody>
    ${visible.map(o=>{
      const dt = new Date(o.ts)
      const ds = dt.toLocaleDateString('pt-MZ',{day:'2-digit',month:'short',year:'numeric'})
        + ' ' + dt.toLocaleTimeString('pt-MZ',{hour:'2-digit',minute:'2-digit'})
      const channelId = String(o.gwKeyId || 'privado')
      const channel = channelId === 'principal' ? 'Canal principal' : `Canal privado · ${escapeHtml(channelId.slice(0,8))}`
      const statusColor = SC[o.status] || '#636366'
      const statusBg = SBG[o.status] || '#f2f2f7'
      return `<tr>
        <td class="zt-date">${ds}</td>
        <td><span class="internal-reference"><span class="reference-dot"></span>Pagamento Megabyte <small>GW-${escapeHtml(o.txId)}</small></span></td>
        <td><span class="channel-tag">${channel}</span></td>
        <td class="zt-phone">${escapeHtml(o.phone)}</td>
        <td class="zt-amount">${Number(o.amount||0).toLocaleString('pt-MZ')} MT</td>
        <td><span class="method-tag">${ML[o.method]||escapeHtml(o.method||'—')}</span></td>
        <td><span class="badge" style="color:${statusColor};background:${statusBg}">${SL[o.status]||escapeHtml(o.status||'—')}</span></td>
      </tr>`
    }).join('')}
    </tbody>
  </table>
  </div>
</div>`)
    : null

  // ── Vista: Utilizadores ────────────────────────────────────────────────────
  const usersTable = filter === 'users'
    ? (users.length === 0
        ? `<div class="empty"><div class="empty-icon">👤</div><p>Nenhum utilizador registado ainda.</p></div>`
        : `<div class="ztable-wrap" style="max-width:900px">
  <table class="ztable">
    <thead><tr>
      <th>Nome</th><th>Número</th><th>Saldo</th><th>Registado em</th><th>Acções</th>
    </tr></thead>
    <tbody>
    ${users.map(u=>{
      const dt = new Date(u.createdAt)
      const ds = dt.toLocaleDateString('pt-MZ',{day:'2-digit',month:'short',year:'numeric'})
      return `<tr id="urow-${u.id}">
        <td><strong>${escapeHtml(u.name)}</strong></td>
        <td class="zt-phone">${u.phone}</td>
        <td><span class="ubal-badge">${(u.balance||0).toLocaleString('pt-MZ')} MT</span></td>
        <td class="zt-date">${ds}</td>
        <td>
          <button class="uedit-btn" onclick="openUserEdit('${u.id}','${u.name.replace(/'/g,"\\'")}','${u.phone}',${u.balance||0})">Editar</button>
        </td>
      </tr>`
    }).join('')}
    </tbody>
  </table>
</div>

<!-- Modal de edição de utilizador -->
<div id="user-modal" style="display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:500;align-items:center;justify-content:center;padding:20px;">
  <div style="background:#fff;border-radius:20px;width:100%;max-width:420px;overflow:hidden;box-shadow:0 20px 60px rgba(0,0,0,.2);">
    <div style="padding:20px 24px 0;border-bottom:1px solid #e5e5ea;margin-bottom:20px;">
      <div style="font-size:18px;font-weight:800;color:#1c1c1e;margin-bottom:4px">Editar Utilizador</div>
      <div id="uedit-phone-lbl" style="font-size:13px;color:#8e8e93;padding-bottom:16px"></div>
    </div>
    <div style="padding:0 24px 24px;display:flex;flex-direction:column;gap:12px">
      <input id="uedit-name" type="text" placeholder="Nome" style="width:100%;padding:13px 16px;border:1.5px solid #e5e5ea;border-radius:12px;font-size:15px;font-family:inherit;outline:none;">
      <input id="uedit-phone" type="tel" placeholder="Número (9 dígitos)" maxlength="9" style="width:100%;padding:13px 16px;border:1.5px solid #e5e5ea;border-radius:12px;font-size:15px;font-family:inherit;outline:none;">
      <div style="background:#f9f9fb;border-radius:12px;padding:14px 16px;">
        <div style="font-size:12px;font-weight:700;color:#636366;margin-bottom:10px;text-transform:uppercase;letter-spacing:.05em">Ajuste de Saldo</div>
        <div style="display:flex;gap:8px;align-items:center;">
          <button onclick="setBalDelta(-1)" style="background:#fee2e2;color:#cc0000;border:none;border-radius:8px;width:36px;height:36px;font-size:20px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center">−</button>
          <input id="uedit-bal-delta" type="number" value="0" style="flex:1;padding:8px 12px;border:1.5px solid #e5e5ea;border-radius:8px;font-size:15px;font-family:inherit;text-align:center;outline:none;">
          <button onclick="setBalDelta(1)" style="background:#d1fae5;color:#065f46;border:none;border-radius:8px;width:36px;height:36px;font-size:20px;cursor:pointer;font-family:inherit;display:flex;align-items:center;justify-content:center">+</button>
        </div>
        <div style="font-size:12px;color:#8e8e93;margin-top:6px;text-align:center">Saldo actual: <strong id="uedit-cur-bal">0</strong> MT → Novo: <strong id="uedit-new-bal">0</strong> MT</div>
      </div>
      <input id="uedit-newpass" type="password" placeholder="Nova senha (deixe em branco para manter)" style="width:100%;padding:13px 16px;border:1.5px solid #e5e5ea;border-radius:12px;font-size:15px;font-family:inherit;outline:none;">
      <div id="uedit-err" style="display:none;background:#fff0f0;border:1px solid #ffcdd2;border-radius:10px;padding:10px 14px;font-size:13px;color:#cc0000;"></div>
      <div style="display:flex;gap:8px;">
        <button onclick="closeUserEdit()" style="flex:1;padding:14px;border:1.5px solid #e5e5ea;border-radius:12px;font-size:15px;font-weight:600;font-family:inherit;cursor:pointer;background:#fff;color:#636366">Cancelar</button>
        <button id="uedit-save" onclick="saveUserEdit()" style="flex:2;padding:14px;border:none;border-radius:12px;background:#cc0000;color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer">Guardar</button>
      </div>
    </div>
  </div>
</div>`)
    : null

  // ── Vista: Crédito Manual ──────────────────────────────────────────────────
  const manualCreditView = filter === 'manual-credit'
    ? `<div class="zumbo-panel">
  <div class="zumbo-info" style="color:#92400e;background:#fef3c7;border-color:#fde68a">
    <svg viewBox="0 0 24 24" style="width:15px;height:15px;stroke:#92400e;fill:none;stroke-width:2;stroke-linecap:round;flex-shrink:0"><path d="M12 9v2m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"/></svg>
    Use esta ferramenta apenas para creditar pagamentos que o ZumboPay confirmou mas o cliente não recebeu (webhook perdido). A referência ZumboPay é obrigatória para evitar créditos duplicados.
  </div>
  <div style="background:#fff;border:1px solid #e5e5ea;border-radius:14px;padding:20px;display:flex;flex-direction:column;gap:12px;max-width:480px;">
    <div style="font-size:15px;font-weight:700;color:#1c1c1e">Creditar saldo manualmente</div>
    <input id="mc-ref"    type="text"   placeholder="Referência ZumboPay (ex: ZUMBO77081FA697)" style="width:100%;padding:12px 14px;border:1.5px solid #e5e5ea;border-radius:10px;font-size:14px;font-family:monospace;outline:none;">
    <input id="mc-phone"  type="tel"    placeholder="Número do cliente (9 dígitos)" style="width:100%;padding:12px 14px;border:1.5px solid #e5e5ea;border-radius:10px;font-size:14px;font-family:inherit;outline:none;">
    <input id="mc-amount" type="number" placeholder="Valor a creditar (MT)" min="1" style="width:100%;padding:12px 14px;border:1.5px solid #e5e5ea;border-radius:10px;font-size:14px;font-family:inherit;outline:none;">
    <div id="mc-err" style="display:none;color:#cc0000;font-size:13px;font-weight:600;padding:8px 12px;background:#fff0f0;border-radius:8px"></div>
    <div id="mc-ok"  style="display:none;color:#065f46;font-size:13px;font-weight:600;padding:8px 12px;background:#d1fae5;border-radius:8px"></div>
    <button onclick="doManualCredit()" style="padding:13px;border:none;border-radius:10px;background:#cc0000;color:#fff;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;">Creditar saldo</button>
  </div>
</div>`
    : null

  const cards = gatewayTransactionsView !== null ? gatewayTransactionsView
    : manualCreditView !== null ? manualCreditView
    : gatewayView !== null ? gatewayView
    : usersTable !== null ? usersTable
    : zumboTable !== null ? zumboTable
    : filtered.length === 0
    ? `<div class="empty"><div class="empty-icon">📭</div><p>Nenhuma transacção encontrada.</p></div>`
    : visible.map(o => {
        const dt = new Date(o.ts)
        const ds = dt.toLocaleDateString('pt-MZ',{day:'2-digit',month:'short',year:'numeric'})
          + ' ' + dt.toLocaleTimeString('pt-MZ',{hour:'2-digit',minute:'2-digit'})
        const benef = o.beneficiaryPhone || o.phone
        const isForOther = o.beneficiaryPhone && o.beneficiaryPhone !== o.phone
        const deliveryAttention = ['failed','manual_intervention'].includes(o.deliveryStatus)
        const forwardingAttention = ['pending','forwarding','failed'].includes(o.pagarForwardingStatus)
        const canActivate = o.status === 'succeeded' && !o.deliveryStatus && !forwardingAttention
        const forwardingRetryAt = o.pagarForwardingNextRetryAt ? new Date(o.pagarForwardingNextRetryAt).toLocaleString('pt-MZ',{dateStyle:'short',timeStyle:'short'}) : null
        return `<div class="order-card" id="card-${o.txId}">
  <div class="card-header">
    <div class="card-left">
      <div class="card-badge-row">
        <span class="badge" style="color:${SC[o.status]||'#636366'};background:${SBG[o.status]||'#f2f2f7'}">${SL[o.status]||o.status}</span>
        <span class="method-tag">${ML[o.method]||o.method}</span>
      </div>
      <div class="card-date">${ds}</div>
    </div>
    <div class="card-amount">${o.amount} <span>MT</span></div>
  </div>
  <div class="card-divider"></div>
  <div class="card-body">
    <div class="info-row">
      <span class="info-label">Pagador</span>
      <span class="info-value">${o.phone}</span>
    </div>
    <div class="info-row">
      <span class="info-label">Beneficiário ${isForOther?'<em>(outro)</em>':''}</span>
      <div class="info-value bene-row">
        <span class="bene-num">${benef}</span>
        <button class="copy-btn" onclick="copyNum('${benef}',this)" title="Copiar número">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          Copiar
        </button>
      </div>
    </div>
    <div class="info-row">
      <span class="info-label">Oferta</span>
      <div class="info-value bene-row">
        <span>${o.bundleLabel||'—'}</span>
        ${o.bundleLabel ? `<button class="copy-btn" onclick="copyNum('${o.bundleLabel}',this)" title="Copiar oferta">
          <svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg>
          Copiar
        </button>` : ''}
      </div>
    </div>
    <div class="info-row">
      <span class="info-label">ID Transacção</span>
      <span class="info-value mono">${o.txId}</span>
    </div>
    ${o.deliveryStatus && !deliveryAttention ? `<div class="delivery-state">Entrega USSD: ${o.deliveryStatus === 'queued' ? 'na fila' : o.deliveryStatus === 'leased' ? 'reservada pelo agente' : o.deliveryStatus}</div>` : ''}
  </div>
  ${forwardingAttention ? `<div class="delivery-alert pagar-forwarding-alert">
    <strong>${o.pagarForwardingStatus === 'failed' ? 'Encaminhamento Pagar falhou' : o.pagarForwardingStatus === 'forwarding' ? 'A encaminhar confirmação Pagar' : 'A aguardar encaminhamento Pagar'}</strong>
    <span>${o.pagarForwardingFailureReason ? escapeHtml(o.pagarForwardingFailureReason) : o.pagarForwardingStatus === 'failed' ? 'O bridge legado está indisponível.' : 'A confirmação de pagamento ficará na fila até o bridge estar disponível.'}</span>
    ${forwardingRetryAt && o.pagarForwardingStatus !== 'forwarding' ? `<span>Nova tentativa automática: ${forwardingRetryAt}</span>` : ''}
    ${o.pagarForwardingStatus !== 'forwarding' ? `<button class="retry-btn" onclick="retryPagarForwarding('${escapeHtml(o.pagarForwardingEventId)}',this)">Reprocessar encaminhamento</button>` : ''}
  </div>` : ''}${deliveryAttention ? `<div class="delivery-alert">
    <strong>Falha na entrega USSD</strong>
    <span>${o.deliveryFailureReason || 'A entrega precisa de intervenção.'}</span>
    <button class="retry-btn" onclick="retryDelivery('${o.txId}',this)">Reprocessar entrega</button>
  </div>` : canActivate ? `<div class="card-footer">
    <button class="activate-btn" onclick="activateOrder('${o.txId}',this)">
      <svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>
      Marcar como Activado
    </button>
  </div>` : ''}
</div>`
      }).join('')

  const historyPagination = isHistoryView && totalPages > 1
    ? `<nav class="history-pagination" aria-label="Paginação do histórico">
  ${page > 1
    ? `<a class="history-page-btn" href="/admin/office?filter=${encodeURIComponent(filter)}&page=${page - 1}" rel="prev">Anterior</a>`
    : '<span class="history-page-btn disabled" aria-disabled="true">Anterior</span>'}
  <span class="history-page-status">Página ${page} de ${totalPages}</span>
  ${page < totalPages
    ? `<a class="history-page-btn" href="/admin/office?filter=${encodeURIComponent(filter)}&page=${page + 1}" rel="next">Próxima</a>`
    : '<span class="history-page-btn disabled" aria-disabled="true">Próxima</span>'}
</nav>`
    : ''
  const historyExport = filter === 'gateway-transactions'
    ? '<a class="history-export-btn" href="/admin/history/export?type=gateway" download="historico-gateway.csv">Exportar histórico</a>'
    : isHistoryView
      ? '<a class="history-export-btn" href="/admin/history/export?type=megabyte" download="historico-megabyte.csv">Exportar histórico</a>'
      : ''

  return `<!DOCTYPE html><html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel Admin — Megabyte</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;}
body{background:#f2f2f7;font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;color:#1c1c1e;display:flex;flex-direction:column;}

/* ── Layout ── */
.layout{display:flex;flex:1;min-height:0;}

/* ── Topbar ── */
.topbar{background:#fff;border-bottom:1px solid #e5e5ea;padding:0 20px;height:56px;display:flex;align-items:center;justify-content:space-between;position:sticky;top:0;z-index:100;flex-shrink:0;}
.topbar-left{display:flex;align-items:center;gap:12px;}
.menu-btn{background:none;border:none;cursor:pointer;padding:8px;border-radius:8px;color:#1c1c1e;display:flex;align-items:center;}
.menu-btn:active{background:#f2f2f7;}
.menu-btn svg{width:22px;height:22px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;}
.topbar-brand{display:flex;align-items:center;gap:8px;}
.topbar-brand img{width:30px;height:30px;object-fit:contain;border-radius:6px;}
.topbar-brand-name{font-size:15px;font-weight:800;color:#1c1c1e;}
.topbar-brand-name span{color:#cc0000;}
.topbar-badge{font-size:11px;font-weight:700;color:#fff;background:#cc0000;border-radius:6px;padding:2px 7px;margin-left:4px;}
.topbar-right{display:flex;align-items:center;gap:20px;}
.topbar-revenue{display:flex;flex-direction:column;align-items:flex-end;gap:1px;}
.revenue-label{font-size:10px;font-weight:700;color:#8e8e93;text-transform:uppercase;letter-spacing:.07em;}
.revenue-value{font-size:17px;font-weight:800;color:#065f46;line-height:1;}
.topbar-divider{width:1px;height:28px;background:#e5e5ea;flex-shrink:0;}
.logout-btn{font-size:13px;font-weight:600;color:#cc0000;text-decoration:none;padding:6px 14px;border-radius:9px;border:1.5px solid #ffcdd2;}
.logout-btn:active{background:#fff0f0;}

/* ── Sidebar ── */
.sidebar-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:150;}
.sidebar-overlay.open{display:block;}
.sidebar{width:264px;background:#fff;border-right:1px solid #e5e5ea;display:flex;flex-direction:column;flex-shrink:0;position:sticky;top:56px;height:calc(100vh - 56px);overflow-y:auto;}
@media(max-width:720px){
  .sidebar{position:fixed;top:0;left:0;height:100vh;z-index:200;transform:translateX(-100%);transition:transform .28s cubic-bezier(.32,.72,0,1);}
  .sidebar.open{transform:translateX(0);}
}
.sidebar-section{padding:12px 12px 4px;font-size:10px;font-weight:700;letter-spacing:.1em;text-transform:uppercase;color:#8e8e93;}
.nav-link{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:11px;text-decoration:none;color:#3a3a3c;font-size:14px;font-weight:500;margin:2px 8px;transition:background .12s,color .12s;}
.nav-link svg{width:18px;height:18px;stroke:currentColor;fill:none;flex-shrink:0;}
.nav-link span:first-of-type{flex:1;}
.nav-link:active,.nav-link.active{background:#fff0f0;color:#cc0000;font-weight:700;}
.nav-link.active svg{stroke:#cc0000;}
.nav-count{font-size:11px;font-weight:700;color:#8e8e93;background:#f2f2f7;border-radius:20px;padding:2px 7px;margin-left:auto;flex-shrink:0;}
.nav-link.active .nav-count{color:#cc0000;background:#ffe4e4;}
.sidebar-footer{margin-top:auto;padding:16px;}
.sidebar-logout{display:flex;align-items:center;gap:10px;padding:10px 14px;border-radius:11px;text-decoration:none;color:#cc0000;font-size:14px;font-weight:600;border:1.5px solid #ffcdd2;justify-content:center;}
.sidebar-logout:active{background:#fff0f0;}

/* ── Main ── */
.main{flex:1;min-width:0;overflow-x:hidden;}
.content{max-width:1100px;margin:0 auto;padding:24px 16px 60px;}

/* ── Stats ── */
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:28px;}
@media(min-width:540px){.stats-grid{grid-template-columns:repeat(4,1fr);}}
.stat-card{background:#fff;border-radius:16px;padding:18px 16px;box-shadow:0 1px 4px rgba(0,0,0,.06);border-left:4px solid transparent;}
.stat-card.s-conf{border-color:#10b981;}
.stat-card.s-act{border-color:#3b82f6;}
.stat-card.s-pend{border-color:#f59e0b;}
.stat-card.s-fail{border-color:#ef4444;}
.stat-card.s-all{border-color:#8b5cf6;}
.stat-num{font-size:28px;font-weight:800;color:#1c1c1e;line-height:1;}
.stat-lbl{font-size:12px;color:#636366;font-weight:600;margin-top:4px;}

/* ── Section header ── */
.section-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.section-title{font-size:13px;font-weight:700;color:#636366;text-transform:uppercase;letter-spacing:.07em;}
.section-count{font-size:13px;font-weight:700;color:#cc0000;background:#fff0f0;border-radius:20px;padding:2px 10px;}
.history-pagination{display:flex;align-items:center;justify-content:center;gap:12px;margin:20px 0 8px;}
.history-page-btn{display:inline-flex;align-items:center;justify-content:center;min-width:92px;padding:9px 14px;border:1.5px solid #e5e5ea;border-radius:10px;background:#fff;color:#3a3a3c;font-size:13px;font-weight:700;text-decoration:none;transition:border-color .12s,color .12s,background .12s;}
.history-page-btn:hover{border-color:#cc0000;color:#cc0000;background:#fffafa;}
.history-page-btn.disabled{color:#c7c7cc;background:#f9f9fb;cursor:not-allowed;}
.history-page-status{font-size:13px;font-weight:700;color:#636366;white-space:nowrap;}
.history-export-btn{display:inline-flex;align-items:center;justify-content:center;padding:9px 14px;border:1.5px solid #cc0000;border-radius:10px;background:#fff;color:#cc0000;font-size:13px;font-weight:700;text-decoration:none;transition:background .12s,color .12s;}
.history-export-btn:hover{background:#cc0000;color:#fff;}

/* ── Order card ── */
.order-card{background:#fff;border-radius:16px;margin-bottom:12px;box-shadow:0 1px 5px rgba(0,0,0,.07);overflow:hidden;}
.card-header{display:flex;align-items:flex-start;justify-content:space-between;padding:14px 16px 10px;}
.card-badge-row{display:flex;align-items:center;gap:8px;margin-bottom:4px;}
.card-date{font-size:11px;color:#8e8e93;}
.card-amount{font-size:22px;font-weight:800;color:#1c1c1e;white-space:nowrap;}
.card-amount span{font-size:13px;font-weight:600;color:#636366;}
.card-divider{height:1px;background:#f2f2f7;margin:0 16px;}
.card-body{padding:12px 16px;display:flex;flex-direction:column;gap:8px;}
.info-row{display:flex;align-items:center;justify-content:space-between;gap:10px;}
.info-label{font-size:12px;color:#8e8e93;font-weight:500;flex-shrink:0;}
.info-label em{font-style:normal;color:#cc0000;font-size:10px;font-weight:700;}
.info-value{font-size:13px;font-weight:600;color:#1c1c1e;text-align:right;}
.info-value.mono{font-family:monospace;font-size:11px;color:#636366;}
.bene-row{display:flex;align-items:center;gap:8px;}
.bene-num{font-size:14px;font-weight:700;color:#1c1c1e;}
.copy-btn{display:flex;align-items:center;gap:5px;background:#f2f2f7;border:none;border-radius:8px;padding:5px 10px;font-size:12px;font-weight:600;color:#636366;cursor:pointer;font-family:inherit;flex-shrink:0;transition:background .12s,color .12s;}
.copy-btn svg{width:13px;height:13px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;}
.copy-btn:active,.copy-btn.copied{background:#d1fae5;color:#065f46;}
.card-footer{padding:10px 16px 14px;}
.delivery-state{font-size:12px;color:#636366;background:#f9f9fb;border-radius:9px;padding:8px 10px;text-align:center;}
.delivery-alert{display:flex;flex-direction:column;gap:5px;padding:12px 16px 14px;background:#fff7ed;border-top:1px solid #fed7aa;color:#9a3412;font-size:12px;}
.delivery-alert strong{font-size:13px;}
.retry-btn{margin-top:4px;padding:10px 12px;border:none;border-radius:10px;background:#c2410c;color:#fff;font-size:13px;font-weight:700;font-family:inherit;cursor:pointer;}
.retry-btn:disabled{opacity:.55;cursor:not-allowed;}
.activate-btn{width:100%;padding:13px;border:none;border-radius:12px;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,#16a34a,#15803d);color:#fff;display:flex;align-items:center;justify-content:center;gap:8px;transition:opacity .15s;}
.activate-btn svg{width:18px;height:18px;stroke:#fff;fill:none;stroke-width:2;}
.activate-btn:active{opacity:.85;}
.activate-btn:disabled{opacity:.45;cursor:not-allowed;}

/* ── Badges & tags ── */
.badge{font-size:11px;font-weight:700;padding:3px 10px;border-radius:20px;display:inline-block;}
.method-tag{font-size:10px;font-weight:700;padding:2px 8px;border-radius:20px;background:#f2f2f7;color:#636366;display:inline-block;}

/* ── Empty ── */
.empty{text-align:center;padding:60px 20px;color:#8e8e93;}
.empty-icon{font-size:48px;margin-bottom:12px;}
.empty p{font-size:14px;}

/* ── ZumboPay table view ── */
.zumbo-panel{max-width:900px;}
.zumbo-info{display:flex;align-items:flex-start;gap:8px;background:#ecfdf5;border:1px solid #6ee7b7;border-radius:12px;padding:12px 14px;font-size:12px;color:#065f46;margin-bottom:18px;line-height:1.5;}
.zumbo-info code{background:#d1fae5;padding:1px 6px;border-radius:4px;font-size:11px;font-family:monospace;}
.ztable-wrap{overflow-x:auto;border-radius:14px;border:1px solid #e5e5ea;background:#fff;box-shadow:0 1px 5px rgba(0,0,0,.07);}
.ztable{width:100%;border-collapse:collapse;font-size:13px;}
.ztable thead tr{background:#f9f9fb;}
.ztable th{padding:11px 14px;text-align:left;font-size:11px;font-weight:700;color:#636366;text-transform:uppercase;letter-spacing:.06em;border-bottom:1px solid #e5e5ea;white-space:nowrap;}
.ztable td{padding:11px 14px;border-bottom:1px solid #f2f2f7;vertical-align:middle;}
.ztable tr:last-child td{border-bottom:none;}
.ztable tr:hover td{background:#fafafa;}
.zt-date{font-size:11px;color:#636366;white-space:nowrap;}
.zt-phone{font-weight:700;font-size:13px;color:#1c1c1e;}
.zt-phone em{font-style:normal;font-size:10px;color:#cc0000;font-weight:700;margin-left:3px;}
.zt-amount{font-weight:800;color:#1c1c1e;white-space:nowrap;}
@media(max-width:640px){.content{max-width:100%;}.zumbo-panel{max-width:100%;}}

/* ── Gateway history ── */
.gateway-panel{max-width:1100px;}
.gateway-intro{display:flex;align-items:flex-start;gap:12px;background:linear-gradient(135deg,#f0fdfa,#ecfeff);border:1px solid #99f6e4;border-radius:16px;padding:16px 18px;margin-bottom:18px;color:#115e59;line-height:1.45;}
.gateway-intro strong{display:block;font-size:15px;color:#134e4a;margin-bottom:3px;}
.gateway-intro p{font-size:12px;color:#0f766e;}
.gateway-mark{width:34px;height:34px;display:flex;align-items:center;justify-content:center;border-radius:11px;background:#0f766e;color:#fff;font-size:23px;line-height:1;flex-shrink:0;}
.gateway-table-wrap{overflow-x:auto;}
.gateway-table{min-width:820px;}
.internal-reference{display:flex;flex-direction:column;gap:2px;font-size:12px;font-weight:700;color:#134e4a;white-space:nowrap;}
.internal-reference small{font-family:monospace;font-size:10px;font-weight:600;color:#0f766e;}
.reference-dot{width:7px;height:7px;border-radius:50%;background:#14b8a6;display:inline-block;margin-bottom:1px;}
.channel-tag{font-size:11px;font-weight:700;color:#4338ca;background:#eef2ff;border:1px solid #c7d2fe;border-radius:20px;padding:4px 8px;white-space:nowrap;}

/* ── Utilizadores ── */
.ubal-badge{display:inline-block;background:#ecfdf5;color:#065f46;font-weight:700;font-size:12px;padding:3px 10px;border-radius:20px;border:1px solid #6ee7b7;}
.uedit-btn{padding:6px 14px;border:1.5px solid #e5e5ea;border-radius:8px;background:#fff;font-size:12px;font-weight:600;color:#636366;cursor:pointer;font-family:inherit;transition:border-color .12s,color .12s;}
.uedit-btn:hover{border-color:#cc0000;color:#cc0000;}

/* ── Toast ── */
.toast{position:fixed;bottom:24px;left:50%;transform:translateX(-50%) translateY(80px);background:#1c1c1e;color:#fff;font-size:13px;font-weight:600;padding:10px 20px;border-radius:20px;z-index:999;opacity:0;transition:all .25s;pointer-events:none;white-space:nowrap;}
.toast.show{opacity:1;transform:translateX(-50%) translateY(0);}
</style>
</head><body>

<!-- Topbar -->
<header class="topbar">
  <div class="topbar-left">
    <button class="menu-btn" onclick="toggleSidebar()" aria-label="Menu">
      <svg viewBox="0 0 24 24"><line x1="3" y1="6" x2="21" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="21" y2="18"/></svg>
    </button>
    <img src="/static/vodacom.webp" alt="logo" style="width:30px;height:30px;object-fit:contain;border-radius:6px;">
    <span style="font-size:11px;font-weight:700;color:#fff;background:#cc0000;border-radius:6px;padding:2px 8px;">Admin</span>
  </div>
  <div class="topbar-right">
    <div class="topbar-revenue">
       <span class="revenue-label">${isGatewayView ? 'Gateway confirmado' : 'Total Megabyte'}</span>
       <span class="revenue-value">${activeTotal.toLocaleString('pt-MZ')} MT</span>
    </div>
    <div class="topbar-divider"></div>
    <a href="/admin/logout" class="logout-btn">Sair</a>
  </div>
</header>

<div class="layout">
  <!-- Sidebar overlay (mobile) -->
  <div class="sidebar-overlay" id="sidebarOverlay" onclick="toggleSidebar()"></div>

  <!-- Sidebar -->
  <aside class="sidebar" id="sidebar">
    ${sidebarLinks}
    <div class="sidebar-footer">
      <a href="/admin/logout" class="sidebar-logout">
        <svg viewBox="0 0 24 24" style="width:16px;height:16px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4M16 17l5-5-5-5M21 12H9"/></svg>
        Terminar Sessão
      </a>
    </div>
  </aside>

  <!-- Main content -->
  <main class="main">
    <div class="content">

      <!-- Stats -->
      <div class="stats-grid">
        ${statsCards}
      </div>

      <!-- Orders -->
      <div class="section-hd">
        <div style="display:flex;align-items:center;gap:12px;min-width:0">
          <span class="section-title">${pageTitle}</span>
          ${historyExport}
        </div>
        <span class="section-count">${filtered.length} registos${isHistoryView && totalPages > 1 ? ` · Página ${page} de ${totalPages}` : ''}</span>
      </div>
      ${cards}
      ${historyPagination}
    </div>
  </main>
</div>

<div class="toast" id="toast"></div>

<script>
function toggleSidebar(){
  document.getElementById('sidebar').classList.toggle('open')
  document.getElementById('sidebarOverlay').classList.toggle('open')
}
function showToast(msg,ok=true){
  const t=document.getElementById('toast')
  t.textContent=msg; t.style.background=ok?'#1c1c1e':'#cc0000'
  t.classList.add('show'); setTimeout(()=>t.classList.remove('show'),2500)
}
function copyNum(num,btn){
  navigator.clipboard.writeText(num).then(()=>{
    btn.classList.add('copied'); btn.textContent='✓ Copiado'
    showToast('Número copiado: '+num)
    setTimeout(()=>{btn.classList.remove('copied');btn.innerHTML='<svg viewBox="0 0 24 24"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1"/></svg> Copiar'},2000)
  }).catch(()=>{
    prompt('Copie o número:',num)
  })
}
// ── User edit ──────────────────────────────────────────────────────────────
let _ueditId=null, _ueditCurBal=0
function openUserEdit(id,name,phone,bal){
  _ueditId=id; _ueditCurBal=bal
  document.getElementById('uedit-phone-lbl').textContent='Número: '+phone
  document.getElementById('uedit-name').value=name
  document.getElementById('uedit-phone').value=phone
  document.getElementById('uedit-bal-delta').value=0
  document.getElementById('uedit-cur-bal').textContent=bal.toLocaleString('pt-MZ')
  document.getElementById('uedit-new-bal').textContent=bal.toLocaleString('pt-MZ')
  document.getElementById('uedit-newpass').value=''
  document.getElementById('uedit-err').style.display='none'
  const save=document.getElementById('uedit-save'); save.disabled=false; save.textContent='Guardar'
  document.getElementById('user-modal').style.display='flex'
  document.getElementById('uedit-bal-delta').oninput=updateBalPreview
}
function updateBalPreview(){
  const delta=parseFloat(document.getElementById('uedit-bal-delta').value)||0
  const novo=Math.max(0,_ueditCurBal+delta)
  document.getElementById('uedit-new-bal').textContent=novo.toLocaleString('pt-MZ')
}
function setBalDelta(sign){
  const el=document.getElementById('uedit-bal-delta')
  const step=50; el.value=(parseFloat(el.value)||0)+sign*step; updateBalPreview()
}
function closeUserEdit(){ document.getElementById('user-modal').style.display='none' }
async function saveUserEdit(){
  const name=document.getElementById('uedit-name').value.trim()
  const phone=document.getElementById('uedit-phone').value.trim().replace(/\\D/g,'')
  const delta=parseFloat(document.getElementById('uedit-bal-delta').value)||0
  const newpass=document.getElementById('uedit-newpass').value
  const err=document.getElementById('uedit-err'); err.style.display='none'
  if(!name){err.textContent='Nome é obrigatório.';err.style.display='block';return}
  if(phone.length!==9){err.textContent='Número deve ter 9 dígitos.';err.style.display='block';return}
  if(newpass&&newpass.length<6){err.textContent='Nova senha deve ter pelo menos 6 caracteres.';err.style.display='block';return}
  const save=document.getElementById('uedit-save'); save.disabled=true; save.textContent='A guardar…'
  const body={name,phone}
  if(delta!==0) body.balanceDelta=delta
  if(newpass) body.newPassword=newpass
  try{
    const r=await fetch('/admin/users/'+_ueditId,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})
    const d=await r.json()
    if(!r.ok){err.textContent=d.error||'Erro.';err.style.display='block';save.disabled=false;save.textContent='Guardar';return}
    showToast('Utilizador actualizado com sucesso!')
    closeUserEdit()
    setTimeout(()=>location.reload(),800)
  }catch{err.textContent='Erro de ligação.';err.style.display='block';save.disabled=false;save.textContent='Guardar'}
}

// ── Gateway keys ───────────────────────────────────────────────────────────
async function gwCreate(){
  const name=document.getElementById('gw-name').value.trim()
  if(!name){showToast('Escreva o nome do projecto.',false);return}
  try{
    const r=await fetch('/admin/gateway/keys',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name})})
    const d=await r.json()
    if(!r.ok){showToast(d.error||'Erro.',false);return}
    showToast('Chave criada!')
    setTimeout(()=>location.reload(),700)
  }catch{showToast('Erro de ligação.',false)}
}
async function gwToggle(id){
  try{
    const r=await fetch('/admin/gateway/keys/'+id+'/toggle',{method:'POST'})
    if(r.ok){showToast('Estado alterado.');setTimeout(()=>location.reload(),600)}
    else showToast('Erro.',false)
  }catch{showToast('Erro de ligação.',false)}
}
async function gwDelete(id,name){
  if(!confirm('Eliminar a chave de "'+name+'"? O site que a usa deixará de conseguir cobrar.'))return
  try{
    const r=await fetch('/admin/gateway/keys/'+id+'/delete',{method:'POST'})
    if(r.ok){showToast('Chave eliminada.');setTimeout(()=>location.reload(),600)}
    else showToast('Erro.',false)
  }catch{showToast('Erro de ligação.',false)}
}
async function doManualCredit(){
  const ref=document.getElementById('mc-ref').value.trim()
  const phone=document.getElementById('mc-phone').value.trim().replace(/\\D/g,'')
  const amount=parseInt(document.getElementById('mc-amount').value)
  const err=document.getElementById('mc-err'), ok=document.getElementById('mc-ok')
  err.style.display='none'; ok.style.display='none'
  if(!ref){err.textContent='Referência ZumboPay obrigatória.';err.style.display='block';return}
  if(phone.length<9){err.textContent='Número deve ter 9 dígitos.';err.style.display='block';return}
  if(!amount||amount<1){err.textContent='Valor inválido.';err.style.display='block';return}
  try{
    const r=await fetch('/admin/manual-credit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({zumboRef:ref,phone,amount})})
    const d=await r.json()
    if(!r.ok){err.textContent=d.error||'Erro.';err.style.display='block';return}
    ok.textContent='✓ '+d.name+' ('+d.phone+') creditado '+amount+' MT — novo saldo: '+d.newBalance+' MT'
    ok.style.display='block'
    document.getElementById('mc-ref').value=''
    document.getElementById('mc-phone').value=''
    document.getElementById('mc-amount').value=''
  }catch{err.textContent='Erro de ligação.';err.style.display='block'}
}
async function gwRename(id,currentName){
  const newName=prompt('Novo nome para a chave:',currentName)
  if(!newName||!newName.trim())return
  try{
    const r=await fetch('/admin/gateway/keys/'+id+'/rename',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({name:newName.trim()})})
    const d=await r.json()
    if(r.ok){showToast('Nome actualizado para "'+d.name+'".');setTimeout(()=>location.reload(),700)}
    else showToast(d.error||'Erro.',false)
  }catch{showToast('Erro de ligação.',false)}
}
async function activateOrder(txId,btn){
  if(!confirm('Confirma que os megas foram enviados para o beneficiário?')) return
  btn.disabled=true; btn.textContent='A guardar…'
  try {
    const r=await fetch('/admin/activate',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({txId})})
    const d=await r.json()
    if(r.ok){
      showToast('Activação registada com sucesso!')
      const card=document.getElementById('card-'+txId)
      if(card){
        card.querySelector('.card-footer').remove()
        card.querySelector('.badge').textContent='Activado'
        card.querySelector('.badge').style.cssText='color:#1e3a8a;background:#dbeafe'
      }
    } else { showToast(d.error||'Erro ao guardar.',false); btn.disabled=false; btn.textContent='Marcar como Activado' }
  } catch { showToast('Erro de ligação.',false); btn.disabled=false; btn.textContent='Marcar como Activado' }
}
async function retryDelivery(txId,btn){
  if(!confirm('Confirma que quer repetir a entrega deste pacote?')) return
  btn.disabled=true; btn.textContent='A reenviar…'
  try {
    const r=await fetch('/admin/retry-delivery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({txId})})
    const d=await r.json()
    if(r.ok){
      showToast('Entrega novamente colocada na fila!')
      setTimeout(()=>location.reload(),700)
    } else {
      showToast(d.error||'Não foi possível repetir a entrega.',false)
      btn.disabled=false; btn.textContent='Reprocessar entrega'
    }
  } catch {
    showToast('Erro de ligação.',false)
    btn.disabled=false; btn.textContent='Reprocessar entrega'
  }
}
async function retryPagarForwarding(eventId,btn){
  if(!eventId||!confirm('Confirma que quer repetir o encaminhamento desta confirmação de pagamento?')) return
  btn.disabled=true; btn.textContent='A reenviar…'
  try {
    const r=await fetch('/admin/retry-pagar-forwarding',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({eventId})})
    const d=await r.json()
    if(r.ok){
      showToast('Encaminhamento colocado novamente na fila!')
      setTimeout(()=>location.reload(),700)
    } else {
      showToast(d.error||'Não foi possível repetir o encaminhamento.',false)
      btn.disabled=false; btn.textContent='Reprocessar encaminhamento'
    }
  } catch {
    showToast('Erro de ligação.',false)
    btn.disabled=false; btn.textContent='Reprocessar encaminhamento'
  }
}
</script>
</body></html>`
}

// ── Servidor ──────────────────────────────────────────────────────────────────
const requiredConfig = [
  'PAGAR_API_KEY',
  'PAGAR_SIGNING_SECRET',
  'PAGAR_WEBHOOK_SECRET',
  'ADMIN_PASS',
  'SESSION_SECRET',
]
const missingConfig = requiredConfig.filter(key => !process.env[key])
const isLiveConfiguration = isTestMode || missingConfig.length === 0

await dbInit()
await loadOrders()
await loadUsers()
await loadRechargeCredits()
await recoverRechargeCredits()
await loadGwKeys()
createServer((req, res) => {
  router(req, res).catch(err => {
    console.error('[Server]', err)
    try { json(res, { error:'Erro interno.' }, 500) } catch {}
  })
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Megabyte a correr em :${PORT}`)
  console.log('Admin: /admin/office')
})
