# 🎙️ API de Transcrição com Faster Whisper

Uma API de transcrição de áudio assíncrona, poderosa e fácil de usar, construída com Node.js e o motor de transcrição de alta performance [Faster Whisper](https://github.com/guillaumekln/faster-whisper).

Esta é uma solução leve e eficiente projetada para ser utilizada em bots de **Telegram** e **WhatsApp**. Ela é o motor de transcrição primário utilizado no projeto [Ravena AI](https://github.com/moothz/ravena-ai).

---

## ✨ Recursos

- **Operação Assíncrona**: Envie um áudio e receba um ID de tarefa. Consulte o status quando quiser, sem bloquear sua aplicação.
- **Entrada Flexível**: Aceita áudio via upload de arquivo (`base64`) ou por `URL`.
- **Processamento Automático**: Converte automaticamente o áudio de entrada para o formato ideal (WAV, 16kHz, mono) usando FFmpeg.
- **Status Detalhado**: Acompanhe o progresso da transcrição com os status `running`, `complete` ou `error`.
- **Resposta Completa**: Ao concluir, a API retorna o texto transcrito, a duração do áudio e o tamanho do arquivo original.

---

## ⚙️ Pré-requisitos

Antes de começar, você precisará ter os seguintes softwares instalados em sua máquina:

1.  **[node.js](https://nodejs.org/en/)**: Versão 14 ou superior.
2.  **[FFmpeg](https://ffmpeg.org/download.html)**: Essencial para o processamento de áudio. Certifique-se de que o `ffmpeg` esteja disponível no PATH do seu sistema.
3.  **Binários do Faster-Whisper-XXL**: Esta API requer os binários compilados do Faster Whisper. 
    - **[Baixe aqui a versão mais recente dos binários compilados](https://github.com/Purfview/whisper-standalone-win/releases/tag/Faster-Whisper-XXL)**.
    - Após baixar, extraia os arquivos em uma pasta de sua preferência e anote o caminho do executável `faster-whisper-xxl` para configurar no seu `.env`.

---

## 🚀 Como Rodar

Siga os passos abaixo para colocar a API em funcionamento.

### 1. Clone o Repositório

```bash
git clone https://github.com/moothz/faster-whisper-api.git
cd faster-whisper-api
```

### 2. Instale as Dependências

```bash
npm install
```

### 3. Configure as Variáveis de Ambiente

Crie um arquivo `.env` na raiz do projeto copiando o modelo do `.env.example`:

```bash
cp .env.example .env
```

Abra o arquivo `.env` e ajuste as variáveis de acordo com o seu ambiente, **especialmente o caminho dos binários baixados**:

```env
PORT=3378
# Caminho ABSOLUTO para o executável do faster-whisper-xxl
WHISPER_EXECUTABLE="/caminho/absoluto/para/binarios/faster-whisper-xxl"
WHISPER_MODEL="large-v3-turbo"
WHISPER_COMPUTE_TYPE="float16" # use 'int8' se estiver no CPU
WHISPER_LANGUAGE="pt"
CONVERSION_TIME_RATE=5
```

### 4. Rode o Servidor

#### Modo Desenvolvimento (Direto):
```bash
npm start
```

#### Modo Produção (PM2):
Para manter a API rodando em segundo plano e reiniciando automaticamente após quedas:

```bash
# Instale o PM2 globalmente se não tiver
npm install pm2 -g

# Inicie a API com um nome amigável
pm2 start server.js --name faster-whisper-api

# Salve a lista de processos para reiniciar com o sistema
pm2 save
```

O console deverá exibir a mensagem:
`🎙️ Servidor da API de Transcrição rodando na porta 3378`

---

## 📖 Documentação Interativa (Swagger)

A API conta com uma interface Swagger para facilitar o teste dos endpoints. Com o servidor rodando, acesse:

`http://localhost:3378/api-docs`

---

## ⚙️ Configuração (.env)

| Variável | Descrição | Padrão |
| :--- | :--- | :--- |
| `PORT` | Porta em que o servidor Express irá rodar. | `3378` |
| `WHISPER_EXECUTABLE` | Caminho absoluto para o executável do Faster Whisper. | (Obrigatório) |
| `WHISPER_MODEL` | Modelo do Whisper a ser utilizado (`tiny`, `base`, `small`, `medium`, `large-v3-turbo`, etc). | `large-v3-turbo` |
| `WHISPER_COMPUTE_TYPE` | Tipo de computação (`float16` para GPU, `int8` para CPU). | `float16` |
| `WHISPER_RUN_ON` | Flags adicionais (ex: `--device cpu` para forçar uso de processador). | `""` |
| `WHISPER_LANGUAGE` | Idioma padrão da transcrição. | `pt` |
| `CONVERSION_TIME_RATE` | Fator para estimar o tempo de transcrição (segundos de áudio por segundo real). | `5` |

---

## 📡 Endpoints da API

### 1. `POST /transcribe`

Inicia um novo processo de transcrição. O corpo da requisição deve ser um JSON.

**Corpo da Requisição (Opção 1: Base64):**

```json
{
  "audioData": "<string codificada em base64>"
}
```

**Corpo da Requisição (Opção 2: URL):**

```json
{
  "audioUrl": "https://exemplo.com/meu-audio.mp3"
}
```

**Resposta de Sucesso (202 Accepted):**

```json
{
  "executionId": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
  "audioDuration": 182,
  "estimatedTranscriptionTime": 37
}
```

### 2. `GET /status/:executionId`

Verifica o status de uma tarefa de transcrição existente.

`GET http://localhost:3378/status/a1b2c3d4-e5f6-7890-1234-567890abcdef`

---

## 👨‍💻 Exemplo de Uso (Client)

O projeto inclui um script (`example.js`) que demonstra como interagir com a API.

```bash
node example.js boanoite.mp3
```

---

## 🤝 Contribuição

Contribuições são bem-vindas! Sinta-se à vontade para abrir uma **Issue** ou enviar um **Pull Request**.

---

## 📄 Licença

Este projeto está licenciado sob a Licença MIT - veja o arquivo [LICENSE](LICENSE) para mais detalhes.

---

> **Desenvolvido com ❤️ por moothz (com uma mãozinha do Gemini).**
