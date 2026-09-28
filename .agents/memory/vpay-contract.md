---
name: Checkout hospedado Vpay
description: Contrato verificado e limites conhecidos do checkout Vpay integrado pela API pública.
---

A API pública Vpay confirma `https://api.vpay.co.mz`, autenticação `POST /v1/auth/token` com `client_id` e `client_secret`, criação de encomendas em `POST /v1/orders` e consulta de estado em `GET /v1/orders/{id}/status`. A SDK oficial redirecciona encomendas para `https://checkout.vpay.co.mz/{orderId}`. A criação exige a lista de produtos no campo raiz `items`; `products` é ignorado e resulta em HTTP 400 “Pedido deve conter pelo menos um item”. O payload documentado aceita produto inline, dados do cliente e desactivações de morada/entrega. As credenciais do projecto foram autenticadas anteriormente com sucesso. O endpoint não documenta webhook nem parâmetro de URL de retorno. A unidade exacta de `amount` na resposta de estado ainda deve ser confirmada num checkout controlado.

**Why:** A loja só pode encaminhar a encomenda para USSD depois de a Vpay confirmar o pagamento. A criação de uma encomenda e o regresso do checkout, por si só, não provam pagamento.

**How to apply:** Criar encomendas com `items`, usar checkout hospedado, redirecionar apenas para o domínio oficial e consultar o estado no backend. Só aceitar `PAID` com identificador correspondente e valor localmente compatível; estado, valor ou resposta desconhecidos ficam pendentes. Não inventar URL de retorno nem assumir webhook. Confirmar a representação do valor antes de alterar as regras de validação.