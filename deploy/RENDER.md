# Hospedar a Megabyte no Render

O ficheiro `render.yaml` configura um único Web Service para a API, o gateway
de terceiros e o frontend. O serviço usa o `PORT` fornecido pelo Render e
mantém os dados locais do bridge no disco persistente montado em
`/var/data/net-servicos`.

## Configuração

1. No Render, crie um Blueprint a partir deste repositório e seleccione
   `render.yaml`.
2. Preencha as variáveis marcadas como `sync: false` no serviço:
   - `DATABASE_URL`: ligação PostgreSQL usada pelo painel e pelos pagamentos.
   - `SITE_URL`: domínio público, por exemplo `https://exemplo.com`. Se ficar
     vazio, o bridge usa o domínio automático fornecido em
     `RENDER_EXTERNAL_URL`.
   - `PAGAR_API_KEY`, `PAGAR_SIGNING_SECRET` e `PAGAR_WEBHOOK_SECRET`.
   - `PAGAR_WEBHOOK_URL`: normalmente
     `https://<dominio>/api/pagar/webhook`.
   - `ADMIN_PASS` e `SESSION_SECRET`.
3. Faça o deploy e confirme que `GET /api/healthz` responde com HTTP 200.
4. No painel admin, crie ou active as chaves do gateway para os projectos
   terceiros. A chave e o segredo são mostrados no painel; guarde-os apenas
   no servidor do projecto integrador.

## Endpoints públicos

- Loja: `/megas`
- Gateway: `/gateway/docs`
- Criar pagamento: `POST /gateway/api/pay`
- Consultar pagamento: `GET /gateway/api/status/<txId>`
- Webhook Pagar: `/api/pagar/webhook`

O gateway continua separado das transacções normais da Megabyte no painel.
Cada cobrança enviada ao Pagar identifica uma compra de megas. Para valores
iguais a um pacote normal, usa a quantidade exacta do catálogo; para valores
fora do catálogo, calcula determinísticamente `valor em MT × 40 MB`.

## Domínio e callbacks

Depois de ligar um domínio personalizado, actualize `SITE_URL` e
`PAGAR_WEBHOOK_URL` com HTTPS. Os `callback_url` enviados por terceiros também
devem ser endereços HTTPS públicos; endereços privados ou locais são recusados.

## Armazenamento e segredos

O PostgreSQL é a fonte persistente das chaves e transacções do Gateway. Os
ficheiros JSON continuam a ser mantidos para compatibilidade, migração inicial
e fallback local; o bridge importa os registos existentes para PostgreSQL e
sincroniza alterações futuras. As tabelas do Gateway são criadas
automaticamente na inicialização.

O disco persistente continua recomendado para encomendas antigas, utilizadores,
estado de manutenção e para o fallback JSON. Não use o plano sem disco em
produção se esses dados legados ainda forem necessários: o filesystem efémero
pode perder os ficheiros após reinício ou substituição da instância.

Não coloque valores reais de chaves, segredos, passwords ou URLs privadas no
repositório. Use as variáveis de ambiente do Render. A chave principal
`GW_MASTER_KEY`/`GW_MASTER_SECRET` é opcional; as chaves criadas no painel são
guardadas no PostgreSQL e também no disco persistente quando este estiver
disponível.

## Atualizações

Um novo deploy recompila primeiro o frontend e a API. O serviço inicia a API
principal, que inicia internamente o bridge legado; não é necessário configurar
um segundo serviço ou uma porta pública adicional para o bridge.