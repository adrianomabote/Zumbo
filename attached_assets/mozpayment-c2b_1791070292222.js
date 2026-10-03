/**
 * MozPayment C2B adapter for Node.js (ES modules).
 *
 * Server-side only: keep MOPAYMENT_WALLET_ID in your secret manager.
 * This module creates and classifies a provider request; it does not credit
 * an application balance. Persist the attempt before calling the gateway,
 * and credit only a "paid" outcome inside a locked, atomic DB transaction.
 * A timeout or "unknown" result must not trigger an automatic second charge.
 */

export const MOZPAYMENT_ENDPOINTS = Object.freeze({
  mpesa: 'https://mozpayment.co.mz/api/1.1/wf/pagamentorotativompesa',
  emola: 'https://mozpayment.co.mz/api/1.1/wf/pagamentorotativoemola',
})

const REJECTED_STATUSES = new Set([
  'cancelled',
  'canceled',
  'declined',
  'failed',
  'failure',
  'rejected',
])

function getPayload(body) {
  if (body?.data && typeof body.data === 'object') return body.data
  if (body?.response && typeof body.response === 'object') return body.response
  return body
}

function normalizePhone(phone) {
  const digits = String(phone ?? '').replace(/\D/g, '')
  const local = digits.startsWith('258') ? digits.slice(3) : digits
  if (!/^\d{9}$/.test(local)) {
    throw new TypeError('O telefone deve ter 9 dígitos locais moçambicanos.')
  }
  return local
}

export function buildMozPaymentRequestBody({ walletId, phone, amountMt }) {
  if (typeof walletId !== 'string' || !walletId.trim()) {
    throw new TypeError('MOPAYMENT_WALLET_ID não está configurado no servidor.')
  }
  if (!Number.isSafeInteger(amountMt) || amountMt < 1) {
    throw new TypeError('O montante deve ser um número inteiro positivo em MT.')
  }

  return {
    carteira: walletId.trim(),
    numero: normalizePhone(phone),
    cliente: `Recarga - ${amountMt} MT`,
    valor: String(amountMt),
  }
}

/**
 * Classifies only known, explicit MozPayment outcomes.
 * HTTP 200 or generic wrapper text alone is never proof of payment.
 */
export function classifyMozPaymentResponse(httpStatus, body) {
  const payload = getPayload(body)
  const code = Number(payload?.cod ?? body?.cod)
  const status = String(payload?.status ?? body?.status ?? '').trim().toLowerCase()
  const rawReference = payload?.transacao ?? body?.transacao
  const providerReference =
    typeof rawReference === 'string' || typeof rawReference === 'number'
      ? String(rawReference).trim().slice(0, 255)
      : ''
  const message = String(
    payload?.Status ??
      payload?.detalhe ??
      payload?.mensagem ??
      body?.mensagem ??
      body?.Status ??
      '',
  )
    .trim()
    .slice(0, 500)

  if (code === 401 || code === 409 || REJECTED_STATUSES.has(status)) {
    return { kind: 'failed', providerReference, message }
  }

  const wrappedSuccess =
    httpStatus === 200 &&
    String(body?.status ?? '').trim().toLowerCase() === 'success' &&
    code === 200 &&
    message.toLowerCase() === 'pagamento realizado com sucesso'
  const legacySuccess =
    httpStatus === 200 &&
    code === 200 &&
    status === 'success' &&
    providerReference.length > 0

  // Check definitive success before searching wrapper text. Bubble can
  // include stale PIN/balance error wording around a confirmed payment.
  if (wrappedSuccess || legacySuccess) {
    return { kind: 'paid', providerReference, message }
  }

  const wrappedErrorText = JSON.stringify(body ?? {})
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()

  const incorrectPin =
    Number(body?.statusCode) >= 400 &&
    /\bpin\b[\s\S]{0,100}\bincorret[oa]\b/.test(wrappedErrorText)
  if (incorrectPin) {
    return { kind: 'failed', providerReference, message: 'PIN incorreto' }
  }

  const insufficientFunds =
    /\b(saldo insuficiente|saldo nao e suficiente|fundos? insuficientes?|saldo baixo|sem saldo|insufficient (?:account )?balance|insufficient funds|not enough (?:balance|funds)|low balance)\b/
      .test(wrappedErrorText)
  if (insufficientFunds) {
    return {
      kind: 'failed',
      providerReference,
      message: 'Saldo insuficiente',
      failureReason: 'insufficient_funds',
    }
  }

  return { kind: 'unknown', providerReference, message }
}

/**
 * Sends one C2B request and returns both the raw provider body and outcome.
 * Network/timeout errors are thrown so the caller can save the attempt as
 * "unknown". Do not retry the provider call automatically after an error.
 */
export async function createMozPaymentCharge({
  method,
  phone,
  amountMt,
  walletId = process.env.MOPAYMENT_WALLET_ID,
  fetchImpl = globalThis.fetch,
  timeoutMs = 30_000,
} = {}) {
  const normalizedMethod = String(method ?? '').trim().toLowerCase()
  const endpoint = MOZPAYMENT_ENDPOINTS[normalizedMethod]
  if (!endpoint) throw new TypeError('Método MozPayment inválido; usa mpesa ou emola.')
  if (typeof fetchImpl !== 'function') throw new TypeError('fetch não está disponível neste runtime.')

  const requestBody = buildMozPaymentRequestBody({ walletId, phone, amountMt })
  const signal =
    typeof globalThis.AbortSignal?.timeout === 'function'
      ? globalThis.AbortSignal.timeout(timeoutMs)
      : undefined

  const response = await fetchImpl(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(requestBody),
    ...(signal ? { signal } : {}),
  })
  const body = await response.json().catch(() => null)
  const httpStatus = Number(response.status) || 0

  return {
    httpStatus,
    body,
    outcome: classifyMozPaymentResponse(httpStatus, body),
  }
}