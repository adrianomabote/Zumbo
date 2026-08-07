/**
 * ZumboPay Deposit App
 * Fluxo: utilizador introduz telemóvel + valor → ZumboPay envia USSD/PIN → confirma pagamento
 */

import express from 'express'
import { createHmac, timingSafeEqual, randomBytes } from 'crypto'
import { createServer } from 'http'

// ── Configuração ──────────────────────────────────────────────────────────────
const PORT               = process.env.PORT               || 5000
const ZUMBO_API_KEY      = process.env.ZUMBO_API_KEY      || 'zk_live_a694231e0f188fe3599e4de8feda28b35714ed9b6fa3cd0e'
const ZUMBO_MERCHANT_ID  = process.env.ZUMBO_MERCHANT_ID  || 'MCH_B29C53549C'
const ZUMBO_WEBHOOK_SECRET = process.env.ZUMBO_WEBHOOK_SECRET || 'teste.com'
const ZUMBO_API_BASE     = process.env.ZUMBO_API_BASE     || 'https://api.zumbopay.co.mz'

// ── Armazenamento de transacções em memória ───────────────────────────────────
const transactions = new Map() // id → { id, phone, amount, status, ts, ref }

// ── App Express ───────────────────────────────────────────────────────────────
const app = express()
app.use(express.json())

// ── SSE clients ───────────────────────────────────────────────────────────────
const sseClients = new Map() // txId → Set<res>
function notifyTx(txId, data) {
  const clients = sseClients.get(txId)
  if (!clients) return
  const msg = `data: ${JSON.stringify(data)}\n\n`
  for (const res of clients) {
    try { res.write(msg) } catch {}
  }
}

// ── SSE por transacção ────────────────────────────────────────────────────────
app.get('/events/:txId', (req, res) => {
  const { txId } = req.params
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  if (!sseClients.has(txId)) sseClients.set(txId, new Set())
  sseClients.get(txId).add(res)
  req.on('close', () => {
    sseClients.get(txId)?.delete(res)
  })
  // enviar estado actual imediatamente
  const tx = transactions.get(txId)
  if (tx) res.write(`data: ${JSON.stringify({ status: tx.status })}\n\n`)
})

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/ping', (_req, res) => res.json({ ok: true }))

// ── Iniciar depósito ──────────────────────────────────────────────────────────
app.post('/api/deposit', async (req, res) => {
  const { phone, amount } = req.body || {}

  if (!phone || !amount) {
    return res.status(400).json({ error: 'Telemóvel e valor são obrigatórios' })
  }

  const phoneClean = String(phone).replace(/\s+/g, '')
  const amountNum  = Number(amount)

  if (isNaN(amountNum) || amountNum <= 0) {
    return res.status(400).json({ error: 'Valor inválido' })
  }

  const txId = randomBytes(6).toString('hex')
  const tx   = {
    id:     txId,
    phone:  phoneClean,
    amount: amountNum,
    status: 'pending',   // pending | succeeded | failed
    ts:     new Date().toISOString(),
    ref:    null,
    error:  null,
  }
  transactions.set(txId, tx)

  // Responder imediatamente com o txId
  res.json({ txId, status: 'pending' })

  // Iniciar colecta no ZumboPay em background
  initiateZumboPayment(tx)
})

// ── Estado de uma transacção ──────────────────────────────────────────────────
app.get('/api/deposit/:txId', (req, res) => {
  const tx = transactions.get(req.params.txId)
  if (!tx) return res.status(404).json({ error: 'Transacção não encontrada' })
  res.json(tx)
})

// ── Webhook do ZumboPay ───────────────────────────────────────────────────────
app.post('/webhook', express.raw({ type: '*/*' }), (req, res) => {
  const rawBody = req.body?.toString() || ''
  const sig     = req.headers['x-zumbopay-signature'] || ''

  // Verificar assinatura
  if (ZUMBO_WEBHOOK_SECRET) {
    try {
      const expected = createHmac('sha256', ZUMBO_WEBHOOK_SECRET).update(rawBody).digest('hex')
      const expBuf   = Buffer.from(expected, 'hex')
      const sigBuf   = Buffer.from(sig, 'hex')
      const ok = sigBuf.length > 0 && sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
      if (!ok) return res.status(401).json({ error: 'Assinatura inválida' })
    } catch {
      return res.status(401).json({ error: 'Assinatura inválida' })
    }
  }

  let event = {}
  try { event = JSON.parse(rawBody) } catch {}

  const ref    = event.data?.source_id || event.data?.reference || event.data?.id
  const status = event.event === 'payment.succeeded' ? 'succeeded'
               : event.event === 'payment.failed'    ? 'failed'
               : null

  if (status && ref) {
    // Procurar transacção pelo ref
    for (const [txId, tx] of transactions) {
      if (tx.ref === ref || tx.id === ref) {
        tx.status = status
        notifyTx(txId, { status })
        break
      }
    }
  }

  res.json({ ok: true })
})

// ── Chamar a API do ZumboPay para iniciar colecta ─────────────────────────────
async function initiateZumboPayment(tx) {
  try {
    const body = JSON.stringify({
      amount:      tx.amount,
      currency:    'MZN',
      phone:       tx.phone,
      merchant_id: ZUMBO_MERCHANT_ID,
      reference:   tx.id,
      description: 'Depósito',
    })

    const resp = await fetch(`${ZUMBO_API_BASE}/v1/collections`, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${ZUMBO_API_KEY}`,
        'X-Api-Key':     ZUMBO_API_KEY,
      },
      body,
    })

    const data = await resp.json().catch(() => ({}))
    console.log('[ZumboPay] POST /v1/collections →', resp.status, JSON.stringify(data))

    if (resp.ok) {
      tx.ref    = data.id || data.reference || data.source_id || tx.id
      tx.status = 'pending'
      notifyTx(tx.id, { status: 'pending' })

      // Polling de estado (caso não haja webhook)
      pollStatus(tx)
    } else {
      tx.status = 'failed'
      tx.error  = data.message || data.error || `Erro ${resp.status}`
      notifyTx(tx.id, { status: 'failed', error: tx.error })
    }
  } catch (err) {
    console.error('[ZumboPay] Erro ao iniciar pagamento:', err.message)
    tx.status = 'failed'
    tx.error  = 'Erro de ligação ao ZumboPay'
    notifyTx(tx.id, { status: 'failed', error: tx.error })
  }
}

// ── Polling de estado ─────────────────────────────────────────────────────────
async function pollStatus(tx, attempts = 0) {
  if (tx.status !== 'pending') return
  if (attempts > 20) {              // ~2 min timeout
    tx.status = 'failed'
    tx.error  = 'Tempo de espera esgotado. O PIN não foi introduzido.'
    notifyTx(tx.id, { status: 'failed', error: tx.error })
    return
  }

  await sleep(6000)
  if (tx.status !== 'pending') return

  try {
    const ref  = tx.ref || tx.id
    const resp = await fetch(`${ZUMBO_API_BASE}/v1/collections/${ref}`, {
      headers: {
        'Authorization': `Bearer ${ZUMBO_API_KEY}`,
        'X-Api-Key':     ZUMBO_API_KEY,
      },
    })
    const data = await resp.json().catch(() => ({}))
    console.log(`[Poll] ${ref} → status=${data.status || '?'}`)

    const s = (data.status || '').toLowerCase()
    if (s === 'successful' || s === 'succeeded' || s === 'completed') {
      tx.status = 'succeeded'
      notifyTx(tx.id, { status: 'succeeded' })
      return
    }
    if (s === 'failed' || s === 'rejected' || s === 'cancelled') {
      tx.status = 'failed'
      tx.error  = data.message || 'Pagamento recusado ou cancelado'
      notifyTx(tx.id, { status: 'failed', error: tx.error })
      return
    }
  } catch (err) {
    console.warn('[Poll] Erro:', err.message)
  }

  pollStatus(tx, attempts + 1)
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)) }

// ── Página principal ──────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(html())
})

function html() { return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Depósito</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }

:root {
  --bg:      #0b0d14;
  --surface: #12151f;
  --card:    #181c29;
  --border:  #242840;
  --accent:  #4f6ef7;
  --accent2: #7c3aed;
  --green:   #22c55e;
  --red:     #ef4444;
  --yellow:  #f59e0b;
  --text:    #e8eaf6;
  --muted:   #6b7280;
  --radius:  16px;
}

body {
  background: var(--bg);
  color: var(--text);
  font-family: 'Segoe UI', system-ui, sans-serif;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px;
}

/* ── Logo / marca ── */
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 36px;
}
.brand-icon {
  width: 40px; height: 40px;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  border-radius: 12px;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px;
}
.brand-name { font-size: 20px; font-weight: 700; letter-spacing: -0.5px; }
.brand-name span { color: var(--accent); }

/* ── Card ── */
.card {
  background: var(--card);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 36px 32px;
  width: 100%;
  max-width: 420px;
  box-shadow: 0 24px 64px rgba(0,0,0,.4);
}

.card-title {
  font-size: 22px;
  font-weight: 700;
  margin-bottom: 6px;
  letter-spacing: -0.4px;
}
.card-sub {
  font-size: 13px;
  color: var(--muted);
  margin-bottom: 28px;
  line-height: 1.5;
}

/* ── Inputs ── */
.field { margin-bottom: 18px; }
.field label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--muted);
  text-transform: uppercase;
  letter-spacing: .6px;
  margin-bottom: 8px;
}
.input-wrap {
  position: relative;
  display: flex;
  align-items: center;
}
.input-icon {
  position: absolute;
  left: 14px;
  font-size: 16px;
  color: var(--muted);
  pointer-events: none;
}
input {
  width: 100%;
  background: var(--surface);
  border: 1.5px solid var(--border);
  border-radius: 12px;
  padding: 14px 16px 14px 42px;
  color: var(--text);
  font-size: 16px;
  font-family: inherit;
  outline: none;
  transition: border-color .2s;
}
input:focus { border-color: var(--accent); }
input::placeholder { color: var(--muted); }

/* Montante com prefixo */
.prefix {
  position: absolute;
  left: 14px;
  font-size: 14px;
  font-weight: 700;
  color: var(--accent);
  pointer-events: none;
}
.input-amount { padding-left: 56px; font-size: 22px; font-weight: 700; }

/* ── Botão ── */
.btn {
  width: 100%;
  padding: 16px;
  border: none;
  border-radius: 12px;
  font-size: 16px;
  font-weight: 700;
  font-family: inherit;
  cursor: pointer;
  transition: opacity .2s, transform .1s;
  background: linear-gradient(135deg, var(--accent), var(--accent2));
  color: #fff;
  margin-top: 8px;
  letter-spacing: .2px;
}
.btn:hover { opacity: .9; }
.btn:active { transform: scale(.99); }
.btn:disabled { opacity: .5; cursor: not-allowed; }

/* ── Estados ── */
#screen-form    { display: block; }
#screen-pending { display: none; }
#screen-success { display: none; }
#screen-failed  { display: none; }

/* Pending */
.pending-box {
  text-align: center;
  padding: 12px 0 8px;
}
.spinner {
  width: 56px; height: 56px;
  border: 4px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin: 0 auto 24px;
}
@keyframes spin { to { transform: rotate(360deg) } }
.pending-title { font-size: 20px; font-weight: 700; margin-bottom: 10px; }
.pending-sub {
  font-size: 14px; color: var(--muted); line-height: 1.6;
  margin-bottom: 24px;
}
.pending-phone {
  display: inline-block;
  background: rgba(79,110,247,.12);
  border: 1px solid rgba(79,110,247,.25);
  border-radius: 8px;
  padding: 6px 14px;
  font-size: 15px;
  font-weight: 700;
  color: var(--accent);
  margin-bottom: 20px;
}
.pending-amount {
  font-size: 36px; font-weight: 800;
  letter-spacing: -1px;
  margin-bottom: 4px;
}
.pending-currency { font-size: 13px; color: var(--muted); margin-bottom: 28px; }
.step-list {
  list-style: none;
  text-align: left;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 16px 20px;
}
.step-list li {
  font-size: 13px;
  color: var(--muted);
  padding: 6px 0;
  display: flex;
  align-items: flex-start;
  gap: 10px;
  border-bottom: 1px solid var(--border);
  line-height: 1.5;
}
.step-list li:last-child { border-bottom: none; }
.step-num {
  min-width: 20px; height: 20px;
  border-radius: 50%;
  background: rgba(79,110,247,.18);
  color: var(--accent);
  font-size: 11px; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
  margin-top: 1px;
}

/* Result screens */
.result-icon {
  width: 72px; height: 72px;
  border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 34px;
  margin: 8px auto 24px;
}
.result-icon.ok  { background: rgba(34,197,94,.15); }
.result-icon.bad { background: rgba(239,68,68,.15); }
.result-title { font-size: 22px; font-weight: 700; margin-bottom: 10px; text-align: center; }
.result-sub   { font-size: 14px; color: var(--muted); line-height: 1.6; text-align: center; margin-bottom: 28px; }
.result-amount {
  font-size: 38px; font-weight: 800;
  letter-spacing: -1px;
  text-align: center; margin-bottom: 4px;
}
.result-currency { font-size: 13px; color: var(--muted); text-align: center; margin-bottom: 28px; }

.tag-ok  { color: var(--green); }
.tag-bad { color: var(--red); }

.btn-outline {
  background: transparent;
  border: 1.5px solid var(--border);
  color: var(--text);
}
.btn-outline:hover { border-color: var(--accent); background: rgba(79,110,247,.08); }

/* Error message */
.error-msg {
  background: rgba(239,68,68,.1);
  border: 1px solid rgba(239,68,68,.25);
  border-radius: 10px;
  padding: 12px 16px;
  font-size: 13px;
  color: #fca5a5;
  margin-bottom: 16px;
  display: none;
}

@media (max-width: 460px) {
  .card { padding: 28px 20px; }
  body { padding: 16px; }
}
</style>
</head>
<body>

<div class="brand">
  <div class="brand-icon">💳</div>
  <div class="brand-name">Zumbo<span>Pay</span></div>
</div>

<div class="card">

  <!-- ── Formulário ── -->
  <div id="screen-form">
    <div class="card-title">Fazer Depósito</div>
    <div class="card-sub">Introduza o seu número e o valor que deseja depositar.</div>

    <div id="error-msg" class="error-msg"></div>

    <div class="field">
      <label>Número de telemóvel</label>
      <div class="input-wrap">
        <span class="input-icon">📱</span>
        <input id="inp-phone" type="tel" placeholder="84 000 0000" maxlength="15" inputmode="tel">
      </div>
    </div>

    <div class="field">
      <label>Valor a depositar</label>
      <div class="input-wrap">
        <span class="prefix">MZN</span>
        <input id="inp-amount" class="input-amount" type="number" placeholder="0.00" min="1" step="0.01" inputmode="decimal">
      </div>
    </div>

    <button class="btn" id="btn-deposit" onclick="startDeposit()">Depositar</button>
  </div>

  <!-- ── Aguardando PIN ── -->
  <div id="screen-pending">
    <div class="pending-box">
      <div class="spinner"></div>
      <div class="pending-amount" id="p-amount"></div>
      <div class="pending-currency">MZN</div>
      <div class="pending-title">Aguardando confirmação</div>
      <div class="pending-phone" id="p-phone"></div>
      <div class="pending-sub">
        Foi enviado um pedido de pagamento para o seu telemóvel.<br>
        Introduza o seu <strong>PIN</strong> para confirmar.
      </div>
      <ol class="step-list">
        <li><span class="step-num">1</span>Verifique o seu telemóvel — apareceu uma notificação do M-Pesa / e-Mola</li>
        <li><span class="step-num">2</span>Seleccione <em>"Aceitar"</em> e introduza o seu PIN</li>
        <li><span class="step-num">3</span>Esta página actualiza automaticamente após a confirmação</li>
      </ol>
    </div>
  </div>

  <!-- ── Sucesso ── -->
  <div id="screen-success">
    <div class="result-icon ok">✓</div>
    <div class="result-amount tag-ok" id="s-amount"></div>
    <div class="result-currency">MZN</div>
    <div class="result-title">Depósito confirmado!</div>
    <div class="result-sub">
      O seu pagamento foi processado com sucesso.<br>O valor já está disponível na sua conta.
    </div>
    <button class="btn" onclick="resetForm()">Novo depósito</button>
  </div>

  <!-- ── Falhou ── -->
  <div id="screen-failed">
    <div class="result-icon bad">✗</div>
    <div class="result-amount tag-bad" id="f-amount"></div>
    <div class="result-currency">MZN</div>
    <div class="result-title">Depósito não confirmado</div>
    <div class="result-sub" id="f-reason">
      Não foi possível processar o pagamento.<br>O PIN não foi introduzido ou o tempo expirou.
    </div>
    <button class="btn" onclick="resetForm()">Tentar novamente</button>
    <button class="btn btn-outline" onclick="resetForm()" style="margin-top:10px">Cancelar</button>
  </div>

</div>

<script>
let currentTxId = null
let evtSource   = null

function show(id) {
  ['form','pending','success','failed'].forEach(s => {
    document.getElementById('screen-' + s).style.display = s === id ? 'block' : 'none'
  })
}

function fmt(v) {
  return Number(v).toLocaleString('pt-MZ', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
}

async function startDeposit() {
  const phone  = document.getElementById('inp-phone').value.trim()
  const amount = document.getElementById('inp-amount').value.trim()
  const errEl  = document.getElementById('error-msg')
  errEl.style.display = 'none'

  if (!phone) { showError('Introduza o número de telemóvel.'); return }
  if (!amount || Number(amount) <= 0) { showError('Introduza um valor válido.'); return }

  const btn = document.getElementById('btn-deposit')
  btn.disabled = true
  btn.textContent = 'A processar…'

  try {
    const r = await fetch('/api/deposit', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ phone, amount: Number(amount) })
    })
    const d = await r.json()
    if (!r.ok) { showError(d.error || 'Erro ao iniciar depósito.'); btn.disabled = false; btn.textContent = 'Depositar'; return }

    currentTxId = d.txId
    document.getElementById('p-phone').textContent  = phone
    document.getElementById('p-amount').textContent = fmt(amount)
    document.getElementById('s-amount').textContent = fmt(amount)
    document.getElementById('f-amount').textContent = fmt(amount)
    show('pending')

    listenStatus(d.txId)
  } catch (e) {
    showError('Erro de ligação. Tente novamente.')
    btn.disabled = false
    btn.textContent = 'Depositar'
  }
}

function listenStatus(txId) {
  if (evtSource) evtSource.close()
  evtSource = new EventSource('/events/' + txId)
  evtSource.onmessage = e => {
    const d = JSON.parse(e.data)
    if (d.status === 'succeeded') {
      evtSource.close()
      show('success')
    } else if (d.status === 'failed') {
      evtSource.close()
      const reason = d.error || 'O PIN não foi introduzido ou o tempo expirou.'
      document.getElementById('f-reason').textContent = reason
      show('failed')
    }
  }
  evtSource.onerror = () => {
    // Fallback: polling
    evtSource.close()
    pollFallback(txId)
  }
}

async function pollFallback(txId, n = 0) {
  if (n > 20) {
    document.getElementById('f-reason').textContent = 'Tempo de espera esgotado. Tente novamente.'
    show('failed')
    return
  }
  await new Promise(r => setTimeout(r, 5000))
  try {
    const r = await fetch('/api/deposit/' + txId)
    const d = await r.json()
    if (d.status === 'succeeded') { show('success'); return }
    if (d.status === 'failed') {
      document.getElementById('f-reason').textContent = d.error || 'O PIN não foi introduzido ou o tempo expirou.'
      show('failed')
      return
    }
  } catch {}
  pollFallback(txId, n + 1)
}

function showError(msg) {
  const el = document.getElementById('error-msg')
  el.textContent = msg
  el.style.display = 'block'
}

function resetForm() {
  if (evtSource) evtSource.close()
  currentTxId = null
  document.getElementById('inp-phone').value  = ''
  document.getElementById('inp-amount').value = ''
  document.getElementById('error-msg').style.display = 'none'
  document.getElementById('btn-deposit').disabled    = false
  document.getElementById('btn-deposit').textContent = 'Depositar'
  show('form')
}

show('form')
</script>
</body>
</html>`
}

// ── Iniciar servidor ──────────────────────────────────────────────────────────
const server = createServer(app)
server.listen(PORT, '0.0.0.0', () => {
  console.log(`ZumboPay Deposit a correr em :${PORT}`)
})
