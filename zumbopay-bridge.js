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

// ── Servidor ──────────────────────────────────────────────────────────────────
createServer((req, res) => {
  router(req, res).catch(err => {
    console.error('[Server]', err)
    try { json(res, { error: 'Erro interno.' }, 500) } catch {}
  })
}).listen(PORT, '0.0.0.0', () => {
  console.log(`ZumboPay Deposit a correr em :${PORT}`)
})
