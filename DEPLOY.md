# Deploy recomendado

## Arquitetura indicada

Para o Ponte, a combinação com menor manutenção é:

- **Render Web Service** para a PWA e o servidor de sinalização WebSocket.
- **Cloudflare Realtime TURN** para a rota de contingência quando os aparelhos estão em redes diferentes ou atrás de firewalls restritivos.
- Um domínio próprio apontando para o Render, embora o domínio `onrender.com` já funcione com HTTPS.

Essa separação mantém o servidor do Ponte pequeno: ele entrega a interface, aproxima os aparelhos e solicita credenciais TURN de curta duração. Os arquivos continuam criptografados pelo WebRTC e não são armazenados.

Referências oficiais:

- [WebSockets no Render](https://render.com/docs/websocket)
- [Docker no Render](https://render.com/docs/docker)
- [Gerar credenciais Cloudflare TURN](https://developers.cloudflare.com/realtime/turn/generate-credentials/)
- [Preços do Cloudflare Realtime TURN](https://developers.cloudflare.com/realtime/turn/faq/)

## 1. Criar o TURN gerenciado

1. Entre no painel da Cloudflare e abra **Realtime > TURN**.
2. Crie uma TURN Key.
3. Crie um API Token limitado a essa chave/serviço.
4. Guarde o **TURN Key ID** e o token; nunca coloque esses valores no Git.

O servidor usa esses segredos para chamar o endpoint de credenciais da Cloudflare. O navegador recebe somente usuário e senha temporários, com duração padrão de uma hora.

## 2. Publicar no Render

1. No Render, escolha **New > Blueprint**.
2. Conecte o repositório `Ponte` no GitHub.
3. O arquivo [`render.yaml`](./render.yaml) criará o Web Service a partir do Dockerfile.
4. Preencha as variáveis secretas `CLOUDFLARE_TURN_KEY_ID` e `CLOUDFLARE_TURN_API_TOKEN`.
5. Depois do primeiro deploy, acesse `/api/health`; a resposta deve ser `{"status":"ok"}`.
6. Abra `/api/config` e confirme que `turnConfigured` é `true`. Não deve aparecer nenhum token de longa duração.

Para uso pessoal, um plano que possa suspender por inatividade é aceitável, mas a primeira conexão pode demorar. Para disponibilidade imediata e WebSockets mais previsíveis, use uma instância sempre ativa.

Mantenha uma única instância do serviço nesta versão: as salas de pareamento ficam em memória. Escala horizontal futura exigirá mover a sinalização efêmera para Redis ou outro barramento compartilhado.

## 3. Domínio e instalação

1. Adicione um domínio personalizado no Render e configure o DNS indicado pela plataforma.
2. Defina `PUBLIC_URL=https://ponte.seudominio.com` no serviço.
3. Abra essa URL no computador e no celular.
4. No Chrome/Edge, use **Instalar aplicativo**. No Safari do iPhone/iPad, use **Compartilhar > Adicionar à Tela de Início**.

HTTPS é obrigatório para instalação da PWA e acesso confiável à câmera.

## Alternativa totalmente autogerenciada

O Ponte também suporta coturn com `TURN_URLS` e `TURN_SHARED_SECRET`. Essa opção exige uma VM com IPv4 público, portas UDP/TCP, atualização do servidor e monitoramento de tráfego. O coturn deve usar o mesmo `static-auth-secret` configurado em `TURN_SHARED_SECRET`.

Para uma instalação pessoal pequena, o TURN gerenciado é preferível porque evita manter portas UDP e um servidor de relay. A alternativa autogerenciada faz sentido quando controle de infraestrutura, residência de dados ou custo em grande volume forem prioridades.
