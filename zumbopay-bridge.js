/**
 * Net Serviços — Plataforma de internet e pagamentos em Moçambique
 * Node.js puro · zero dependências externas
 */

import { createServer }                              from 'http'
import { createHmac, timingSafeEqual, randomBytes }  from 'crypto'
import { readFile, writeFile }                       from 'fs/promises'

// ── Configuração ──────────────────────────────────────────────────────────────
const PORT                 = process.env.PORT || 5000
const ZUMBO_API_KEY        = process.env.ZUMBO_API_KEY        || 'zk_live_a694231e0f188fe3599e4de8feda28b35714ed9b6fa3cd0e'
const ZUMBO_MERCHANT_ID    = process.env.ZUMBO_MERCHANT_ID    || 'MCH_B29C53549C'
const ZUMBO_WEBHOOK_SECRET = process.env.ZUMBO_WEBHOOK_SECRET || 'teste.com'
const ZUMBO_BASE           = 'https://zumbopay.com/api/public/v1'
const WALLET_MPESA         = process.env.WALLET_MPESA         || 'd9a21461-8ff3-4929-8015-efd89268a068'
const WALLET_EMOLA         = process.env.WALLET_EMOLA         || '93a03d6d-f361-4602-90e1-c62889b45346'
const ADMIN_PASS           = process.env.ADMIN_PASS           || '00220022aA1'
const ORDERS_FILE          = './orders.json'
const USERS_FILE           = './users.json'

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
const transactions  = new Map()
const sseClients    = new Map()
let   orders        = []           // persiste em ORDERS_FILE

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
async function loadUsers() { try { users = JSON.parse(await readFile(USERS_FILE,'utf8')) } catch {} }
async function saveUsers() { try { await writeFile(USERS_FILE, JSON.stringify(users,null,2)) } catch {} }
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

// ── Persistência de encomendas ────────────────────────────────────────────────
async function loadOrders() {
  try { orders = JSON.parse(await readFile(ORDERS_FILE, 'utf8')) } catch {}
}
async function saveOrders() {
  try { await writeFile(ORDERS_FILE, JSON.stringify(orders, null, 2)) } catch {}
}
function trackOrder(tx, extra = {}) {
  const rec = {
    txId: tx.id, type: tx.type || 'bundle', phone: tx.phone,
    beneficiaryPhone: tx.beneficiaryPhone || null,
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
function json(res, data, status = 200, extraHeaders = {}) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...extraHeaders })
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
  if (method === 'GET' && path === '/static/vodafone-logo.jpg') {
    try { const img = await import('fs/promises').then(f=>f.readFile('./attached_assets/20927248-vodafone-marca-logotipo-telefone-simbolo-vermelho-pro_1786173611755.jpg')); res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'max-age=86400'}); return res.end(img) } catch { res.writeHead(404); return res.end() }
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
    const { phone, beneficiaryPhone, bundleId } = body
    const bundle = BUNDLES.get(bundleId)
    if (!bundle) return json(res, { error:'Pacote inválido.' }, 400)
    const msisdn = normalizeMsisdn(phone), meth = detectMethod(msisdn)
    if (!meth) return json(res, { error:'Número inválido. Use 84 ou 85.' }, 400)
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'bundle', bundleId, bundleLabel:bundle.label, phone, beneficiaryPhone: beneficiaryPhone||null, msisdn, amount:bundle.price, method:meth, status:'pending', ref:null, error:null, ts:new Date().toISOString() }
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
          if (status === 'succeeded' && tx.type === 'recharge' && tx.userId) {
            const u = findUserById(tx.userId)
            if (u) { u.balance = (u.balance||0) + tx.amount; saveUsers().catch(()=>{}) }
          }
          console.log(`[Webhook] ${txId} → ${status}`)
          break
        }
      }
    }
    return json(res, { ok:true })
  }

  // ── Auth: Criar conta ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/auth/register') {
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { name, phone, password } = body
    if (!name||!name.trim())       return json(res, { error:'Nome é obrigatório.' }, 400)
    if (!phone||String(phone).replace(/\D/g,'').length !== 9)
                                   return json(res, { error:'Número deve ter 9 dígitos.' }, 400)
    if (!password||password.length < 6) return json(res, { error:'Senha deve ter pelo menos 6 caracteres.' }, 400)
    const ph = String(phone).replace(/\D/g,'')
    if (findUserByPhone(ph))       return json(res, { error:'Este número já tem uma conta.' }, 409)
    const salt = randomBytes(16).toString('hex')
    const user = { id: randomBytes(6).toString('hex'), name: name.trim(), phone: ph, passwordHash: hashPwd(password, salt), salt, balance: 0, createdAt: new Date().toISOString() }
    users.push(user)
    await saveUsers()
    const pub = { id:user.id, name:user.name, phone:user.phone, balance:user.balance }
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
    const pub = { id:user.id, name:user.name, phone:user.phone, balance:user.balance }
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
    return json(res, { id:user.id, name:user.name, phone:user.phone, balance:user.balance||0 })
  }

  // ── Recarga de crédito ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/recharge') {
    const user = checkUserCookie(req)
    if (!user) return json(res, { error:'Faça login para recarregar.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const amount = parseInt(body.amount)
    if (!amount || amount < 1) return json(res, { error:'Valor inválido.' }, 400)
    const msisdn = normalizeMsisdn(user.phone), meth = detectMethod(msisdn)
    if (!meth) return json(res, { error:'Número de conta inválido para STK Push.' }, 400)
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'recharge', bundleId:null, bundleLabel:`Recarga ${amount} MT`, phone:user.phone, beneficiaryPhone:null, msisdn, amount, method:meth, status:'pending', ref:null, error:null, ts:new Date().toISOString(), userId:user.id }
    transactions.set(txId, tx)
    trackOrder(tx)
    json(res, { txId, status:'pending', method:meth })
    initiateCharge(tx, `rch-${txId}`, `Recarga Net Serviços ${amount} MT`)
    return
  }

  // ── Compra com crédito ────────────────────────────────────────────────────
  if (method === 'POST' && path === '/api/buy-credit') {
    const user = checkUserCookie(req)
    if (!user) return json(res, { error:'Faça login para comprar com crédito.' }, 401)
    let body = {}; try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { bundleId, beneficiaryPhone } = body
    const bundle = BUNDLES.get(bundleId)
    if (!bundle) return json(res, { error:'Pacote inválido.' }, 400)
    if ((user.balance||0) < bundle.price) return json(res, { error:`Saldo insuficiente. Tens ${user.balance||0} MT, precisas de ${bundle.price} MT.` }, 402)
    user.balance = (user.balance||0) - bundle.price
    await saveUsers()
    const txId = randomBytes(6).toString('hex')
    const tx = { id:txId, type:'bundle', bundleId, bundleLabel:bundle.label, phone:user.phone, beneficiaryPhone:beneficiaryPhone||null, msisdn:normalizeMsisdn(user.phone), amount:bundle.price, method:'credit', status:'succeeded', ref:'credit-'+txId, error:null, ts:new Date().toISOString(), userId:user.id }
    transactions.set(txId, tx)
    trackOrder(tx)
    updateOrderStatus(txId, 'succeeded')
    return json(res, { ok:true, txId, newBalance:user.balance })
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
      const q = parseQuery(req)
      return html(res, adminDashboard(q.filter || 'all'))
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

  // ── API pública de transações (Bearer token = ADMIN_PASS ou cookie admin) ────
  if (method === 'GET' && path === '/api/transactions') {
    const auth  = req.headers['authorization'] || ''
    const token = auth.startsWith('Bearer ') ? auth.slice(7) : ''
    const authed = checkAdminCookie(req) || (token && safeEqual(token, ADMIN_PASS))
    if (!authed) return json(res, { error:'Não autorizado. Inclua o header: Authorization: Bearer <senha_admin>' }, 401)
    const q     = parseQuery(req)
    const page  = Math.max(1, parseInt(q.page)  || 1)
    const limit = Math.min(100, Math.max(1, parseInt(q.limit) || 50))
    const total = orders.length
    const data  = orders.slice((page - 1) * limit, page * limit).map(o => ({
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
.sheet.pending-full{bottom:auto!important;top:50%!important;left:50%!important;right:auto!important;width:88%!important;max-width:380px!important;border-radius:22px!important;max-height:90vh!important;transform:translate(-50%,-50%)!important;}
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
.nav-bal-ico{width:16px;height:16px;flex-shrink:0;stroke:#cc0000;}
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
.drawer-user-bal{font-size:13px;color:#cc0000;font-weight:700;}

/* ── Método de pagamento (via-btns) ── */
.via-section{padding:4px 0 12px;}
.via-section-lbl{font-size:11px;font-weight:700;color:#8e8e93;text-transform:uppercase;letter-spacing:.07em;margin-bottom:8px;padding:0 2px;}
.via-btns{display:grid;grid-template-columns:1fr 1fr;gap:8px;}
.via-btn{display:flex;align-items:center;gap:8px;padding:8px 10px;border-radius:10px;border:1.5px solid #e5e5ea;background:#fff;cursor:pointer;font-family:inherit;text-align:left;transition:border-color .15s,background .15s;width:100%;}
.via-btn.active{border-color:#cc0000;background:#fff0f0;}
.via-btn:disabled{opacity:.45;cursor:not-allowed;}
.via-btn-icon{flex-shrink:0;display:flex;align-items:center;justify-content:center;}
.via-btn-icon svg{width:16px;height:16px;}
.via-btn-label{font-size:12px;font-weight:700;color:#1c1c1e;line-height:1.2;}
.via-btn-sub{font-size:11px;color:#8e8e93;margin-top:1px;}
.via-btn.active .via-btn-label{color:#cc0000;}
.via-btn.active .via-btn-sub{color:#cc0000;}
.via-credit-bal{display:block;font-size:11px;font-weight:700;color:#065f46;margin-top:1px;}

/* ── Auth modal ── */
.auth-modal{position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:500;display:none;align-items:center;justify-content:center;padding:20px;backdrop-filter:blur(4px);}
.auth-card{background:#fff;border-radius:24px;width:100%;max-width:380px;box-shadow:0 20px 60px rgba(0,0,0,.2);transform:translateY(30px) scale(.97);opacity:0;transition:transform .28s cubic-bezier(.32,.72,0,1),opacity .2s;overflow:hidden;}
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
    <img src="/static/vodacom.webp" alt="Net Serviços" class="nav-logo-img">
    <div class="nav-logo-text">Net <span>Serviços</span></div>
  </a>
  <div id="nav-balance" class="nav-balance">
    <svg class="nav-bal-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v2m0 8v2M9.5 9.5C9.5 8.12 10.62 7 12 7s2.5 1.12 2.5 2.5S13.38 12 12 12s-2.5 1.12-2.5 2.5S10.62 17 12 17s2.5-1.12 2.5-2.5"/></svg>
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
        <span class="drawer-user-bal" id="drawer-user-bal">0 MT</span>
      </li>
      <li><a href="#" onclick="closeDrawer();openRechargeDialog()">
        <span class="dm-icon"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v2m0 8v2M9.5 9.5C9.5 8.12 10.62 7 12 7s2.5 1.12 2.5 2.5S13.38 12 12 12s-2.5 1.12-2.5 2.5S10.62 17 12 17s2.5-1.12 2.5-2.5"/></svg></span>
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

<footer class="site-footer">
  <div class="footer-top">
    <div class="footer-brand">
      <div class="footer-logo-wrap"><img src="/static/vodafone-logo.jpg" alt="Net Serviços" class="footer-logo-img"></div>
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
    <div class="footer-support">
      <p class="footer-support-title">Apoio ao Cliente</p>
      <div class="footer-support-cards">
        <a href="tel:876563910" class="footer-support-card">
          <div class="footer-support-icon phone">
            <svg viewBox="0 0 24 24"><path d="M22 16.92v3a2 2 0 01-2.18 2 19.79 19.79 0 01-8.63-3.07A19.5 19.5 0 013.09 9.8a19.79 19.79 0 01-3.07-8.67A2 2 0 012 2h3a2 2 0 012 1.72c.127.96.361 1.903.7 2.81a2 2 0 01-.45 2.11L6.09 7.91a16 16 0 006 6l1.27-1.27a2 2 0 012.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0122 16.92z"/></svg>
          </div>
          <span class="footer-support-label">Contactar Suporte via Chamada</span>
        </a>
        <a href="https://wa.me/258876563910" target="_blank" rel="noopener" class="footer-support-card">
          <div class="footer-support-icon whatsapp">
            <svg viewBox="0 0 24 24" fill="#fff"><path d="M17.472 14.382c-.297-.149-1.758-.867-2.03-.967-.273-.099-.471-.148-.67.15-.197.297-.767.966-.94 1.164-.173.199-.347.223-.644.075-.297-.15-1.255-.463-2.39-1.475-.883-.788-1.48-1.761-1.653-2.059-.173-.297-.018-.458.13-.606.134-.133.298-.347.446-.52.149-.174.198-.298.298-.497.099-.198.05-.371-.025-.52-.075-.149-.669-1.612-.916-2.207-.242-.579-.487-.5-.669-.51-.173-.008-.371-.01-.57-.01-.198 0-.52.074-.792.372-.272.297-1.04 1.016-1.04 2.479 0 1.462 1.065 2.875 1.213 3.074.149.198 2.096 3.2 5.077 4.487.709.306 1.262.489 1.694.625.712.227 1.36.195 1.871.118.571-.085 1.758-.719 2.006-1.413.248-.694.248-1.289.173-1.413-.074-.124-.272-.198-.57-.347z"/><path d="M12 0C5.373 0 0 5.373 0 12c0 2.123.554 4.118 1.528 5.847L.057 23.882a.5.5 0 00.606.63l6.266-1.643A11.94 11.94 0 0012 24c6.627 0 12-5.373 12-12S18.627 0 12 0zm0 22c-1.907 0-3.686-.528-5.204-1.443l-.374-.22-3.878 1.018 1.037-3.785-.241-.389A9.96 9.96 0 012 12C2 6.477 6.477 2 12 2s10 4.477 10 10-4.477 10-10 10z"/></svg>
          </div>
          <span class="footer-support-label">Contactar Suporte via WhatsApp</span>
        </a>
      </div>
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
      <input class="sh-inp" id="sh-phone" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric" autocomplete="off">
      <span class="sh-hint">84 ou 85</span>
    </div>

    <!-- Tab: Para Outro -->
    <div class="sh-panel" id="sh-tab-outro" style="display:none">
      <label class="sh-lbl">Introduza o seu número</label>
      <input class="sh-inp" id="sh-phone-payer" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric" autocomplete="off">
      <span class="sh-hint">84 ou 85</span>
      <label class="sh-lbl">Introduza o número do beneficiário</label>
      <input class="sh-inp" id="sh-phone-bene" type="tel" placeholder="Número de telemóvel" maxlength="9" inputmode="numeric" autocomplete="off">
      <span class="sh-hint">84 ou 85</span>
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
        <button class="via-btn active" data-via="mpesa" onclick="selectPayVia('mpesa')">
          <span class="via-btn-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
          </span>
          <div>
            <div class="via-btn-label">M-Pesa</div>
          </div>
        </button>
        <button class="via-btn" id="via-credit" data-via="credit" onclick="selectPayVia('credit')">
          <span class="via-btn-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M12 6v2m0 8v2M9.5 9.5C9.5 8.12 10.62 7 12 7s2.5 1.12 2.5 2.5S13.38 12 12 12s-2.5 1.12-2.5 2.5S10.62 17 12 17s2.5-1.12 2.5-2.5"/></svg>
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
      <span class="credit-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" style="width:14px;height:14px;vertical-align:middle;margin-right:4px"><circle cx="12" cy="12" r="10"/><path d="M12 6v2m0 8v2M9.5 9.5C9.5 8.12 10.62 7 12 7s2.5 1.12 2.5 2.5S13.38 12 12 12s-2.5 1.12-2.5 2.5S10.62 17 12 17s2.5-1.12 2.5-2.5"/></svg>Pago com Crédito</span>
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
        <div class="auth-card-title">Net Serviços</div>
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
        <div style="margin-bottom:12px;display:flex;justify-content:center"><svg viewBox="0 0 24 24" fill="none" stroke="#cc0000" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="width:52px;height:52px"><circle cx="12" cy="12" r="10"/><path d="M12 6v2m0 8v2M9.5 9.5C9.5 8.12 10.62 7 12 7s2.5 1.12 2.5 2.5S13.38 12 12 12s-2.5 1.12-2.5 2.5S10.62 17 12 17s2.5-1.12 2.5-2.5"/></svg></div>
        <div class="auth-card-title">Recarregar Saldo</div>
        <div class="auth-card-sub">O pagamento é processado via M-Pesa</div>
      </div>
      <div class="auth-body">
        <div class="rech-amount-wrap">
          <span class="rech-amount-prefix">MT</span>
          <input class="auth-inp rech-inp" id="rech-amount" type="number" min="1" placeholder="Valor a recarregar" inputmode="numeric">
        </div>
        <div class="auth-err" id="rech-err"></div>
        <button class="auth-btn" id="rech-btn" onclick="submitRecharge()">Pagar com M-Pesa</button>
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
    document.getElementById('drawer-user-bal').textContent = (u.balance||0).toLocaleString('pt-MZ') + ' MT saldo'
    if (srch) srch.style.display = 'none'
  } else {
    nb.style.display = 'none'
    dlo.style.display = 'block'
    dli.style.display = 'none'
    if (srch) srch.style.display = 'flex'
  }
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
  const phone=document.getElementById('reg-phone').value.trim().replace(/\D/g,'')
  const pass=document.getElementById('reg-pass').value
  const pass2=document.getElementById('reg-pass2').value
  const err=document.getElementById('reg-err'); err.style.display='none'
  if (!name){err.textContent='Introduza o seu nome.';err.style.display='block';return}
  if (phone.length!==9){err.textContent='Número deve ter 9 dígitos.';err.style.display='block';return}
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
  const phone=document.getElementById('login-phone').value.trim().replace(/\D/g,'')
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

// ── Recarga ──────────────────────────────────────────────────────────────────
function openRechargeDialog() {
  document.getElementById('rech-amount').value=''
  document.getElementById('rech-err').style.display='none'
  const btn=document.getElementById('rech-btn'); btn.disabled=false; btn.textContent='Pagar com M-Pesa'
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
  if(!amount||amount<1){err.textContent='Introduza um valor válido.';err.style.display='block';return}
  const btn=document.getElementById('rech-btn'); btn.disabled=true; btn.textContent='A processar…'
  try {
    const r=await fetch('/api/recharge',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({amount})})
    const d=await r.json()
    if(!r.ok){err.textContent=d.error||'Erro ao processar.';err.style.display='block';btn.disabled=false;btn.textContent='Pagar com M-Pesa';return}
    closeRechargeDialog()
    document.getElementById('rech-method-lbl').textContent='M-Pesa'
    document.getElementById('overlay').classList.add('open')
    setTimeout(()=>document.getElementById('sheet').classList.add('open'),10)
    shShow('recharging')
    listenRecharge(d.txId, amount)
  } catch{err.textContent='Erro de ligação.';err.style.display='block';btn.disabled=false;btn.textContent='Pagar com M-Pesa'}
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
let payVia = 'mpesa'

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
  document.getElementById('sh-phone').value = ''
  document.getElementById('sh-err').style.display = 'none'
  payVia = 'mpesa'
  document.querySelectorAll('.via-btn').forEach(b => b.classList.toggle('active', b.dataset.via==='mpesa'))
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
    const phone=document.getElementById('sh-phone-payer').value.trim().replace(/\D/g,'')
    const bene=document.getElementById('sh-phone-bene').value.trim().replace(/\D/g,'')
    return { phone, beneficiaryPhone:bene, error: !phone?'Introduza o seu número de pagamento.':phone.length!==9||!/^(84|85)/.test(phone)?'Número de pagamento inválido. Use 84 ou 85.':!bene?'Introduza o número do beneficiário.':bene.length!==9?'Número do beneficiário deve ter 9 dígitos.':null }
  }
  const phone=document.getElementById('sh-phone').value.trim().replace(/\D/g,'')
  return { phone, beneficiaryPhone:null, error: !phone?'Introduza o número de telemóvel.':phone.length!==9?'O número deve ter exactamente 9 dígitos.':!/^(84|85)/.test(phone)?'Número inválido. Use 84 ou 85.':null }
}

async function pay() {
  if (payVia === 'credit') { await payWithCredit(); return }
  const ee = document.getElementById('sh-err'); ee.style.display='none'
  const {phone, beneficiaryPhone, error} = getPhoneFromSheet()
  if (error) { ee.textContent=error; ee.style.display='block'; return }
  const btn = document.getElementById('sh-btn'); btn.disabled=true; btn.textContent='A processar…'
  try {
    const payload={phone,bundleId:curPkg.id}; if(beneficiaryPhone) payload.beneficiaryPhone=beneficiaryPhone
    const r = await fetch('/api/order',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)})
    const d = await r.json()
    if (!r.ok) { ee.textContent=d.error||'Erro ao processar.'; ee.style.display='block'; btn.disabled=false; btn.textContent='Próximo'; return }
    document.getElementById('sh-method-lbl').textContent = 'M-Pesa'
    document.getElementById('sh-ok-pkg').textContent = curPkg.name+' — '+curPkg.price+' MT'
    shShow('pending'); listenOrder(d.txId)
  } catch { ee.textContent='Erro de ligação. Tente novamente.'; ee.style.display='block'; btn.disabled=false; btn.textContent='Próximo' }
}
async function payWithCredit() {
  const ee = document.getElementById('sh-err'); ee.style.display='none'
  const {phone, beneficiaryPhone, error} = getPhoneFromSheet()
  if (shCurTab !== 'req' && error) { ee.textContent=error; ee.style.display='block'; return }
  const btn=document.getElementById('sh-btn'); btn.disabled=true; btn.textContent='A debitar crédito…'
  try {
    const payload={bundleId:curPkg.id}
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

// Init: diarias já visível por defeito (HTML pré-renderizado)
checkAuth()
</script>
</body></html>`
}


// ── Admin: Login ──────────────────────────────────────────────────────────────
function adminLoginPage(err = '') {
  return `<!DOCTYPE html><html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Admin — Net Serviços</title>
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
    <div class="logo-text">Net <span>Serviços</span></div>
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
function adminDashboard(filter = 'all') {
  const counts = { all:0, pending:0, succeeded:0, activated:0, failed:0 }
  let totalReceived = 0
  orders.forEach(o => {
    counts.all++
    if (counts[o.status] !== undefined) counts[o.status]++
    if (o.status==='succeeded'||o.status==='activated') totalReceived += (o.amount||0)
  })

  const filterMap = {
    all:       orders,
    zumbo:     orders,
    users:     users,
    pending:   orders.filter(o=>o.status==='pending'),
    succeeded: orders.filter(o=>o.status==='succeeded'),
    activated: orders.filter(o=>o.status==='activated'),
    failed:    orders.filter(o=>o.status==='failed'),
  }
  const filtered = filterMap[filter] ?? orders

  const SL = { pending:'A aguardar pagamento', succeeded:'Pagamento confirmado', activated:'Activado', failed:'Falhado' }
  const SC = { pending:'#92400e', succeeded:'#065f46', activated:'#1e3a8a', failed:'#991b1b' }
  const SBG= { pending:'#fef3c7', succeeded:'#d1fae5', activated:'#dbeafe', failed:'#fee2e2' }
  const ML = { mpesa:'M-Pesa', emola:'M-Pesa' }

  const navSections = [
    { label: 'ZumboPay', items: [
      { f:'zumbo', label:'Transações ZumboPay', icon:'M12 2a10 10 0 100 20A10 10 0 0012 2zm1 14H11v-4H9l3-6 3 6h-2v4z' },
    ]},
    { label: 'Utilizadores', items: [
      { f:'users', label:'Contas de Utilizadores', icon:'M17 21v-2a4 4 0 00-4-4H5a4 4 0 00-4 4v2M9 11a4 4 0 100-8 4 4 0 000 8zM23 21v-2a4 4 0 00-3-3.87M16 3.13a4 4 0 010 7.75' },
    ]},
    { label: 'Encomendas', items: [
      { f:'all',       label:'Todas as transacções',   icon:'M3 7h18M3 12h18M3 17h18' },
      { f:'succeeded', label:'Pendentes de Activação', icon:'M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z' },
      { f:'activated', label:'Activações Confirmadas', icon:'M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z' },
      { f:'pending',   label:'A aguardar Pagamento',   icon:'M3 10h18M7 15h1m4 0h1m-7 4h12a3 3 0 003-3V8a3 3 0 00-3-3H6a3 3 0 00-3 3v8a3 3 0 003 3z' },
      { f:'failed',    label:'Pagamentos Falhados',    icon:'M10 14l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2m7-2a9 9 0 11-18 0 9 9 0 0118 0z' },
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

  const pageTitle = allNavItems.find(n=>n.f===filter)?.label || 'Todas as transacções'

  // ── Vista especial: tabela ZumboPay ─────────────────────────────────────────
  const zumboTable = filter === 'zumbo'
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
      <th>Data / Hora</th><th>Número (Pagador)</th><th>Beneficiário</th><th>Oferta</th><th>Valor</th><th>Método</th><th>Estado</th>
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
      return `<tr>
        <td class="zt-date">${ds}</td>
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
        <td><strong>${u.name}</strong></td>
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

  const cards = usersTable !== null ? usersTable
    : zumboTable !== null ? zumboTable
    : filtered.length === 0
    ? `<div class="empty"><div class="empty-icon">📭</div><p>Nenhuma transacção encontrada.</p></div>`
    : filtered.map(o => {
        const dt = new Date(o.ts)
        const ds = dt.toLocaleDateString('pt-MZ',{day:'2-digit',month:'short',year:'numeric'})
          + ' ' + dt.toLocaleTimeString('pt-MZ',{hour:'2-digit',minute:'2-digit'})
        const benef = o.beneficiaryPhone || o.phone
        const isForOther = o.beneficiaryPhone && o.beneficiaryPhone !== o.phone
        const canActivate = o.status === 'succeeded'
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
  </div>
  ${canActivate ? `<div class="card-footer">
    <button class="activate-btn" onclick="activateOrder('${o.txId}',this)">
      <svg viewBox="0 0 24 24"><path d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" stroke-linecap="round" stroke-linejoin="round" stroke-width="2"/></svg>
      Marcar como Activado
    </button>
  </div>` : ''}
</div>`
      }).join('')

  return `<!DOCTYPE html><html lang="pt"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Painel Admin — Net Serviços</title>
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
.content{max-width:700px;margin:0 auto;padding:24px 16px 60px;}

/* ── Stats ── */
.stats-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:12px;margin-bottom:28px;}
@media(min-width:540px){.stats-grid{grid-template-columns:repeat(4,1fr);}}
.stat-card{background:#fff;border-radius:16px;padding:18px 16px;box-shadow:0 1px 4px rgba(0,0,0,.06);border-left:4px solid transparent;}
.stat-card.s-conf{border-color:#10b981;}
.stat-card.s-act{border-color:#3b82f6;}
.stat-card.s-pend{border-color:#f59e0b;}
.stat-card.s-fail{border-color:#ef4444;}
.stat-num{font-size:28px;font-weight:800;color:#1c1c1e;line-height:1;}
.stat-lbl{font-size:12px;color:#636366;font-weight:600;margin-top:4px;}

/* ── Section header ── */
.section-hd{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.section-title{font-size:13px;font-weight:700;color:#636366;text-transform:uppercase;letter-spacing:.07em;}
.section-count{font-size:13px;font-weight:700;color:#cc0000;background:#fff0f0;border-radius:20px;padding:2px 10px;}

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
      <span class="revenue-label">Total Recebido</span>
      <span class="revenue-value">${totalReceived.toLocaleString('pt-MZ')} MT</span>
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
        <div class="stat-card s-conf">
          <div class="stat-num">${counts.succeeded}</div>
          <div class="stat-lbl">Pagamentos Confirmados</div>
        </div>
        <div class="stat-card s-act">
          <div class="stat-num">${counts.activated}</div>
          <div class="stat-lbl">Activações Concluídas</div>
        </div>
        <div class="stat-card s-pend">
          <div class="stat-num">${counts.pending}</div>
          <div class="stat-lbl">A aguardar Pagamento</div>
        </div>
        <div class="stat-card s-fail">
          <div class="stat-num">${counts.failed}</div>
          <div class="stat-lbl">Pagamentos Falhados</div>
        </div>
      </div>

      <!-- Orders -->
      <div class="section-hd">
        <span class="section-title">${pageTitle}</span>
        <span class="section-count">${filtered.length} registos</span>
      </div>
      ${cards}
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
  const phone=document.getElementById('uedit-phone').value.trim().replace(/\D/g,'')
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
</script>
</body></html>`
}

// ── Servidor ──────────────────────────────────────────────────────────────────
await loadOrders()
await loadUsers()
createServer((req, res) => {
  router(req, res).catch(err => {
    console.error('[Server]', err)
    try { json(res, { error:'Erro interno.' }, 500) } catch {}
  })
}).listen(PORT, '0.0.0.0', () => {
  console.log(`Net Serviços a correr em :${PORT}`)
  console.log(`Admin: /admin/office  |  senha: ${ADMIN_PASS}`)
})
