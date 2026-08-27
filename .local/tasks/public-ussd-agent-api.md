# API pública para agente USSD

## What & Why
Formalizar a ligação entre o servidor Megabyte e um novo APK externo criado no AI Studio. O APK deverá receber pedidos de activação pagos, executar a sequência USSD no telefone Vodacom e devolver ao servidor o resultado confirmado.

## Done looks like
- Existe documentação OpenAPI pública, em JSON, para o novo assistente do AI Studio consumir.
- O contrato documenta emparelhamento, autenticação do dispositivo, reserva de pedidos, consulta da fila, reporte de sucesso/falha e repetição controlada.
- O APK nunca recebe chaves Pagar, SESSION_SECRET ou credenciais administrativas.
- Um pagamento confirmado aparece no APK com beneficiário, pacote e sequência USSD.
- Uma confirmação bem-sucedida do APK actualiza o pedido original no painel e impede duplicação.
- A documentação deixa claro que o endereço da VPS é usado em produção e que o preview da Replit não serve como endpoint externo.

## Out of scope
- Criar ou publicar o APK externo no AI Studio.
- Descobrir a sequência de menu da Vodacom sem validação num telefone real.
- Substituir o Pagar ou criar uma integração externa adicional.
- Expor endpoints administrativos ao APK.

## Steps
1. **Contrato público** -- Criar uma especificação OpenAPI acessível por HTTPS, com exemplos de pedidos e respostas, estados da entrega, cabeçalhos obrigatórios e erros esperados.
2. **Fluxo de entrega** -- Confirmar que o pagamento confirmado cria uma entrega idempotente e que o APK pode reservar exclusivamente um pedido antes de executar o USSD.
3. **Confirmação e recuperação** -- Documentar e reforçar o reporte de sucesso, falha, expiração da reserva e nova tentativa sem duplicar o envio.
4. **Integração do APK** -- Definir o contrato do módulo Android USSD: recebe uma sequência, devolve completed/failed/manual_intervention e uma referência de confirmação quando existir.
5. **Teste externo** -- Validar o ciclo completo com o APK: emparelhar, reservar, executar um pacote de baixo valor, confirmar e verificar o estado no painel.

## Relevant files
- `artifacts/api-server/src/routes/ussd-agent.ts`
- `artifacts/api-server/src/services/delivery-queue.ts`
- `artifacts/api-server/legacy/zumbopay-bridge.js:314-380`
- `artifacts/net-servicos-ussd-agent/context/agent-context.tsx`
- `artifacts/net-servicos-ussd-agent/services/ussd.ts`
- `artifacts/net-servicos-ussd-agent/app/(tabs)/index.tsx:50-204`
- `deploy/nginx.conf:34-45`