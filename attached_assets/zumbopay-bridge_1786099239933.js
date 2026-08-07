/**
 * ZumboPay Bridge — Servidor autónomo de bridge ZumboPay → MolaBet
 *
 * Como usar:
 *   node zumbopay-bridge.js
 *
 * URL a registar no ZumboPay (Painel → Programadores → Webhooks):
 *   https://<domínio-deste-servidor>/webhook
 *
 * Variáveis de ambiente (opcionais — já têm valores por defeito):
 *   PORT                  Porta do servidor (default: 4000)
 *   ZUMBO_WEBHOOK_SECRET  Secret HMAC do ZumboPay (default: 'teste.com')
 *   ZUMBO_API_KEY         API Key do ZumboPay
 *   ZUMBO_MERCHANT_ID     Merchant ID do ZumboPay
 *   MOLABET_URL           URL base do MolaBet (ex: https://molabet.replit.app)
 *   BRIDGE_PASSWORD       Senha para aceder ao dashboard (default: 'admin')
 */

import express from 'express'
import { createHmac, timingSafeEqual, randomBytes } from 'crypto'
import { createServer } from 'http'

// ── Configuração ──────────────────────────────────────────────────────────────
const PORT                = process.env.PORT                || 4000
const ZUMBO_WEBHOOK_SECRET= process.env.ZUMBO_WEBHOOK_SECRET|| 'teste.com'
const ZUMBO_API_KEY       = process.env.ZUMBO_API_KEY       || 'zk_live_a694231e0f188fe3599e4de8feda28b35714ed9b6fa3cd0e'
const ZUMBO_MERCHANT_ID   = process.env.ZUMBO_MERCHANT_ID   || 'MCH_B29C53549C'
const MOLABET_URL         = process.env.MOLABET_URL         || ''   // ex: https://molabet.replit.app
const BRIDGE_PASSWORD     = process.env.BRIDGE_PASSWORD     || 'admin'

// ── Armazenamento em memória ──────────────────────────────────────────────────
const webhooks   = []   // todos os webhooks recebidos (max 500)
const relayLog   = []   // log dos reenvios para o MolaBet (max 200)

function pushWebhook(entry) {
  webhooks.unshift(entry)
  if (webhooks.length > 500) webhooks.pop()
}
function pushRelay(entry) {
  relayLog.unshift(entry)
  if (relayLog.length > 200) relayLog.pop()
}

// ── App Express ───────────────────────────────────────────────────────────────
const app = express()

// ── SSE clients (para actualização em tempo real no browser) ─────────────────
const sseClients = new Set()
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`
  for (const res of sseClients) {
    try { res.write(msg) } catch {}
  }
}

// ── Endpoint SSE (tempo real) ─────────────────────────────────────────────────
app.get('/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache')
  res.setHeader('Connection', 'keep-alive')
  res.flushHeaders()
  sseClients.add(res)
  req.on('close', () => sseClients.delete(res))
})

// ── Endpoint de health check ──────────────────────────────────────────────────
app.get('/ping', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }))

// ── Endpoint de API (JSON) — lista transações ─────────────────────────────────
app.get('/api/webhooks', (req, res) => {
  const pwd = req.headers['x-bridge-password'] || req.query.password
  if (pwd !== BRIDGE_PASSWORD) return res.status(401).json({ error: 'Senha inválida' })
  res.json({ webhooks, relayLog })
})

// ── Relay para o MolaBet ──────────────────────────────────────────────────────
async function relayToMolaBet(rawBody, headers) {
  if (!MOLABET_URL) {
    pushRelay({ ts: new Date().toISOString(), status: 'skipped', reason: 'MOLABET_URL não configurado' })
    return
  }
  const url = `${MOLABET_URL.replace(/\/$/, '')}/api/webhook/zumbopay`
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-zumbopay-signature': headers['x-zumbopay-signature'] || '',
        'x-bridge-relay': '1',
      },
      body: rawBody,
    })
    const text = await resp.text().catch(() => '')
    pushRelay({ ts: new Date().toISOString(), status: resp.status, body: text.slice(0, 200) })
    broadcast({ type: 'relay', status: resp.status })
    console.log(`[Relay] → MolaBet ${url} | status=${resp.status}`)
  } catch (err) {
    pushRelay({ ts: new Date().toISOString(), status: 'error', reason: err.message })
    broadcast({ type: 'relay', status: 'error' })
    console.error('[Relay] Erro:', err.message)
  }
}

// ── Webhook endpoint — regista no ZumboPay ────────────────────────────────────
app.post('/webhook', express.raw({ type: '*/*' }), async (req, res) => {
  const rawBody = req.body?.toString() || ''
  const sig     = req.headers['x-zumbopay-signature'] || ''
  const ts      = new Date().toISOString()

  // 1. Verificar assinatura HMAC
  let sigOk = true
  if (ZUMBO_WEBHOOK_SECRET) {
    try {
      const expBuf = Buffer.from(
        createHmac('sha256', ZUMBO_WEBHOOK_SECRET).update(rawBody).digest('hex'), 'hex'
      )
      const sigBuf = Buffer.from(sig, 'hex')
      sigOk = sigBuf.length > 0 && sigBuf.length === expBuf.length && timingSafeEqual(sigBuf, expBuf)
    } catch {
      sigOk = false
    }
  }

  // 2. Parse do payload
  let event = {}
  try { event = JSON.parse(rawBody) } catch {}

  const entry = {
    id:        randomBytes(4).toString('hex'),
    ts,
    event:     event.event || '?',
    ref:       event.data?.source_id || event.data?.reference || event.data?.id || '—',
    phone:     event.data?.channel_reference || event.customerPhone || event.data?.phone || '—',
    amount:    event.data?.amount ?? '—',
    currency:  event.data?.currency || 'MZN',
    method:    event.data?.payment_method || event.transaction?.payment_method || '—',
    sigOk,
    raw:       rawBody.slice(0, 2000),
    relayed:   false,
    relayStatus: null,
  }

  pushWebhook(entry)
  broadcast({ type: 'webhook', entry })

  console.log(`[Webhook] ${event.event} | ref=${entry.ref} | phone=${entry.phone} | amount=${entry.amount} | sigOk=${sigOk}`)

  if (!sigOk) {
    console.warn('[Webhook] Assinatura inválida')
    res.status(401).json({ error: 'Assinatura inválida' })
    // Ainda assim guardar para diagnóstico — mas não reenviar
    return
  }

  // 3. Reenviar para o MolaBet em background
  if (['payment.succeeded', 'payment.failed', 'payout.completed', 'payout.failed'].includes(event.event)) {
    entry.relayed = true
    relayToMolaBet(rawBody, req.headers).then(r => {
      entry.relayStatus = 'done'
    })
  }

  res.json({ ok: true })
})

// ── Dashboard HTML ────────────────────────────────────────────────────────────
function renderDashboard() {
  return `<!DOCTYPE html>
<html lang="pt">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>ZumboPay Bridge — Dashboard</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0 }
  :root {
    --bg: #0f1117;
    --card: #1a1d27;
    --border: #2a2d3a;
    --green: #22c55e;
    --red: #ef4444;
    --yellow: #f59e0b;
    --blue: #3b82f6;
    --text: #e2e8f0;
    --muted: #64748b;
    --accent: #6366f1;
  }
  body { background: var(--bg); color: var(--text); font-family: 'Segoe UI', system-ui, sans-serif; font-size: 14px; min-height: 100vh; }
  header { background: var(--card); border-bottom: 1px solid var(--border); padding: 16px 24px; display: flex; align-items: center; gap: 16px; }
  header h1 { font-size: 18px; font-weight: 700; letter-spacing: -0.3px; }
  header h1 span { color: var(--accent); }
  .badge { display: inline-flex; align-items: center; gap: 6px; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 600; }
  .badge.live { background: rgba(34,197,94,.15); color: var(--green); }
  .badge.offline { background: rgba(239,68,68,.15); color: var(--red); }
  .dot { width: 7px; height: 7px; border-radius: 50%; background: currentColor; animation: pulse 1.5s infinite; }
  @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.4} }
  .header-info { margin-left: auto; display: flex; gap: 12px; align-items: center; font-size: 12px; color: var(--muted); }
  .header-info strong { color: var(--text); }
  main { max-width: 1400px; margin: 0 auto; padding: 24px; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(180px,1fr)); gap: 16px; margin-bottom: 24px; }
  .stat { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; }
  .stat-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; text-transform: uppercase; letter-spacing: .5px; }
  .stat-value { font-size: 28px; font-weight: 700; }
  .stat-value.green { color: var(--green); }
  .stat-value.red { color: var(--red); }
  .stat-value.blue { color: var(--blue); }
  .stat-value.yellow { color: var(--yellow); }
  .section { background: var(--card); border: 1px solid var(--border); border-radius: 12px; margin-bottom: 24px; overflow: hidden; }
  .section-header { padding: 16px 20px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .section-title { font-size: 14px; font-weight: 600; }
  .section-count { font-size: 12px; color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th { padding: 10px 16px; text-align: left; font-size: 11px; font-weight: 600; color: var(--muted); text-transform: uppercase; letter-spacing: .5px; border-bottom: 1px solid var(--border); background: rgba(255,255,255,.02); }
  td { padding: 10px 16px; border-bottom: 1px solid rgba(42,45,58,.6); vertical-align: middle; }
  tr:last-child td { border-bottom: none; }
  tr:hover td { background: rgba(255,255,255,.02); }
  .pill { display: inline-flex; align-items: center; gap: 4px; padding: 3px 8px; border-radius: 999px; font-size: 11px; font-weight: 600; }
  .pill.success { background: rgba(34,197,94,.12); color: var(--green); }
  .pill.error { background: rgba(239,68,68,.12); color: var(--red); }
  .pill.pending { background: rgba(245,158,11,.12); color: var(--yellow); }
  .pill.info { background: rgba(59,130,246,.12); color: var(--blue); }
  .pill.gray { background: rgba(100,116,139,.12); color: var(--muted); }
  .mono { font-family: 'Courier New', monospace; font-size: 12px; color: var(--muted); }
  .phone { font-weight: 600; color: var(--text); }
  .amount { font-weight: 700; color: var(--green); }
  .molabet-url { background: rgba(99,102,241,.08); border: 1px solid rgba(99,102,241,.2); border-radius: 8px; padding: 12px 16px; font-family: monospace; font-size: 13px; color: var(--accent); word-break: break-all; margin-top: 8px; }
  .config-box { background: var(--card); border: 1px solid var(--border); border-radius: 12px; padding: 20px; margin-bottom: 24px; }
  .config-box h2 { font-size: 14px; font-weight: 600; margin-bottom: 16px; display: flex; align-items: center; gap: 8px; }
  .config-row { display: flex; justify-content: space-between; align-items: center; padding: 8px 0; border-bottom: 1px solid var(--border); }
  .config-row:last-child { border-bottom: none; }
  .config-key { color: var(--muted); font-size: 12px; }
  .config-val { font-family: monospace; font-size: 12px; color: var(--text); }
  .config-val.ok { color: var(--green); }
  .config-val.warn { color: var(--yellow); }
  .empty { padding: 40px; text-align: center; color: var(--muted); }
  .relay-ok { color: var(--green); font-size: 11px; }
  .relay-no { color: var(--muted); font-size: 11px; }
  .sig-ok { color: var(--green); }
  .sig-bad { color: var(--red); }
  @media(max-width:700px){ th,td{ padding:8px 10px; font-size:12px; } .stats{ grid-template-columns:1fr 1fr; } }
</style>
</head>
<body>
<header>
  <h1>ZumboPay <span>Bridge</span></h1>
  <span class="badge live" id="statusBadge"><span class="dot"></span> Ligado</span>
  <div class="header-info">
    Webhook URL: <strong id="webhookUrl">…</strong>
    &nbsp;·&nbsp; Relay MolaBet: <strong>${MOLABET_URL || 'não configurado'}</strong>
  </div>
</header>

<main>
  <!-- Configuração -->
  <div class="config-box">
    <h2>⚙️ Configuração ZumboPay</h2>
    <div class="config-row">
      <span class="config-key">API Key</span>
      <span class="config-val ok">${ZUMBO_API_KEY.slice(0,12)}…${ZUMBO_API_KEY.slice(-6)}</span>
    </div>
    <div class="config-row">
      <span class="config-key">Merchant ID</span>
      <span class="config-val ok">${ZUMBO_MERCHANT_ID}</span>
    </div>
    <div class="config-row">
      <span class="config-key">Webhook Secret</span>
      <span class="config-val ok">${ZUMBO_WEBHOOK_SECRET ? '✓ configurado' : '✗ não definido'}</span>
    </div>
    <div class="config-row">
      <span class="config-key">Relay → MolaBet</span>
      <span class="config-val ${MOLABET_URL ? 'ok' : 'warn'}">${MOLABET_URL || '⚠ MOLABET_URL não definido — relay desactivado'}</span>
    </div>
    <div class="config-row">
      <span class="config-key">URL a registar no ZumboPay (Webhooks)</span>
      <span class="config-val" id="webhookUrlFull" style="color:var(--accent)">a carregar…</span>
    </div>
  </div>

  <!-- Stats -->
  <div class="stats">
    <div class="stat">
      <div class="stat-label">Total recebidos</div>
      <div class="stat-value blue" id="statTotal">0</div>
    </div>
    <div class="stat">
      <div class="stat-label">Pagamentos confirmados</div>
      <div class="stat-value green" id="statSucceeded">0</div>
    </div>
    <div class="stat">
      <div class="stat-label">Pagamentos falhados</div>
      <div class="stat-value red" id="statFailed">0</div>
    </div>
    <div class="stat">
      <div class="stat-label">Payouts concluídos</div>
      <div class="stat-value yellow" id="statPayouts">0</div>
    </div>
    <div class="stat">
      <div class="stat-label">Relays → MolaBet</div>
      <div class="stat-value" id="statRelays">0</div>
    </div>
  </div>

  <!-- Tabela de webhooks -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">📨 Webhooks recebidos (tempo real)</span>
      <span class="section-count" id="webhookCount">0 eventos</span>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>Hora</th>
            <th>Evento</th>
            <th>Referência</th>
            <th>Telefone</th>
            <th>Valor</th>
            <th>Método</th>
            <th>Assinatura</th>
            <th>Relay</th>
          </tr>
        </thead>
        <tbody id="webhookTable">
          <tr><td colspan="8" class="empty">Aguardando webhooks do ZumboPay…</td></tr>
        </tbody>
      </table>
    </div>
  </div>

  <!-- Log de relays -->
  <div class="section">
    <div class="section-header">
      <span class="section-title">🔁 Log de relays para MolaBet</span>
      <span class="section-count" id="relayCount">0 relays</span>
    </div>
    <div style="overflow-x:auto">
      <table>
        <thead>
          <tr>
            <th>Hora</th>
            <th>Status HTTP</th>
            <th>Resposta</th>
          </tr>
        </thead>
        <tbody id="relayTable">
          <tr><td colspan="3" class="empty">Sem relays ainda…</td></tr>
        </tbody>
      </table>
    </div>
  </div>
</main>

<script>
// Preencher URL do webhook
const origin = window.location.origin
document.getElementById('webhookUrl').textContent = origin + '/webhook'
document.getElementById('webhookUrlFull').textContent = origin + '/webhook'

// Dados iniciais via API
async function loadData() {
  const r = await fetch('/api/webhooks?password=${BRIDGE_PASSWORD}').catch(() => null)
  if (!r?.ok) return
  const d = await r.json()
  d.webhooks.forEach(e => prependWebhook(e))
  d.relayLog.forEach(e => prependRelay(e))
  updateStats()
}

function formatTs(ts) {
  const d = new Date(ts)
  return d.toLocaleTimeString('pt-PT', { hour:'2-digit', minute:'2-digit', second:'2-digit' })
}

function eventPill(ev) {
  if (ev === 'payment.succeeded') return '<span class="pill success">✓ payment.succeeded</span>'
  if (ev === 'payment.failed')    return '<span class="pill error">✗ payment.failed</span>'
  if (ev === 'payout.completed')  return '<span class="pill info">↗ payout.completed</span>'
  if (ev === 'payout.failed')     return '<span class="pill error">✗ payout.failed</span>'
  return '<span class="pill gray">' + ev + '</span>'
}

function prependWebhook(e) {
  const tbody = document.getElementById('webhookTable')
  // remover placeholder
  if (tbody.querySelector('.empty')) tbody.innerHTML = ''
  const tr = document.createElement('tr')
  tr.innerHTML = \`
    <td class="mono">\${formatTs(e.ts)}</td>
    <td>\${eventPill(e.event)}</td>
    <td class="mono" style="max-width:160px;overflow:hidden;text-overflow:ellipsis" title="\${e.ref}">\${e.ref}</td>
    <td class="phone">\${e.phone}</td>
    <td class="amount">\${e.amount !== '—' ? Number(e.amount).toLocaleString('pt-PT',{minimumFractionDigits:2}) + ' ' + (e.currency||'MZN') : '—'}</td>
    <td>\${e.method}</td>
    <td>\${e.sigOk ? '<span class="sig-ok">✓ válida</span>' : '<span class="sig-bad">✗ inválida</span>'}</td>
    <td>\${e.relayed ? '<span class="relay-ok">✓ reenviado</span>' : '<span class="relay-no">—</span>'}</td>
  \`
  tbody.prepend(tr)
}

function prependRelay(e) {
  const tbody = document.getElementById('relayTable')
  if (tbody.querySelector('.empty')) tbody.innerHTML = ''
  const tr = document.createElement('tr')
  const statusClass = (e.status >= 200 && e.status < 300) ? 'success' : (e.status === 'skipped' ? 'gray' : 'error')
  tr.innerHTML = \`
    <td class="mono">\${formatTs(e.ts)}</td>
    <td><span class="pill \${statusClass}">\${e.status}</span></td>
    <td class="mono" style="color:var(--muted);font-size:11px">\${e.reason || e.body || '—'}</td>
  \`
  tbody.prepend(tr)
}

function updateStats() {
  const rows = document.getElementById('webhookTable').querySelectorAll('tr:not(.empty)')
  document.getElementById('statTotal').textContent = rows.length
  document.getElementById('webhookCount').textContent = rows.length + ' eventos'

  // contar por tipo (a partir do texto do pill)
  let s=0, f=0, p=0, rel=0
  rows.forEach(tr => {
    const ev = tr.querySelector('td:nth-child(2)')?.textContent || ''
    if (ev.includes('payment.succeeded')) s++
    if (ev.includes('payment.failed')) f++
    if (ev.includes('payout.completed')) p++
    const relay = tr.querySelector('td:nth-child(8)')?.textContent || ''
    if (relay.includes('reenviado')) rel++
  })
  document.getElementById('statSucceeded').textContent = s
  document.getElementById('statFailed').textContent = f
  document.getElementById('statPayouts').textContent = p
  document.getElementById('statRelays').textContent = rel

  const relayRows = document.getElementById('relayTable').querySelectorAll('tr:not(.empty)')
  document.getElementById('relayCount').textContent = relayRows.length + ' relays'
}

// SSE para actualizações em tempo real
const evtSource = new EventSource('/events')
evtSource.onmessage = e => {
  const d = JSON.parse(e.data)
  if (d.type === 'webhook' && d.entry) {
    prependWebhook(d.entry)
    updateStats()
  }
  if (d.type === 'relay') {
    // relay entra via loadData periódico para ter o body
    setTimeout(loadData, 800)
  }
}
evtSource.onopen  = () => { document.getElementById('statusBadge').className = 'badge live'; document.getElementById('statusBadge').innerHTML = '<span class="dot"></span> Ligado' }
evtSource.onerror = () => { document.getElementById('statusBadge').className = 'badge offline'; document.getElementById('statusBadge').innerHTML = '● Desligado' }

// Carregar dados iniciais
loadData()
// Refrescar stats a cada 10s
setInterval(loadData, 10000)
</script>
</body>
</html>`
}

// ── Rota do dashboard ─────────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  res.setHeader('Content-Type', 'text/html; charset=utf-8')
  res.send(renderDashboard())
})

// ── Iniciar servidor ──────────────────────────────────────────────────────────
const server = createServer(app)
server.listen(PORT, '0.0.0.0', () => {
  console.log('─────────────────────────────────────────────')
  console.log(`  ZumboPay Bridge a correr em :${PORT}`)
  console.log(`  Dashboard:   http://localhost:${PORT}/`)
  console.log(`  Webhook URL: http://localhost:${PORT}/webhook`)
  console.log(`  Relay URL:   ${MOLABET_URL || '(não configurado — defina MOLABET_URL)'}`)
  console.log('─────────────────────────────────────────────')
})
