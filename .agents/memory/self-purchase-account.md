---
name: Conta que recebe megas
description: Regra de segurança e produto para compras pessoais
---

Em “Comprar Para Mim”, o número da conta autenticada é a conta que recebe os megas. O número mostrado no checkout é apenas uma confirmação visual; o servidor deve continuar a usar o telefone da sessão, não um valor enviado pelo navegador.

**Why:** Impede que uma compra pessoal seja entregue numa conta diferente e mantém o perfil como fonte de verdade.

**How to apply:** Ao alterar o telefone no perfil, actualizar a sessão/cookie e reflectir o novo número no checkout pessoal.