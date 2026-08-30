---
name: Métodos no checkout
description: Preferência confirmada para a apresentação dos meios de pagamento
---

No checkout, M-Pesa e e-Mola são uma única opção visual, apresentada como “M-Pesa / e-Mola”, sem mostrar prefixos. O método específico deve ser inferido pelo prefixo do número, sem obrigar o utilizador a escolher entre dois cartões. O número de pagamento aceita 84/85/86/87; o beneficiário aceita apenas 84/85.

**Why:** A separação em duas casas confundia a escolha; o próprio número já determina o operador de pagamento.

**How to apply:** Manter os dois nomes no mesmo cartão, indicar M-Pesa/e-Mola apenas no campo do número de pagamento e preservar no servidor a validação 84/85 para M-Pesa, 86/87 para e-Mola e somente 84/85 para beneficiários. Crédito pode continuar como opção separada; ao escolhê-lo, ocultar o número pagador e exigir apenas o beneficiário quando a compra for para outra pessoa. Ofertas abaixo de 20 MT são exclusivas de crédito; recargas aceitam M-Pesa/e-Mola e começam em 20 MT.