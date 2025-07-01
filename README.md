# 🎙️ API de Transcrição com Faster Whisper

Uma API de transcrição de áudio assíncrona, poderosa e fácil de usar, construída com Node.js e o motor de transcrição de alta performance [Faster Whisper](https://github.com/guillaumekln/faster-whisper).

> **Nota:** Este projeto foi desenvolvido com a ajuda do **Gemini**, um modelo de linguagem da Google.

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
3.  **Executável do faster-whisper**: É necessário baixar o executável compatível com o seu sistema operacional. Recomenda-se usar um modelo grande como o `XXL` para melhores resultados. Recomendo os binários pré-compilados já com todas as bibliotecas necessárias:
    -   **[Baixe aqui a versão mais recente](https://github.com/Purfview/whisper-standalone-win/releases/tag/Faster-Whisper-XXL)**
    -   **[Repositório oficial](https://github.com/SYSTRAN/faster-whisper)**

---

## 🚀 Como Rodar

Siga os passos abaixo para colocar a API em funcionamento.

### 1. Clone o Repositório

```bash
git clone https://github.com/moothz/faster-whisper-api.git
cd faster-whisper-api
```

### 2. Instale as Dependências

Navegue até a pasta do projeto e instale os pacotes Node.js necessários.

```bash
npm install
```

### 3. Configure as variáveis

Abra o arquivo `server.js` e altere a constante `FASTER_WHISPER_EXECUTABLE` para o caminho **absoluto** onde você salvou o executável do `go-faster-whisper`.
Também é possível alterar a `CONVERSION_TIME_RATE`, que gera uma estimativa de tempo para a conversão do áudio - você deve testar a capacidade do seu servidor.

```javascript
// Exemplo de configuração no server.js
const FASTER_WHISPER_EXECUTABLE = 'C:/Apps/faster-whisper-xxl.exe';
```

### 4. Rode o Servidor

Com tudo configurado, inicie a API.

```bash
node server.js
```

O console deverá exibir a mensagem:
`🎙️ Servidor da API de Transcrição rodando na porta 3378`

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

A API responde imediatamente com um ID da tarefa, a duração do áudio e o tempo previsto para a execução, confirmando que o processo foi recebido.

```json
{
  "executionId": "a1b2c3d4-e5f6-7890-1234-567890abcdef",
  "audioDuration": "182.56",
  "estimatedTranscriptionTime": "37.512"
}
```

### 2. `GET /status/:executionId`

Verifica o status de uma tarefa de transcrição existente.

**Exemplo de Requisição:**

`GET http://localhost:3378/status/a1b2c3d4-e5f6-7890-1234-567890abcdef`

**Respostas Possíveis:**

- **Status `running`:**

  ```json
  {
    "status": "running",
    "startTime": 1678886400000
  }
  ```

- **Status `complete`:**

  ```json
  {
    "status": "complete",
    "fileSize": 123456, // em bytes
    "duration": 15.67, // em segundos
    "text": "Olá, este é um teste de transcrição de áudio."
  }
  ```

- **Status `error`:**

  ```json
  {
    "status": "error",
    "message": "Erro no FFmpeg: ..."
  }
  ```

---

## 👨‍💻 Exemplo de Uso (Client)

O projeto inclui um script (`example.js`) que demonstra como interagir com a API.

**Como usar:**

Passe o caminho de um arquivo de áudio local como argumento na linha de comando.

```bash
node example.js boanoite.mp3
```

O script irá:
1.  Converter o áudio para base64.
2.  Enviar para o endpoint `/transcribe`.
3.  Verificar o status a cada 10 segundos até a conclusão.
4.  Imprimir o resultado final no console.
