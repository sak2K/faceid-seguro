# FaceID Seguro — Reconhecimento Facial com Consentimento

Sistema web de reconhecimento facial **100% local**, com interface moderna e responsiva.
Acessa a câmera do dispositivo, detecta rostos em tempo real e identifica pessoas **previamente cadastradas com autorização**, exibindo nome e foto.
Todos os dados (nomes, fotos e biometria) ficam **criptografados no próprio navegador** — nada é enviado para servidores.

## Funcionalidades

| Recurso | Detalhes |
|---|---|
| Câmera ao vivo | Acesso via `getUserMedia`, seleção de câmera, indicador de câmera ativa, desligamento automático ao trocar de aba ou bloquear |
| Detecção em tempo real | TinyFaceDetector (rápido) ou SSD MobileNet (preciso), com caixas verde (identificado) / vermelha (desconhecido) |
| Identificação | Comparação facial por descritores de 128 dimensões (distância euclidiana), com nível de confiança e rigor configurável |
| Cadastro | Por câmera ou upload de fotos (JPG/PNG/WEBP, até 10 MB), 1–10 amostras, validação de rosto único/nitidez/tamanho, verificação de amostras de pessoas diferentes e alerta de cadastro duplicado |
| Consentimento | Termo obrigatório, registro de quem coletou a autorização, data/hora e versão do termo |
| Gestão de pessoas | Lista com foto, busca e exclusão definitiva (direito ao esquecimento) |
| Armazenamento seguro | IndexedDB + AES-256-GCM, chave derivada da senha mestra com PBKDF2-SHA-256 (600.000 iterações) |
| Privacidade | Bloqueio manual e automático por inatividade, troca de senha (recriptografa tudo), backup criptografado, apagar todos os dados |
| Mensagens e erros | Barra de status, notificações e mensagens claras para câmera negada/ocupada/inexistente, modelos ausentes, senha incorreta, armazenamento cheio etc. |

## Tecnologias

- HTML5, CSS3 e JavaScript (módulos ES) — sem etapa de build
- [@vladmandic/face-api](https://github.com/vladmandic/face-api) 1.7.15 (TensorFlow.js) — **já incluída** em `vendor/`, com os modelos em `models/` (funciona offline)
- Web Crypto API + IndexedDB
- Servidor local em Node.js **sem dependências** (`server.js`) com cabeçalhos de segurança

## Requisitos

- Windows 11 (também funciona em Windows 10, macOS e Linux)
- [Node.js LTS](https://nodejs.org/) 20 ou superior
- Microsoft Edge, Google Chrome ou Firefox atualizados
- Uma webcam
- [Visual Studio Code](https://code.visualstudio.com/) (opcional, recomendado)

## Instalação e execução no Windows 11

### 1. Instale o Node.js
Baixe a versão **LTS** em <https://nodejs.org/> ou, no PowerShell/Terminal:

```powershell
winget install OpenJS.NodeJS.LTS
```

Feche e abra o terminal e confira com `node -v`.

### 2. Obtenha o projeto
Extraia o `.zip` ou clone o repositório:

```powershell
git clone https://github.com/SEU-USUARIO/faceid-seguro.git
cd faceid-seguro
```

> Não há `npm install`: o projeto não tem dependências externas.

### 3. Execute (escolha uma opção)

**A) Pelo VS Code (recomendado)**
1. `Arquivo > Abrir Pasta...` e selecione a pasta do projeto.
2. Abra o terminal integrado (`` Ctrl+` ``) e rode:
   ```powershell
   npm start
   ```
   O navegador abre em <http://localhost:3000>.
3. Alternativa: pressione **F5** e escolha "Abrir no Microsoft Edge" (inicia o servidor e abre o navegador automaticamente).
4. Alternativa: instale a extensão recomendada **Live Server**, clique com o botão direito em `index.html` > **Open with Live Server**.

**B) Clique duplo**
Dê dois cliques em `iniciar.bat`.

**C) Terminal**
```powershell
node server.js --open
# opções: --port 8080  --host 127.0.0.1
```

> ⚠️ **Não abra o `index.html` com duplo clique** (endereço `file://`). Os navegadores bloqueiam câmera e módulos nesse modo. Use sempre `http://localhost`.

### 4. Primeiro uso
1. Crie a **senha mestra** do cofre (mín. 8 caracteres). Guarde-a: sem ela os dados não podem ser recuperados.
2. Aba **Cadastrar**: ligue a câmera e capture 3–5 amostras (ou envie fotos), preencha o nome, marque o consentimento e salve.
3. Aba **Reconhecer**: clique em **Iniciar reconhecimento**.
4. Quando o navegador perguntar, **permita o acesso à câmera**.

### Problemas comuns

| Problema | Solução |
|---|---|
| "Permissão de câmera negada" | Clique no ícone de cadeado/câmera na barra de endereço e permita. No Windows: **Configurações > Privacidade e segurança > Câmera** e ative "Permitir que aplicativos da área de trabalho acessem a câmera". |
| "Câmera em uso por outro aplicativo" | Feche Teams, Zoom, Skype, OBS ou o app Câmera. |
| `npm` não é reconhecido | Reinstale o Node.js LTS e reabra o VS Code/terminal. |
| `npm start` bloqueado por política de execução no PowerShell | Rode `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned` ou use o Prompt de Comando / `iniciar.bat`. |
| Porta 3000 ocupada | O servidor tenta automaticamente 3001, 3002… ou use `node server.js --port 8080`. |
| Reconhecimento lento | Use o modo "Rápido" nas configurações e ative a aceleração de hardware no navegador. |
| Muitos falsos positivos / negativos | Ajuste o "Rigor da comparação" (menor = mais rigoroso) e cadastre mais amostras com boa iluminação. |

## Segurança e privacidade

- **Processamento local**: modelos e análise rodam no navegador. A política CSP (`connect-src 'self'`) impede o envio de dados para outros domínios.
- **Criptografia**: cada cadastro é cifrado com AES-256-GCM (IV aleatório por registro, ID do registro como dado autenticado). A chave é derivada da senha com PBKDF2-SHA-256 e 600.000 iterações, é não extraível e só existe na memória enquanto o cofre está aberto.
- **A senha nunca é armazenada** — apenas um verificador cifrado.
- **Proteção contra força bruta**: espera progressiva após 5 senhas incorretas, além do custo do PBKDF2.
- **Bloqueio automático** por inatividade (configurável) e bloqueio manual; ao bloquear, a câmera é desligada e os dados são removidos da memória e da tela.
- **Servidor local** escuta apenas em `127.0.0.1`, serve somente as pastas do app e envia `Content-Security-Policy`, `Permissions-Policy`, `X-Frame-Options`, `X-Content-Type-Options`, `Referrer-Policy` etc.
- **Proteção contra XSS**: dados do usuário são inseridos apenas via `textContent`.
- **Backups** exportados permanecem cifrados e exigem a senha mestra. O `.gitignore` impede que sejam enviados ao GitHub.
- Ver também [SECURITY.md](SECURITY.md).

### Consentimento e LGPD
Dados biométricos são **dados pessoais sensíveis** (LGPD, art. 5º, II e art. 11). Antes de cadastrar alguém:
- obtenha consentimento **livre, informado, específico e destacado** (para menores, do responsável legal);
- informe a finalidade e por quanto tempo os dados serão mantidos;
- exclua os dados quando solicitado (aba **Pessoas > Excluir dados**) ou quando a finalidade terminar;
- não use o sistema para vigilância ou identificação de pessoas que não autorizaram.

> Os dados ficam no navegador/perfil onde foram cadastrados. Limpar os dados de navegação do site apaga os cadastros — mantenha um backup criptografado se necessário.

## Estrutura do projeto

```
faceid-seguro/
├── index.html            # Interface
├── css/styles.css        # Estilos (tema escuro/claro, responsivo)
├── js/
│   ├── app.js            # Lógica da interface, cadastro e reconhecimento
│   ├── face-engine.js    # Integração com face-api (detecção, descritores, comparação)
│   ├── crypto-store.js   # Cofre: IndexedDB + AES-GCM + PBKDF2, backup
│   └── camera.js         # Câmera e mensagens de erro
├── models/               # Modelos de IA (carregados localmente)
├── vendor/face-api/      # Biblioteca face-api (licença MIT)
├── assets/               # Ícone
├── server.js             # Servidor local seguro, sem dependências
├── iniciar.bat           # Atalho para Windows
├── .vscode/              # Tarefa, depuração (F5) e extensão recomendada
└── package.json
```

## Publicação no GitHub

### 1. Criar o repositório
1. Acesse <https://github.com/new>, dê um nome (ex.: `faceid-seguro`) e **não** marque "Add a README".
2. Instale o [Git para Windows](https://git-scm.com/download/win) (`winget install Git.Git`) e configure:
   ```powershell
   git config --global user.name "Seu Nome"
   git config --global user.email "seu-email@exemplo.com"
   ```

### 2. Enviar o código
Na pasta do projeto (terminal do VS Code):

```powershell
git init
git add .
git commit -m "Primeira versão do FaceID Seguro"
git branch -M main
git remote add origin https://github.com/SEU-USUARIO/faceid-seguro.git
git push -u origin main
```

Pelo VS Code também é possível: aba **Controle do Código-Fonte** (`Ctrl+Shift+G`) > **Publicar no GitHub**.

> Nunca envie backups (`faceid-backup-*.json`), fotos de pessoas ou senhas para o repositório.

### 3. Publicar online com GitHub Pages (opcional)
O site é estático e o GitHub Pages usa HTTPS, então a câmera funciona:
1. No repositório: **Settings > Pages**.
2. Em **Source**, escolha **Deploy from a branch**, branch `main`, pasta `/ (root)` e salve.
3. Após 1–2 minutos o site estará em `https://SEU-USUARIO.github.io/faceid-seguro/`.

Mesmo publicado, o processamento e os dados continuam **apenas no navegador de cada usuário** (o GitHub não recebe imagens nem cadastros). A política CSP do `index.html` continua ativa; os cabeçalhos extras do `server.js` valem somente na execução local.

## Limitações

- Reconhecimento facial pode errar (iluminação, ângulo, óculos, gêmeos etc.). **Não use como único fator de autenticação** ou para decisões críticas.
- O sistema não possui detecção de vivacidade (anti-spoofing): uma foto da pessoa pode ser reconhecida.
- Os dados ficam em um único navegador; não há sincronização entre dispositivos (use o backup criptografado).

## Licença

MIT — veja [LICENSE](LICENSE). A biblioteca face-api é distribuída sob licença MIT (ver `vendor/face-api/LICENSE`).
