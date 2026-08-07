/**
 * ZumboPay Deposit App — Node.js puro, zero dependências
 * API: https://zumbopay.com/api/public/v1
 */

import { createServer }                    from 'http'
import { createHmac, timingSafeEqual, randomBytes } from 'crypto'

// ── Configuração ──────────────────────────────────────────────────────────────
const PORT                 = process.env.PORT || 5000
const ZUMBO_API_KEY        = 'zk_live_a694231e0f188fe3599e4de8feda28b35714ed9b6fa3cd0e'
const ZUMBO_MERCHANT_ID    = 'MCH_B29C53549C'
const ZUMBO_WEBHOOK_SECRET = 'teste.com'
const ZUMBO_BASE           = 'https://zumbopay.com/api/public/v1'
const WALLET_MPESA         = 'd9a21461-8ff3-4929-8015-efd89268a068'
const WALLET_EMOLA         = '93a03d6d-f361-4602-90e1-c62889b45346'

// ── Catálogo de pacotes Vodacom ───────────────────────────────────────────────
const BUNDLES = new Map([
  // Normal
  ['n01',{label:'380 MB',  price:10,  cat:'normal'  }],
  ['n02',{label:'512 MB',  price:13,  cat:'normal'  }],
  ['n03',{label:'624 MB',  price:17,  cat:'normal'  }],
  ['n04',{label:'780 MB',  price:20,  cat:'normal'  }],
  ['n05',{label:'1 GB',    price:25,  cat:'normal'  }],
  ['n06',{label:'1.1 GB',  price:28,  cat:'normal'  }],
  ['n07',{label:'1.6 GB',  price:41,  cat:'normal'  }],
  ['n08',{label:'2 GB',    price:50,  cat:'normal'  }],
  ['n09',{label:'3 GB',    price:75,  cat:'normal'  }],
  ['n10',{label:'4 GB',    price:100, cat:'normal'  }],
  ['n11',{label:'5 GB',    price:125, cat:'normal'  }],
  ['n12',{label:'6 GB',    price:150, cat:'normal'  }],
  ['n13',{label:'7 GB',    price:175, cat:'normal'  }],
  ['n14',{label:'8 GB',    price:200, cat:'normal'  }],
  ['n15',{label:'9 GB',    price:225, cat:'normal'  }],
  ['n16',{label:'10 GB',   price:250, cat:'normal'  }],
  // Premium 3 Dias
  ['p01',{label:'1.7 GB',  price:57,  cat:'premium' }],
  ['p02',{label:'2.6 GB',  price:83,  cat:'premium' }],
  ['p03',{label:'3.4 GB',  price:100, cat:'premium' }],
  ['p04',{label:'4 GB',    price:135, cat:'premium' }],
  ['p05',{label:'5.4 GB',  price:160, cat:'premium' }],
  ['p06',{label:'6.2 GB',  price:180, cat:'premium' }],
  ['p07',{label:'9.5 GB',  price:280, cat:'premium' }],
  // 7 Dias
  ['s01',{label:'1.7 GB',  price:49,  cat:'sete'    }],
  ['s02',{label:'2.9 GB',  price:85,  cat:'sete'    }],
  ['s03',{label:'3.4 GB',  price:90,  cat:'sete'    }],
  ['s04',{label:'5.3 GB',  price:145, cat:'sete'    }],
  ['s05',{label:'7.2 GB',  price:200, cat:'sete'    }],
  ['s06',{label:'11 GB',   price:290, cat:'sete'    }],
  // Mensal
  ['m01',{label:'2.8 GB',  price:95,  cat:'mensal'  }],
  ['m02',{label:'5.8 GB',  price:195, cat:'mensal'  }],
  ['m03',{label:'7.8 GB',  price:210, cat:'mensal'  }],
  ['m04',{label:'10.8 GB', price:320, cat:'mensal'  }],
  ['m05',{label:'17.8 GB', price:480, cat:'mensal'  }],
  ['m06',{label:'20.8 GB', price:575, cat:'mensal'  }],
  ['m07',{label:'32.8 GB', price:950, cat:'mensal'  }],
  // Diamante
  ['d01',{label:'11 GB',   price:450,  cat:'diamante'}],
  ['d02',{label:'15 GB',   price:580,  cat:'diamante'}],
  ['d03',{label:'21 GB',   price:720,  cat:'diamante'}],
  ['d04',{label:'30 GB',   price:970,  cat:'diamante'}],
  ['d05',{label:'50 GB',   price:1490, cat:'diamante'}],
])

// ── Estado em memória ─────────────────────────────────────────────────────────
const transactions = new Map()   // txId → { id, phone, msisdn, amount, status, ref, method, error, ts }
const sseClients   = new Map()   // txId → Set<res>

// ── Helpers HTTP ──────────────────────────────────────────────────────────────
function json(res, data, status = 200) {
  const body = JSON.stringify(data)
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
  res.end(body)
}

function html(res, body) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', c => chunks.push(c))
    req.on('end',  () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function parseParams(pattern, path) {
  // pattern: '/api/deposit/:txId'  path: '/api/deposit/abc123'
  const pp = pattern.split('/')
  const rp = path.split('?')[0].split('/')
  if (pp.length !== rp.length) return null
  const params = {}
  for (let i = 0; i < pp.length; i++) {
    if (pp[i].startsWith(':')) { params[pp[i].slice(1)] = decodeURIComponent(rp[i]) }
    else if (pp[i] !== rp[i]) return null
  }
  return params
}

// ── SSE ───────────────────────────────────────────────────────────────────────
function notifyTx(txId, data) {
  const clients = sseClients.get(txId)
  if (!clients) return
  const msg = `data: ${JSON.stringify(data)}\n\n`
  for (const res of clients) { try { res.write(msg) } catch {} }
}

// ── Lógica de negócio ─────────────────────────────────────────────────────────
function normalizeMsisdn(phone) {
  const d = String(phone).replace(/\D/g, '')
  return d.startsWith('258') ? d : '258' + d
}

function detectMethod(msisdn) {
  const l = msisdn.replace(/^258/, '')
  if (l.startsWith('84') || l.startsWith('85')) return 'mpesa'
  if (l.startsWith('86') || l.startsWith('87')) return 'emola'
  return null
}

async function initiateCharge(tx, sourceId, customerName) {
  const walletId = tx.method === 'mpesa' ? WALLET_MPESA : WALLET_EMOLA
  try {
    const resp = await fetch(`${ZUMBO_BASE}/charges`, {
      method: 'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${ZUMBO_API_KEY}`,
        'X-Merchant-Id': ZUMBO_MERCHANT_ID,
      },
      body: JSON.stringify({ wallet_id: walletId, amount: tx.amount, msisdn: tx.msisdn, customer_name: customerName, source_id: sourceId }),
    })
    const data = await resp.json().catch(() => ({}))
    console.log(`[ZumboPay] POST /charges → ${resp.status}`, JSON.stringify(data))

    if (resp.status === 200) {
      tx.ref = data.data?.reference || sourceId
      tx.status = 'succeeded'
      notifyTx(tx.id, { status: 'succeeded', method: tx.method })
      return
    }
    if (resp.status === 202) {
      tx.ref = data.data?.reference || sourceId
      tx.status = 'pending'
      notifyTx(tx.id, { status: 'pending', method: tx.method })
      scheduleTimeout(tx)
      return
    }
    const msg = data.error?.message || data.message || data.detail || `Erro ${resp.status}`
    tx.status = 'failed'; tx.error = msg
    notifyTx(tx.id, { status: 'failed', error: msg, method: tx.method })
  } catch (err) {
    console.error('[ZumboPay] Erro de rede:', err.message)
    tx.status = 'failed'
    tx.error  = 'Erro de ligação ao ZumboPay. Tente novamente.'
    notifyTx(tx.id, { status: 'failed', error: tx.error, method: tx.method })
  }
}

function scheduleTimeout(tx) {
  setTimeout(() => {
    if (tx.status !== 'pending') return
    tx.status = 'failed'
    tx.error  = 'O PIN não foi introduzido dentro do tempo. Tente novamente.'
    notifyTx(tx.id, { status: 'failed', error: tx.error, method: tx.method })
    console.log(`[Timeout] ${tx.id} expirou`)
  }, 5 * 60 * 1000)
}

// ── Router ────────────────────────────────────────────────────────────────────
async function router(req, res) {
  const method = req.method
  const path   = req.url.split('?')[0]

  // CORS mínimo
  res.setHeader('Access-Control-Allow-Origin', '*')

  // GET /
  if (method === 'GET' && path === '/') return html(res, page())

  // GET /megas
  if (method === 'GET' && path === '/megas') return html(res, megasPage())

  // GET /ping
  if (method === 'GET' && path === '/ping') return json(res, { ok: true })

  // GET /api/webhook-status
  if (method === 'GET' && path === '/api/webhook-status') {
    try {
      const r    = await fetch(`${ZUMBO_BASE}/merchant/validate`, {
        headers: { 'Authorization': `Bearer ${ZUMBO_API_KEY}`, 'X-Merchant-Id': ZUMBO_MERCHANT_ID },
      })
      const data = await r.json().catch(() => ({}))
      const wh   = data?.data?.webhook
      return json(res, { registered: !!wh, url: wh?.url || null, active: wh?.is_active || false })
    } catch { return json(res, { registered: false, url: null, active: false }) }
  }

  // GET /events/:txId  (SSE)
  const evtParams = parseParams('/events/:txId', path)
  if (method === 'GET' && evtParams) {
    const { txId } = evtParams
    res.writeHead(200, {
      'Content-Type':  'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection':    'keep-alive',
    })
    if (!sseClients.has(txId)) sseClients.set(txId, new Set())
    sseClients.get(txId).add(res)
    req.on('close', () => sseClients.get(txId)?.delete(res))
    const tx = transactions.get(txId)
    if (tx) res.write(`data: ${JSON.stringify({ status: tx.status, method: tx.method })}\n\n`)
    return
  }

  // GET /api/deposit/:txId
  const depGetParams = parseParams('/api/deposit/:txId', path)
  if (method === 'GET' && depGetParams) {
    const tx = transactions.get(depGetParams.txId)
    if (!tx) return json(res, { error: 'Transacção não encontrada.' }, 404)
    return json(res, tx)
  }

  // POST /api/deposit
  if (method === 'POST' && path === '/api/deposit') {
    let body = {}
    try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { phone, amount, customer_name } = body

    if (!phone || !amount) return json(res, { error: 'Telemóvel e valor são obrigatórios.' }, 400)

    const msisdn    = normalizeMsisdn(phone)
    const amountNum = Number(amount)
    const meth      = detectMethod(msisdn)

    if (isNaN(amountNum) || amountNum <= 0) return json(res, { error: 'Valor inválido.' }, 400)
    if (!meth) return json(res, { error: 'Número inválido. Use prefixo 84, 85 (M-Pesa) ou 86, 87 (e-Mola).' }, 400)

    const txId     = randomBytes(6).toString('hex')
    const sourceId = `dep-${txId}`
    const tx = { id: txId, phone, msisdn, amount: amountNum, method: meth, status: 'pending', ref: null, error: null, ts: new Date().toISOString() }
    transactions.set(txId, tx)

    json(res, { txId, status: 'pending', method: meth })
    initiateCharge(tx, sourceId, customer_name || 'Cliente')
    return
  }

  // POST /api/order  (compra de pacote de megas)
  if (method === 'POST' && path === '/api/order') {
    let body = {}
    try { body = JSON.parse((await readBody(req)).toString()) } catch {}
    const { phone, bundleId, customerName } = body

    const bundle = BUNDLES.get(bundleId)
    if (!bundle) return json(res, { error: 'Pacote inválido.' }, 400)

    const msisdn = normalizeMsisdn(phone)
    const meth   = detectMethod(msisdn)
    if (!meth) return json(res, { error: 'Número inválido. Use 84/85 (M-Pesa) ou 86/87 (e-Mola).' }, 400)

    const txId     = randomBytes(6).toString('hex')
    const sourceId = `bnd-${txId}`
    const tx = {
      id: txId, type: 'bundle', bundleId,
      bundleLabel: bundle.label, phone, msisdn,
      amount: bundle.price, method: meth,
      status: 'pending', ref: null, error: null,
      ts: new Date().toISOString(),
    }
    transactions.set(txId, tx)
    json(res, { txId, status: 'pending', method: meth })
    initiateCharge(tx, sourceId, customerName || `Mega ${bundle.label}`)
    return
  }

  // POST /webhook
  if (method === 'POST' && path === '/webhook') {
    const rawBuf = await readBody(req)
    const rawStr = rawBuf.toString()
    const sig    = req.headers['x-zumbopay-signature'] || ''

    if (ZUMBO_WEBHOOK_SECRET && sig) {
      try {
        const expected = createHmac('sha256', ZUMBO_WEBHOOK_SECRET).update(rawStr).digest('hex')
        const expBuf   = Buffer.from(expected, 'hex')
        const sigBuf   = Buffer.from(sig, 'hex')
        const ok = sigBuf.length > 0 && sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
        if (!ok) return json(res, { error: 'Assinatura inválida.' }, 401)
      } catch { return json(res, { error: 'Assinatura inválida.' }, 401) }
    }

    let event = {}
    try { event = JSON.parse(rawStr) } catch {}

    const ref    = event.data?.reference || event.data?.source_id || event.data?.id
    const status = event.event === 'payment.succeeded' ? 'succeeded'
                 : event.event === 'payment.failed'    ? 'failed'
                 : null

    if (status && ref) {
      for (const [txId, tx] of transactions) {
        const sourceId = 'dep-' + tx.id
        if (tx.ref === ref || tx.id === ref || sourceId === ref ||
            tx.ref === event.data?.source_id || sourceId === event.data?.source_id) {
          tx.status = status
          tx.error  = status === 'failed' ? (event.data?.message || 'Pagamento recusado ou cancelado.') : null
          notifyTx(txId, { status, error: tx.error, method: tx.method })
          console.log(`[Webhook] ✓ transacção ${txId} → ${status}`)
          break
        }
      }
    }
    return json(res, { ok: true })
  }

  // 404
  json(res, { error: 'Not found' }, 404)
}

// ── HTML da página ────────────────────────────────────────────────────────────
function page() { return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Depósito — ZumboPay</title>
<script>
(function(){
  document.addEventListener('contextmenu', e => e.preventDefault())
  document.addEventListener('keydown', function(e){
    const ctrl = e.ctrlKey || e.metaKey
    if (e.key === 'F12') { e.preventDefault(); return false }
    if (ctrl && e.shiftKey && ['I','J','C','K'].includes(e.key.toUpperCase())) { e.preventDefault(); return false }
    if (ctrl && ['u','U','s','S','a','A','c','C','x','X','p','P'].includes(e.key)) { e.preventDefault(); return false }
  }, true)
  ;['copy','cut','selectstart','dragstart'].forEach(ev => document.addEventListener(ev, e => e.preventDefault(), true))
  setInterval(function(){
    if (window.outerWidth - window.innerWidth > 160 || window.outerHeight - window.innerHeight > 160) {
      document.body.innerHTML = '<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#09090f;color:#5a6075;font-family:sans-serif;font-size:14px;">Acesso restrito.</div>'
    }
  }, 1000)
})()
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;user-select:none;-webkit-user-select:none;}
img,a{-webkit-user-drag:none;user-drag:none;}
:root{
  --bg:#09090f;--surface:#0f1018;--card:#14161f;--border:#1f2133;
  --accent:#4f6ef7;--violet:#7c3aed;--green:#22c55e;--red:#ef4444;
  --yellow:#f59e0b;--text:#eaecf5;--muted:#5a6075;--r:18px;
}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:24px;}
.brand{display:flex;align-items:center;gap:10px;margin-bottom:32px;}
.brand-icon{width:42px;height:42px;background:linear-gradient(135deg,var(--accent),var(--violet));border-radius:13px;display:flex;align-items:center;justify-content:center;font-size:21px;}
.brand-name{font-size:20px;font-weight:700;letter-spacing:-.5px;}
.brand-name em{color:var(--accent);font-style:normal;}
.card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:36px 32px;width:100%;max-width:420px;box-shadow:0 32px 80px rgba(0,0,0,.55);}
.card-title{font-size:22px;font-weight:700;letter-spacing:-.4px;margin-bottom:6px;}
.card-sub{font-size:13px;color:var(--muted);line-height:1.55;margin-bottom:28px;}
.field{margin-bottom:20px;}
.field label{display:block;font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px;}
.input-wrap{position:relative;display:flex;align-items:center;}
.input-icon{position:absolute;left:14px;font-size:16px;color:var(--muted);pointer-events:none;}
.hint{font-size:11px;color:var(--muted);margin-top:6px;}
input{width:100%;background:var(--surface);border:1.5px solid var(--border);border-radius:12px;padding:13px 14px 13px 42px;color:var(--text);font-size:15px;font-family:inherit;outline:none;transition:border-color .15s;}
input:focus{border-color:var(--accent);}
input::placeholder{color:var(--muted);}
.prefix-wrap input{padding-left:58px;font-size:22px;font-weight:700;}
.prefix{position:absolute;left:14px;font-size:13px;font-weight:700;color:var(--accent);pointer-events:none;}
.btn{width:100%;padding:15px;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,var(--accent),var(--violet));color:#fff;letter-spacing:.1px;transition:opacity .2s,transform .1s;margin-top:6px;}
.btn:hover{opacity:.9;}.btn:active{transform:scale(.99);}.btn:disabled{opacity:.45;cursor:not-allowed;}
.btn-ghost{background:transparent;border:1.5px solid var(--border);color:var(--muted);margin-top:10px;}
.btn-ghost:hover{border-color:var(--accent);color:var(--text);background:rgba(79,110,247,.07);}
#s-form,#s-pending,#s-success,#s-failed{display:none;}
.method-badge{display:inline-flex;align-items:center;gap:6px;padding:5px 12px;border-radius:999px;font-size:12px;font-weight:700;margin-bottom:20px;}
.method-badge.mpesa{background:rgba(34,197,94,.12);color:var(--green);border:1px solid rgba(34,197,94,.2);}
.method-badge.emola{background:rgba(245,158,11,.12);color:var(--yellow);border:1px solid rgba(245,158,11,.2);}
.spinner{width:60px;height:60px;border:4px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin 1s linear infinite;margin:10px auto 28px;}
@keyframes spin{to{transform:rotate(360deg)}}
.center{text-align:center;}
.big-amt{font-size:40px;font-weight:800;letter-spacing:-1.5px;}
.big-sub{font-size:13px;color:var(--muted);margin-bottom:28px;}
.pending-title{font-size:20px;font-weight:700;margin-bottom:8px;}
.pending-phone{display:inline-block;background:rgba(79,110,247,.1);border:1px solid rgba(79,110,247,.22);border-radius:8px;padding:5px 14px;font-size:14px;font-weight:700;color:var(--accent);margin-bottom:20px;}
.steps{list-style:none;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:14px 18px;text-align:left;}
.steps li{font-size:13px;color:var(--muted);padding:7px 0;line-height:1.5;display:flex;align-items:flex-start;gap:10px;border-bottom:1px solid var(--border);}
.steps li:last-child{border-bottom:none;}
.step-n{min-width:20px;height:20px;border-radius:50%;background:rgba(79,110,247,.18);color:var(--accent);font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px;}
.result-icon{width:72px;height:72px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:34px;margin:10px auto 22px;}
.result-icon.ok{background:rgba(34,197,94,.13);}
.result-icon.bad{background:rgba(239,68,68,.13);}
.result-title{font-size:22px;font-weight:700;margin-bottom:8px;}
.result-sub{font-size:14px;color:var(--muted);line-height:1.6;margin-bottom:26px;}
.tag-ok{color:var(--green);}.tag-bad{color:var(--red);}
.err-box{background:rgba(239,68,68,.09);border:1px solid rgba(239,68,68,.22);border-radius:10px;padding:11px 15px;font-size:13px;color:#fca5a5;margin-bottom:16px;display:none;}
@media(max-width:460px){.card{padding:26px 18px;}body{padding:16px;}}
</style>
</head>
<body>

<div id="wh-banner" style="display:none;width:100%;max-width:460px;margin-bottom:20px;">
  <div style="background:rgba(245,158,11,.08);border:1.5px solid rgba(245,158,11,.3);border-radius:16px;padding:20px 20px 16px;">
    <div style="font-size:13px;font-weight:700;color:#f59e0b;margin-bottom:4px;">⚠️ Configuração necessária — 1 passo</div>
    <div style="font-size:12px;color:#9ca3af;line-height:1.6;margin-bottom:14px;">
      Registe o webhook no ZumboPay para confirmar pagamentos.<br>
      Após isso, confirmações são <strong style="color:#e5e7eb">instantâneas</strong> (2-5 seg após PIN).
    </div>
    <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">1. Copie este URL</div>
    <div style="display:flex;gap:8px;margin-bottom:14px;">
      <div id="wh-url" style="flex:1;background:rgba(0,0,0,.4);border:1px solid rgba(245,158,11,.2);border-radius:8px;padding:9px 12px;font-family:monospace;font-size:11px;color:#f59e0b;word-break:break-all;line-height:1.4;">a carregar…</div>
      <button onclick="copyWebhookUrl()" id="btn-copy" style="flex-shrink:0;padding:8px 14px;border:1px solid rgba(245,158,11,.3);border-radius:8px;background:rgba(245,158,11,.12);color:#f59e0b;font-size:12px;font-weight:700;cursor:pointer;font-family:inherit;">Copiar</button>
    </div>
    <div style="font-size:11px;font-weight:700;color:#6b7280;text-transform:uppercase;letter-spacing:.5px;margin-bottom:6px;">2. Registe no ZumboPay</div>
    <a href="https://zumbopay.com/app/developers" target="_blank" rel="noopener" style="display:flex;align-items:center;justify-content:space-between;gap:8px;background:rgba(79,110,247,.1);border:1px solid rgba(79,110,247,.2);border-radius:8px;padding:10px 14px;text-decoration:none;">
      <span style="font-size:13px;font-weight:600;color:#818cf8;">Painel ZumboPay → Programadores → Webhooks</span>
      <span style="font-size:16px;">↗</span>
    </a>
    <div style="font-size:11px;color:#4b5563;margin-top:8px;">Eventos: <code style="color:#6b7280">payment.succeeded</code> &amp; <code style="color:#6b7280">payment.failed</code></div>
    <button onclick="checkWebhook()" style="margin-top:12px;width:100%;padding:8px;border:1px solid rgba(100,116,139,.3);border-radius:8px;background:transparent;color:#6b7280;font-size:12px;font-family:inherit;cursor:pointer;">✓ Já registei — verificar agora</button>
  </div>
</div>

<div style="width:100%;max-width:460px;display:flex;justify-content:flex-end;margin-bottom:12px;">
  <a href="/megas" style="font-size:12px;color:#5a6075;text-decoration:none;padding:6px 14px;border:1px solid #1f2133;border-radius:8px;display:inline-flex;align-items:center;gap:6px;" onmouseover="this.style.color='#eaecf5';this.style.borderColor='#4f6ef7'" onmouseout="this.style.color='#5a6075';this.style.borderColor='#1f2133'">🌐 Comprar Megas →</a>
</div>

<div class="brand">
  <div class="brand-icon">💳</div>
  <div class="brand-name">Zumbo<em>Pay</em></div>
</div>

<div class="card">
  <div id="s-form">
    <div class="card-title">Fazer Depósito</div>
    <div class="card-sub">Introduza o número de telemóvel e o valor. Receberá um pedido de PIN no telefone.</div>
    <div id="err" class="err-box"></div>
    <div class="field">
      <label>Nome (opcional)</label>
      <div class="input-wrap"><span class="input-icon">👤</span><input id="i-name" type="text" placeholder="O seu nome"></div>
    </div>
    <div class="field">
      <label>Número de telemóvel</label>
      <div class="input-wrap"><span class="input-icon">📱</span><input id="i-phone" type="tel" placeholder="84 000 0000" maxlength="15" inputmode="tel"></div>
      <div class="hint">84/85 → M-Pesa &nbsp;·&nbsp; 86/87 → e-Mola</div>
    </div>
    <div class="field">
      <label>Valor a depositar</label>
      <div class="input-wrap prefix-wrap"><span class="prefix">MZN</span><input id="i-amount" type="number" placeholder="0" min="1" step="1" inputmode="decimal"></div>
    </div>
    <button class="btn" id="btn-dep" onclick="submit()">Depositar</button>
  </div>

  <div id="s-pending">
    <div class="spinner"></div>
    <div class="center">
      <div class="big-amt" id="p-amt"></div>
      <div class="big-sub">MZN</div>
      <div id="p-method" class="method-badge"></div>
      <div class="pending-title">Aguardando PIN</div>
      <div class="pending-phone" id="p-phone"></div>
      <p style="font-size:13px;color:var(--muted);margin-bottom:20px;line-height:1.6">
        Foi enviado um pedido de pagamento para o seu telemóvel.<br>
        Introduza o <strong style="color:var(--text)">PIN</strong> para confirmar o depósito.
      </p>
      <ul class="steps">
        <li><span class="step-n">1</span>Verifique o telemóvel — apareceu uma notificação do <span id="step-method">M-Pesa / e-Mola</span></li>
        <li><span class="step-n">2</span>Seleccione <em>"Aceitar"</em> e introduza o seu PIN</li>
        <li><span class="step-n">3</span>Esta página actualiza automaticamente após confirmação</li>
      </ul>
    </div>
  </div>

  <div id="s-success">
    <div class="center">
      <div class="result-icon ok">✓</div>
      <div class="big-amt tag-ok" id="ok-amt"></div>
      <div class="big-sub">MZN</div>
      <div class="result-title">Depósito confirmado!</div>
      <p class="result-sub">O pagamento foi processado com sucesso.<br>O valor já está disponível na sua conta.</p>
      <button class="btn" onclick="reset()">Novo depósito</button>
    </div>
  </div>

  <div id="s-failed">
    <div class="center">
      <div class="result-icon bad">✗</div>
      <div class="big-amt tag-bad" id="fail-amt"></div>
      <div class="big-sub">MZN</div>
      <div class="result-title">Depósito não confirmado</div>
      <p class="result-sub" id="fail-reason">O PIN não foi introduzido ou o tempo expirou.</p>
      <button class="btn" onclick="reset()">Tentar novamente</button>
      <button class="btn btn-ghost" onclick="reset()">Cancelar</button>
    </div>
  </div>
</div>

<script>
let evtSource = null
const WEBHOOK_URL = window.location.origin + '/webhook'

async function checkWebhook() {
  document.getElementById('wh-url').textContent = WEBHOOK_URL
  try {
    const r = await fetch('/api/webhook-status')
    const d = await r.json()
    document.getElementById('wh-banner').style.display = (!d.registered || !d.active) ? 'block' : 'none'
  } catch { document.getElementById('wh-banner').style.display = 'block' }
}

function copyWebhookUrl() {
  navigator.clipboard.writeText(WEBHOOK_URL).then(() => {
    const btn = document.getElementById('btn-copy')
    btn.textContent = '✓ Copiado'; btn.style.color = '#22c55e'
    setTimeout(() => { btn.textContent = 'Copiar'; btn.style.color = '#f59e0b' }, 2000)
  }).catch(() => {
    const el = document.getElementById('wh-url')
    const r = document.createRange(); r.selectNode(el)
    window.getSelection().removeAllRanges(); window.getSelection().addRange(r)
  })
}

checkWebhook()

function show(id) {
  ['form','pending','success','failed'].forEach(s =>
    document.getElementById('s-'+s).style.display = (s===id ? 'block' : 'none')
  )
}

function fmt(v) { return Number(v).toLocaleString('pt-MZ',{minimumFractionDigits:2,maximumFractionDigits:2}) }

async function submit() {
  const phone  = document.getElementById('i-phone').value.trim()
  const amount = document.getElementById('i-amount').value.trim()
  const name   = document.getElementById('i-name').value.trim()
  document.getElementById('err').style.display = 'none'
  if (!phone)                        return setErr('Introduza o número de telemóvel.')
  if (!amount || Number(amount) <= 0) return setErr('Introduza um valor válido.')
  const btn = document.getElementById('btn-dep')
  btn.disabled = true; btn.textContent = 'A processar…'
  try {
    const r = await fetch('/api/deposit', {
      method: 'POST', headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ phone, amount: Number(amount), customer_name: name || undefined })
    })
    const d = await r.json()
    if (!r.ok) { setErr(d.error || 'Erro ao iniciar depósito.'); btn.disabled=false; btn.textContent='Depositar'; return }
    const fmtAmt = fmt(amount)
    document.getElementById('p-amt').textContent    = fmtAmt
    document.getElementById('ok-amt').textContent   = fmtAmt
    document.getElementById('fail-amt').textContent = fmtAmt
    document.getElementById('p-phone').textContent  = phone
    const mEl = document.getElementById('p-method'), sEl = document.getElementById('step-method')
    if (d.method==='mpesa') { mEl.className='method-badge mpesa'; mEl.textContent='M-Pesa'; sEl.textContent='M-Pesa' }
    if (d.method==='emola') { mEl.className='method-badge emola'; mEl.textContent='e-Mola'; sEl.textContent='e-Mola' }
    show('pending'); listen(d.txId)
  } catch { setErr('Erro de ligação. Tente novamente.'); btn.disabled=false; btn.textContent='Depositar' }
}

function listen(txId) {
  if (evtSource) evtSource.close()
  evtSource = new EventSource('/events/' + txId)
  evtSource.onmessage = e => {
    const d = JSON.parse(e.data)
    if (d.status === 'succeeded') { evtSource.close(); show('success') }
    if (d.status === 'failed') {
      evtSource.close()
      document.getElementById('fail-reason').textContent = d.error || 'O PIN não foi introduzido ou o tempo expirou.'
      show('failed')
    }
  }
  evtSource.onerror = () => { evtSource.close(); setTimeout(() => listen(txId), 3000) }
}

function setErr(msg) { const el=document.getElementById('err'); el.textContent=msg; el.style.display='block' }

function reset() {
  if (evtSource) { evtSource.close(); evtSource=null }
  document.getElementById('i-phone').value=''
  document.getElementById('i-amount').value=''
  document.getElementById('i-name').value=''
  document.getElementById('err').style.display='none'
  const btn=document.getElementById('btn-dep'); btn.disabled=false; btn.textContent='Depositar'
  show('form')
}

show('form')
</script>
</body>
</html>`
}

// ── Página de venda de megas ──────────────────────────────────────────────────
function megasPage() { return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Megas Vodacom</title>
<script>
(function(){
  document.addEventListener('contextmenu',e=>e.preventDefault())
  document.addEventListener('keydown',function(e){
    const c=e.ctrlKey||e.metaKey
    if(e.key==='F12'){e.preventDefault();return false}
    if(c&&e.shiftKey&&['I','J','C','K'].includes(e.key.toUpperCase())){e.preventDefault();return false}
    if(c&&['u','U','s','S','a','A','c','C','x','X','p','P'].includes(e.key)){e.preventDefault();return false}
  },true)
  ;['copy','cut','selectstart','dragstart'].forEach(ev=>document.addEventListener(ev,e=>e.preventDefault(),true))
  setInterval(()=>{
    if(window.outerWidth-window.innerWidth>160||window.outerHeight-window.innerHeight>160)
      document.body.innerHTML='<div style="display:flex;align-items:center;justify-content:center;height:100vh;background:#09090f;color:#5a6075;font-family:sans-serif;font-size:14px">Acesso restrito.</div>'
  },1000)
})()
</script>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0;user-select:none;-webkit-user-select:none;}
img,a{-webkit-user-drag:none;}
:root{
  --bg:#09090f;--surface:#0f1018;--card:#14161f;--border:#1f2133;
  --text:#eaecf5;--muted:#5a6075;--r:14px;
  --green:#22c55e;--blue:#4f6ef7;--amber:#f59e0b;--purple:#a78bfa;--gold:#fbbf24;--red:#ef4444;
}
body{background:var(--bg);color:var(--text);font-family:'Segoe UI',system-ui,sans-serif;min-height:100vh;padding-bottom:40px;}

/* ── nav ── */
.topnav{display:flex;align-items:center;justify-content:space-between;padding:14px 20px;border-bottom:1px solid var(--border);position:sticky;top:0;background:rgba(9,9,15,.92);backdrop-filter:blur(12px);z-index:50;}
.nav-brand{display:flex;align-items:center;gap:8px;font-size:16px;font-weight:700;}
.nav-brand span{background:linear-gradient(135deg,#4f6ef7,#7c3aed);border-radius:9px;width:32px;height:32px;display:flex;align-items:center;justify-content:center;font-size:16px;}
.nav-link{font-size:12px;color:var(--muted);text-decoration:none;padding:6px 12px;border:1px solid var(--border);border-radius:8px;}
.nav-link:hover{color:var(--text);border-color:var(--blue);}

/* ── hero ── */
.hero{padding:28px 20px 20px;text-align:center;}
.hero-icon{font-size:42px;margin-bottom:10px;}
.hero-title{font-size:26px;font-weight:800;letter-spacing:-.5px;margin-bottom:6px;}
.hero-sub{font-size:13px;color:var(--muted);line-height:1.55;}
.voda-badge{display:inline-flex;align-items:center;gap:6px;margin-top:10px;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.22);border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;color:var(--green);}

/* ── tabs ── */
.tabs{display:flex;gap:8px;padding:0 16px 16px;overflow-x:auto;scrollbar-width:none;}
.tabs::-webkit-scrollbar{display:none;}
.tab{flex-shrink:0;padding:8px 16px;border-radius:999px;border:1.5px solid var(--border);background:transparent;color:var(--muted);font-size:13px;font-weight:600;font-family:inherit;cursor:pointer;transition:all .18s;white-space:nowrap;}
.tab.active{border-color:var(--green);background:rgba(34,197,94,.12);color:var(--green);}
.tab:hover:not(.active){border-color:#2a2d40;color:var(--text);}

/* ── cat note ── */
.cat-note{margin:0 16px 16px;padding:10px 14px;background:rgba(255,255,255,.03);border:1px solid var(--border);border-radius:10px;font-size:12px;color:var(--muted);line-height:1.5;display:none;}
.cat-note.show{display:block;}

/* ── grid ── */
.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px;padding:0 16px;}
@media(min-width:480px){.grid{grid-template-columns:repeat(3,1fr);}}
@media(min-width:720px){.grid{grid-template-columns:repeat(4,1fr);gap:12px;padding:0 24px;}}

/* ── package card ── */
.pkg{background:var(--card);border:1.5px solid var(--border);border-radius:var(--r);padding:16px 12px;cursor:pointer;transition:border-color .18s,transform .12s;text-align:center;position:relative;}
.pkg:hover{border-color:var(--green);transform:translateY(-2px);}
.pkg:active{transform:scale(.97);}
.pkg-size{font-size:20px;font-weight:800;letter-spacing:-.5px;margin-bottom:4px;}
.pkg-price{font-size:22px;font-weight:900;color:var(--green);letter-spacing:-.5px;}
.pkg-price span{font-size:12px;font-weight:600;color:var(--muted);}
.pkg-extra{font-size:10px;color:var(--muted);margin-top:4px;line-height:1.4;}
.pkg-badge{position:absolute;top:-1px;right:-1px;background:var(--amber);color:#000;font-size:9px;font-weight:800;padding:3px 7px;border-radius:0 var(--r) 0 8px;letter-spacing:.3px;}

/* ── overlay + sheet ── */
.overlay{position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:100;display:none;backdrop-filter:blur(4px);}
.overlay.open{display:block;}
.sheet{position:fixed;bottom:0;left:0;right:0;max-width:520px;margin:0 auto;background:#16182a;border-radius:20px 20px 0 0;border-top:1px solid var(--border);border-left:1px solid var(--border);border-right:1px solid var(--border);z-index:101;padding:0 20px 32px;transform:translateY(100%);transition:transform .3s cubic-bezier(.32,.72,0,1);max-height:92vh;overflow-y:auto;}
.sheet.open{transform:translateY(0);}
.sheet-handle{width:36px;height:4px;background:var(--border);border-radius:2px;margin:12px auto 20px;}

/* sheet content panels */
.s-buy,.s-pending,.s-success,.s-failed{display:none;}

.sel-pkg{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.18);border-radius:12px;padding:14px;margin-bottom:20px;display:flex;align-items:center;justify-content:space-between;}
.sel-pkg-info{text-align:left;}
.sel-pkg-size{font-size:18px;font-weight:800;}
.sel-pkg-cat{font-size:11px;color:var(--muted);margin-top:2px;}
.sel-pkg-price{font-size:24px;font-weight:900;color:var(--green);}
.sel-pkg-cur{font-size:12px;color:var(--muted);}

.field-lbl{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.7px;margin-bottom:8px;display:block;}
.inp{width:100%;background:var(--surface);border:1.5px solid var(--border);border-radius:12px;padding:13px 14px 13px 42px;color:var(--text);font-size:16px;font-family:inherit;outline:none;transition:border-color .15s;}
.inp:focus{border-color:var(--green);}
.inp::placeholder{color:var(--muted);}
.inp-wrap{position:relative;}
.inp-icon{position:absolute;left:14px;top:50%;transform:translateY(-50%);font-size:16px;color:var(--muted);pointer-events:none;}
.hint{font-size:11px;color:var(--muted);margin-top:6px;}
.errs{background:rgba(239,68,68,.09);border:1px solid rgba(239,68,68,.22);border-radius:10px;padding:10px 14px;font-size:13px;color:#fca5a5;margin-bottom:14px;display:none;}

.btn{width:100%;padding:15px;border:none;border-radius:12px;font-size:15px;font-weight:700;font-family:inherit;cursor:pointer;background:linear-gradient(135deg,var(--green),#16a34a);color:#fff;margin-top:14px;transition:opacity .2s;}
.btn:hover{opacity:.9;}.btn:active{transform:scale(.99);}.btn:disabled{opacity:.4;cursor:not-allowed;}
.btn-ghost{background:transparent;border:1.5px solid var(--border);color:var(--muted);margin-top:10px;}
.btn-ghost:hover{border-color:var(--green);color:var(--text);}

/* pending */
.spinner{width:56px;height:56px;border:4px solid var(--border);border-top-color:var(--green);border-radius:50%;animation:spin 1s linear infinite;margin:8px auto 22px;}
@keyframes spin{to{transform:rotate(360deg)}}
.pend-title{font-size:18px;font-weight:700;text-align:center;margin-bottom:6px;}
.pend-phone{display:inline-block;background:rgba(34,197,94,.1);border:1px solid rgba(34,197,94,.2);border-radius:8px;padding:4px 12px;font-size:14px;font-weight:700;color:var(--green);margin:0 auto 16px;display:block;text-align:center;}
.pend-steps{list-style:none;background:var(--surface);border:1px solid var(--border);border-radius:12px;padding:12px 16px;}
.pend-steps li{font-size:12px;color:var(--muted);padding:6px 0;line-height:1.5;display:flex;align-items:flex-start;gap:8px;border-bottom:1px solid var(--border);}
.pend-steps li:last-child{border-bottom:none;}
.step-n{min-width:18px;height:18px;border-radius:50%;background:rgba(34,197,94,.18);color:var(--green);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;margin-top:1px;flex-shrink:0;}

/* result */
.res-icon{width:64px;height:64px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:30px;margin:8px auto 18px;}
.res-icon.ok{background:rgba(34,197,94,.13);}
.res-icon.bad{background:rgba(239,68,68,.13);}
.res-title{font-size:20px;font-weight:700;text-align:center;margin-bottom:6px;}
.res-sub{font-size:13px;color:var(--muted);text-align:center;line-height:1.6;margin-bottom:22px;}
.res-ref{background:rgba(34,197,94,.07);border:1px solid rgba(34,197,94,.15);border-radius:10px;padding:12px 14px;text-align:center;margin-bottom:20px;}
.res-ref-lbl{font-size:11px;color:var(--muted);margin-bottom:4px;}
.res-ref-val{font-size:15px;font-weight:700;color:var(--green);}
</style>
</head>
<body>

<nav class="topnav">
  <div class="nav-brand">
    <span>💳</span>
    Zumbo<em style="color:#4f6ef7;font-style:normal">Pay</em>
  </div>
  <a href="/" class="nav-link">← Depósito</a>
</nav>

<div class="hero">
  <div class="hero-icon">🌐</div>
  <div class="hero-title">Megas Vodacom</div>
  <div class="hero-sub">Escolha o pacote, pague com M-Pesa ou e-Mola.<br>Activação em 5–15 minutos.</div>
  <div class="voda-badge">✓ Válido apenas para Vodacom</div>
</div>

<div class="tabs" id="tabs">${['normal','premium','sete','mensal','diamante'].map((id,i) => {
  const icons = ['📶','🔄','📅','📱','💎']
  const lbls  = ['Normal','Premium 3D','7 Dias','Mensal','Diamante']
  return '<button class="tab'+(i===0?' active':'')+'" id="tab-'+id+'" onclick="setCat(\''+id+'\')" style="flex-shrink:0">'+icons[i]+' '+lbls[i]+'</button>'
}).join('')}</div>
<div class="cat-note" id="cat-note"></div>
<div class="grid" id="pkg-grid">${(()=>{
  const pkgs = [
    {id:'n01',size:'380 MB',price:10},{id:'n02',size:'512 MB',price:13},
    {id:'n03',size:'624 MB',price:17},{id:'n04',size:'780 MB',price:20},
    {id:'n05',size:'1 GB',  price:25},{id:'n06',size:'1.1 GB',price:28},
    {id:'n07',size:'1.6 GB',price:41},{id:'n08',size:'2 GB',  price:50},
    {id:'n09',size:'3 GB',  price:75},{id:'n10',size:'4 GB',  price:100},
    {id:'n11',size:'5 GB',  price:125},{id:'n12',size:'6 GB', price:150},
    {id:'n13',size:'7 GB',  price:175},{id:'n14',size:'8 GB', price:200},
    {id:'n15',size:'9 GB',  price:225},{id:'n16',size:'10 GB',price:250},
  ]
  return pkgs.map(p =>
    '<div class="pkg" onclick="openSheet(\''+p.id+'\')">'+
    '<div class="pkg-size">'+p.size+'</div>'+
    '<div class="pkg-price">'+p.price+'<span> MT</span></div>'+
    '</div>'
  ).join('')
})()}</div>

<!-- Overlay + Bottom sheet -->
<div class="overlay" id="overlay" onclick="closeSheet()"></div>
<div class="sheet" id="sheet">
  <div class="sheet-handle"></div>

  <!-- comprar -->
  <div class="s-buy" id="s-buy">
    <div class="sel-pkg">
      <div class="sel-pkg-info">
        <div class="sel-pkg-size" id="sh-size"></div>
        <div class="sel-pkg-cat" id="sh-cat"></div>
      </div>
      <div style="text-align:right;">
        <div class="sel-pkg-price" id="sh-price"></div>
        <div class="sel-pkg-cur">MT</div>
      </div>
    </div>
    <div class="errs" id="sh-err"></div>
    <label class="field-lbl">Número Vodacom do destinatário</label>
    <div class="inp-wrap" style="margin-bottom:6px;">
      <span class="inp-icon">📱</span>
      <input class="inp" id="sh-phone" type="tel" placeholder="84 000 0000" maxlength="15" inputmode="tel">
    </div>
    <div class="hint">84 / 85 → M-Pesa &nbsp;·&nbsp; 86 / 87 → e-Mola</div>
    <button class="btn" id="sh-btn" onclick="pay()">Pagar e Encomendar</button>
    <button class="btn btn-ghost" onclick="closeSheet()">Cancelar</button>
  </div>

  <!-- pending -->
  <div class="s-pending" id="s-pending">
    <div class="spinner"></div>
    <div class="pend-title">Aguardando PIN</div>
    <div class="pend-phone" id="sh-pend-phone"></div>
    <p style="font-size:12px;color:var(--muted);text-align:center;margin-bottom:14px;line-height:1.6;">
      Foi enviado um pedido de pagamento para o seu telemóvel.<br>
      Introduza o <strong style="color:var(--text)">PIN</strong> para confirmar.
    </p>
    <ul class="pend-steps">
      <li><span class="step-n">1</span>Verifique o telemóvel — apareceu um pedido <span id="sh-method-lbl">M-Pesa</span></li>
      <li><span class="step-n">2</span>Seleccione "Aceitar" e introduza o seu PIN</li>
      <li><span class="step-n">3</span>Esta página actualiza automaticamente</li>
    </ul>
  </div>

  <!-- sucesso -->
  <div class="s-success" id="s-success">
    <div class="res-icon ok">✓</div>
    <div class="res-title">Pedido recebido!</div>
    <p class="res-sub">O pagamento foi confirmado com sucesso.<br>O seu pacote será activado em <strong style="color:var(--text)">5 a 15 minutos</strong>.</p>
    <div class="res-ref">
      <div class="res-ref-lbl">Pacote encomendado</div>
      <div class="res-ref-val" id="sh-ok-pkg"></div>
    </div>
    <button class="btn" onclick="closeSheet()">Comprar outro pacote</button>
  </div>

  <!-- falhou -->
  <div class="s-failed" id="s-failed">
    <div class="res-icon bad">✗</div>
    <div class="res-title">Pagamento não confirmado</div>
    <p class="res-sub" id="sh-fail-msg">O PIN não foi introduzido ou o tempo expirou.</p>
    <button class="btn" onclick="shShow('buy')">Tentar novamente</button>
    <button class="btn btn-ghost" onclick="closeSheet()">Cancelar</button>
  </div>
</div>

<script>
const CATS = [
  {id:'normal',  icon:'📶', label:'Normal',     note:null},
  {id:'premium', icon:'🔄', label:'Premium 3D', note:'3 Dias · Renovável · 🎁 +100MB ao renovar dentro de 3 dias'},
  {id:'sete',    icon:'📅', label:'7 Dias',     note:'Validade de 7 dias após activação'},
  {id:'mensal',  icon:'📱', label:'Mensal',     note:'Validade 30 dias · ⚠️ Não deve ter Txuna crédito activo'},
  {id:'diamante',icon:'💎', label:'Diamante',   note:'30 Dias · 📞 Chamadas + SMS ilimitadas · ⚠️ Não deve ter Txuna crédito activo'},
]

const PKGS = {
  normal:[
    {id:'n01',size:'380 MB',price:10},
    {id:'n02',size:'512 MB',price:13},
    {id:'n03',size:'624 MB',price:17},
    {id:'n04',size:'780 MB',price:20},
    {id:'n05',size:'1 GB',  price:25},
    {id:'n06',size:'1.1 GB',price:28},
    {id:'n07',size:'1.6 GB',price:41},
    {id:'n08',size:'2 GB',  price:50},
    {id:'n09',size:'3 GB',  price:75},
    {id:'n10',size:'4 GB',  price:100},
    {id:'n11',size:'5 GB',  price:125},
    {id:'n12',size:'6 GB',  price:150},
    {id:'n13',size:'7 GB',  price:175},
    {id:'n14',size:'8 GB',  price:200},
    {id:'n15',size:'9 GB',  price:225},
    {id:'n16',size:'10 GB', price:250},
  ],
  premium:[
    {id:'p01',size:'1.7 GB',price:57 },
    {id:'p02',size:'2.6 GB',price:83 },
    {id:'p03',size:'3.4 GB',price:100},
    {id:'p04',size:'4 GB',  price:135},
    {id:'p05',size:'5.4 GB',price:160},
    {id:'p06',size:'6.2 GB',price:180},
    {id:'p07',size:'9.5 GB',price:280},
  ],
  sete:[
    {id:'s01',size:'1.7 GB', price:49 },
    {id:'s02',size:'2.9 GB', price:85 },
    {id:'s03',size:'3.4 GB', price:90 },
    {id:'s04',size:'5.3 GB', price:145},
    {id:'s05',size:'7.2 GB', price:200},
    {id:'s06',size:'11 GB',  price:290},
  ],
  mensal:[
    {id:'m01',size:'2.8 GB', price:95 },
    {id:'m02',size:'5.8 GB', price:195},
    {id:'m03',size:'7.8 GB', price:210},
    {id:'m04',size:'10.8 GB',price:320},
    {id:'m05',size:'17.8 GB',price:480},
    {id:'m06',size:'20.8 GB',price:575},
    {id:'m07',size:'32.8 GB',price:950},
  ],
  diamante:[
    {id:'d01',size:'11 GB',price:450, extra:'📞 Chamadas + SMS ilim.'},
    {id:'d02',size:'15 GB',price:580, extra:'📞 Chamadas + SMS ilim.'},
    {id:'d03',size:'21 GB',price:720, extra:'📞 Chamadas + SMS ilim.'},
    {id:'d04',size:'30 GB',price:970, extra:'📞 Chamadas + SMS ilim.'},
    {id:'d05',size:'50 GB',price:1490,extra:'📞 Chamadas + SMS ilim.'},
  ],
}

let curCat = 'normal', curPkg = null, evtSrc = null

// Render tabs
function renderTabs() {
  const el = document.getElementById('tabs')
  el.innerHTML = CATS.map(c =>
    '<button class="tab'+(c.id===curCat?' active':'')+'" onclick="setCat(\''+c.id+'\')">'+c.icon+' '+c.label+'</button>'
  ).join('')
}

// Render grid
function renderGrid() {
  const pkgs = PKGS[curCat] || []
  const isPremium = curCat === 'premium'
  const isDiamante = curCat === 'diamante'
  document.getElementById('pkg-grid').innerHTML = pkgs.map(p => {
    const badge = isPremium ? '<div class="pkg-badge">3 DIAS</div>' :
                  curCat==='sete' ? '<div class="pkg-badge" style="background:var(--green);color:#000">7 DIAS</div>' :
                  (curCat==='mensal'||isDiamante) ? '<div class="pkg-badge" style="background:var(--purple);color:#fff">30 DIAS</div>' : ''
    const extra = p.extra ? '<div class="pkg-extra">'+p.extra+'</div>' : ''
    return '<div class="pkg" onclick="openSheet(\''+p.id+'\')">'+badge+
      '<div class="pkg-size">'+p.size+'</div>'+
      '<div class="pkg-price">'+p.price+'<span> MT</span></div>'+extra+
      '</div>'
  }).join('')

  // cat note
  const cat = CATS.find(c=>c.id===curCat)
  const noteEl = document.getElementById('cat-note')
  if (cat && cat.note) { noteEl.textContent = 'ℹ️ '+cat.note; noteEl.classList.add('show') }
  else noteEl.classList.remove('show')
}

function setCat(id) {
  curCat = id; renderTabs(); renderGrid()
}

// Sheet
function openSheet(pkgId) {
  const p = (PKGS[curCat]||[]).find(x=>x.id===pkgId) || Object.values(PKGS).flat().find(x=>x.id===pkgId)
  if (!p) return
  curPkg = p
  const cat = CATS.find(c=>PKGS[c.id]&&PKGS[c.id].some(x=>x.id===pkgId))
  document.getElementById('sh-size').textContent  = p.size
  document.getElementById('sh-cat').textContent   = cat ? cat.icon+' '+cat.label : ''
  document.getElementById('sh-price').textContent = p.price
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
  setTimeout(()=>shShow('buy'),300)
}

function shShow(s) {
  ['buy','pending','success','failed'].forEach(x=>document.getElementById('s-'+x).style.display=(x===s?'block':'none'))
}

async function pay() {
  const phone = document.getElementById('sh-phone').value.trim()
  const errEl = document.getElementById('sh-err')
  errEl.style.display = 'none'
  if (!phone) { errEl.textContent='Introduza o número de telemóvel.'; errEl.style.display='block'; return }
  if (!curPkg) return

  const btn = document.getElementById('sh-btn')
  btn.disabled = true; btn.textContent = 'A processar…'

  try {
    const r = await fetch('/api/order', {
      method:'POST', headers:{'Content-Type':'application/json'},
      body: JSON.stringify({ phone, bundleId: curPkg.id })
    })
    const d = await r.json()
    if (!r.ok) { errEl.textContent = d.error||'Erro ao processar.'; errEl.style.display='block'; btn.disabled=false; btn.textContent='Pagar e Encomendar'; return }

    document.getElementById('sh-pend-phone').textContent = phone
    document.getElementById('sh-method-lbl').textContent = d.method==='mpesa' ? 'M-Pesa' : 'e-Mola'
    document.getElementById('sh-ok-pkg').textContent = curPkg.size + ' — ' + curPkg.price + ' MT'
    shShow('pending')
    listenOrder(d.txId)
  } catch { errEl.textContent='Erro de ligação. Tente novamente.'; errEl.style.display='block'; btn.disabled=false; btn.textContent='Pagar e Encomendar' }
}

function listenOrder(txId) {
  if (evtSrc) evtSrc.close()
  evtSrc = new EventSource('/events/'+txId)
  evtSrc.onmessage = e => {
    const d = JSON.parse(e.data)
    if (d.status==='succeeded') { evtSrc.close(); shShow('success') }
    if (d.status==='failed')    {
      evtSrc.close()
      document.getElementById('sh-fail-msg').textContent = d.error||'O PIN não foi introduzido ou o tempo expirou.'
      shShow('failed')
    }
  }
  evtSrc.onerror = ()=>{ evtSrc.close(); setTimeout(()=>listenOrder(txId),3000) }
}

// init
renderTabs(); renderGrid()
</script>
</body>
</html>`
}

// ── Servidor ──────────────────────────────────────────────────────────────────
createServer((req, res) => {
  router(req, res).catch(err => {
    console.error('[Server]', err)
    try { json(res, { error: 'Erro interno.' }, 500) } catch {}
  })
}).listen(PORT, '0.0.0.0', () => {
  console.log(`ZumboPay Deposit a correr em :${PORT}`)
})
