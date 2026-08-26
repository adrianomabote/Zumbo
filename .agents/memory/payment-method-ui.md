---
name: Métodos no checkout
description: Preferência confirmada para a apresentação dos meios de pagamento
---

No checkout, M-Pesa e e-Mola são uma única opção visual, apresentada como “M-Pesa / e-Mola”, sem mostrar prefixos. O método específico deve ser inferido pelo prefixo do número, sem obrigar o utilizador a escolher entre dois cartões.

**Why:** A separação em duas casas confundia a escolha; o próprio número já determina o operador de pagamento.

**How to apply:** Manter os dois nomes no mesmo cartão e preservar no servidor a validação 84/85 para M-Pesa e 86/87 para e-Mola. Crédito pode continuar como opção separada.