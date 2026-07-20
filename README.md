# Ponte

Ponte é uma PWA instalável para enviar textos, fotos e documentos diretamente entre computador e celular. O servidor apenas apresenta os dois aparelhos; o conteúdo trafega por um canal WebRTC ponto a ponto.

## O que já funciona

- Pareamento com código temporário de 6 dígitos.
- Pareamento por QR Code: use o leitor dentro do Ponte ou a câmera normal do celular para abrir o link.
- Transferência de vários arquivos em sequência, com progresso e controle de buffer.
- Envio de texto e cópia com um toque.
- Criptografia de transporte WebRTC (DTLS) e código visual de segurança igual nos dois aparelhos.
- SHA-256 incremental no emissor e no receptor. Um arquivo alterado ou incompleto é descartado.
- STUN público e suporte a Cloudflare Realtime TURN ou coturn, com credenciais temporárias geradas pelo servidor.
- Instalação como aplicativo no Android, iPhone/iPad, Windows, macOS e Linux por um navegador compatível com PWA.
- Interface responsiva, cache do aplicativo e servidor sem banco de dados.

## Executar localmente

Requer Node.js 20 ou superior.

```bash
npm install
npm start
```

Abra `http://localhost:4173` no computador. Para um teste rápido entre duas abas do mesmo computador, crie a conexão em uma e use o código na outra.

### Usar no celular

Para instalar uma PWA e usar todos os recursos criptográficos do navegador, publique o serviço com **HTTPS**. Acesse o mesmo endereço HTTPS no celular e no computador; depois use “Instalar aplicativo” no Chrome/Edge ou “Adicionar à Tela de Início” no Safari.

Servir `http://192.168.x.x:4173` pode ajudar a testar na rede local, mas navegadores móveis não tratam esse endereço como contexto seguro e normalmente não oferecem instalação. Em produção, coloque o contêiner atrás de Caddy, Nginx, Traefik ou de uma plataforma que forneça TLS.

```bash
docker build -t ponte .
docker run --rm -p 4173:4173 ponte
```

## Mesma rede e redes diferentes

Sem configuração adicional, o Ponte usa STUN e consegue atravessar muitos roteadores. Para funcionar de modo confiável entre 4G/5G, redes corporativas ou roteadores distintos, configure TURN. A opção recomendada é Cloudflare Realtime TURN:

```powershell
$env:CLOUDFLARE_TURN_KEY_ID='id-da-chave'
$env:CLOUDFLARE_TURN_API_TOKEN='token-secreto'
npm.cmd start
```

O token fica somente no backend. Cada acesso a `/api/config` recebe credenciais TURN curtas, nunca a chave de longa duração. Também há suporte a coturn próprio por `TURN_URLS` e `TURN_SHARED_SECRET`. O arquivo [`.env.example`](./.env.example) mostra os formatos.

A estratégia de produção e o passo a passo estão em [`DEPLOY.md`](./DEPLOY.md).

## Modelo de segurança

1. Os aparelhos entram em uma sala temporária, limitada a dois participantes e expirada após 15 minutos. O QR Code contém apenas a URL e esse código temporário.
2. O servidor encaminha apenas as mensagens necessárias para estabelecer o WebRTC. Não recebe o arquivo ou o texto.
3. O WebRTC cifra o canal com DTLS. Para conteúdo sensível, compare o **código de segurança** exibido nos dois aparelhos; códigos diferentes indicam que o pareamento não deve ser usado.
4. Cada arquivo é lido e enviado em blocos de 64 KiB. O SHA-256 é calculado incrementalmente nos dois lados.
5. O receptor só cria o link “Salvar arquivo verificado” quando tamanho e SHA-256 correspondem ao original. Caso contrário, os bytes são descartados.
6. A leitura do QR acontece localmente; os quadros da câmera não são enviados ao servidor.

O servidor ainda aplica limite de tamanho das mensagens, limite de tentativas por IP, validação de origem do WebSocket, cabeçalhos CSP e não mantém banco de dados. Em uma instalação pública, use TLS, atualize dependências, proteja o TURN e monitore abuso.

## Integridade e metadados

O conteúdo binário do arquivo é preservado exatamente; nome e tipo MIME também são transportados. O sistema operacional atribui uma nova data de criação/download ao arquivo salvo. Essa data externa não faz parte dos bytes e não pode ser preservada por uma PWA por restrições de segurança do navegador. Para arquivos que guardam metadados internamente (EXIF de fotos, propriedades de PDF, ZIP etc.), esses metadados permanecem intactos porque os bytes não são reprocessados.

O protótipo limita cada arquivo a 512 MB e mantém o arquivo recebido em memória até a verificação terminar. Para arquivos de vários gigabytes, a evolução recomendada é um aplicativo nativo (Tauri/Capacitor) ou gravação por streaming com a File System Access API onde ela estiver disponível.

## Limites honestos do MVP

- Não há contas, histórico na nuvem ou recuperação depois que a sessão termina.
- O código de 6 dígitos é uma conveniência de descoberta, não uma senha forte; o código de segurança visual é a proteção contra pareamento indevido.
- Sem TURN configurado, alguns pares de redes não conseguem estabelecer uma rota direta; `/api/config` informa `turnConfigured: false` nesse caso.
- iOS e alguns navegadores podem suspender a transferência se o aplicativo for colocado em segundo plano.
- O receptor ainda precisa tocar em “Salvar arquivo verificado” para gravá-lo na pasta escolhida pelo sistema.

## Verificação

```bash
npm run check
```

Esse comando valida a sintaxe do servidor, do aplicativo e do service worker. O aplicativo também executa um vetor de teste conhecido de SHA-256 ao iniciar.
