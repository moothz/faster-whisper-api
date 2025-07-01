// Importação dos módulos necessários
const express = require('express');
const logger = require('./logger');
const { exec } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const fluent_ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');

// Configuração do aplicativo Express
const app = express();
app.use(express.json({ limit: '50mb' })); // Aumenta o limite de tamanho do corpo da requisição para aceitar áudios em base64

// Middleware para logar todas as requisições
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.originalUrl}`);
    next();
});

const runOn = ""; // Mude para "--device cpu" caso a GPU não suporte

// --- CONFIGURAÇÕES ---
// Caminho para o executável do Faster Whisper XXL
const FASTER_WHISPER_EXECUTABLE = '"C:/Apps/Faster-Whisper-XXL/faster-whisper-xxl.exe"'; // Substitua pelo caminho correto
const PORT = 3378;
const CONVERSION_TIME_RATE = 5; // 5 segundos de áudio = 1 segundo de transcrição. Edite para o do seu servidor (pode ser menor que 1 e maior que 0)

// Armazenamento em memória para os status das transcrições
const tasks = {};

// Diretório para armazenar arquivos temporários
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

/**
 * Função para processar o áudio (converter para WAV)
 * @param {string} inputPath - Caminho do arquivo de áudio de entrada (ou URL)
 * @param {string} outputPath - Caminho para salvar o arquivo WAV convertido
 * @returns {Promise<void>}
 */
function processAudio(inputPath, outputPath) {
    return new Promise((resolve, reject) => {
        fluent_ffmpeg(inputPath)
            .toFormat('wav')
            .audioFrequency(16000)
            .audioChannels(1)
            .audioCodec('pcm_s16le')
            .on('error', (err) => reject(new Error(`Erro no FFmpeg: ${err.message}`)))
            .on('end', () => resolve())
            .save(outputPath);
    });
}

/**
 * Função para executar a transcrição com o Faster Whisper
 * @param {string} audioPath - Caminho do arquivo de áudio WAV
 * @returns {Promise<string>} - O texto transcrito
 */
function runWhisper(audioPath) {
    return new Promise((resolve, reject) => {
        const command = `${FASTER_WHISPER_EXECUTABLE} "${audioPath}" ${runOn} --language pt --compute_type float16 --output_dir "${TEMP_DIR}" --output_format txt`;
        const whisperOutputPath = audioPath.replace(/\.[^/.]+$/, '') + '.txt';

        console.log(command);
        console.log(whisperOutputPath);

        exec(command, (error, stdout, stderr) => {

            if (error) {
                logger.error(`Erro ao executar o Faster Whisper: ${stderr || error.message}`);
                return reject(new Error(`Erro ao executar o Faster Whisper: ${stderr || error.message}`));
            }

            let transcribedText = '';
            try {
                transcribedText = fs.readFileSync(whisperOutputPath, 'utf8');
                transcribedText = transcribedText.trim();

                resolve(cleanupString(transcribedText));
            } catch (e) {
                reject(new Error(`Erro ao processar a saída do Whisper: ${e.message}`));
            }
        });
    });
}

/**
 * Função para remover os timestamps do whisper
 * @param {string} text - '[00:00.000 --> 00:01.460]  blah blah blah'
 * @returns {string} - O texto limpo
 */
function cleanupString(text) {
  const lines = text.split('\n');

  const cleanedLines = lines.map(line => {
    const cleanedLine = line.replace(/^\s*\[.*?\]\s*/, '');
    return cleanedLine.trim();
  });
  
  return cleanedLines.filter(line => line.length > 2).join('\n');
}

// --- ENDPOINTS DA API ---

/**
 * POST /transcribe
 * Inicia o processo de transcrição de um arquivo de áudio.
 * Corpo da requisição (JSON):
 * {
 *   "audioData": "string" // Áudio em base64
 * }
 * ou
 * {
 *   "audioUrl": "string" // URL para um arquivo de áudio
 * }
 */
app.post('/transcribe', async (req, res) => {
    const executionId = uuidv4();
    const { audioData, audioUrl } = req.body;

    if (!audioData && !audioUrl) {
        return res.status(400).json({ error: 'É necessário fornecer "audioData" (base64) ou "audioUrl".' });
    }

    // Cria um status inicial para a tarefa
    tasks[executionId] = { status: 'running', startTime: Date.now() };

    // --- Inicia o processamento em segundo plano ---
    (async () => {
        const tempInputPath = path.join(TEMP_DIR, `${executionId}.tmp`);
        const tempWavPath = path.join(TEMP_DIR, `${executionId}.wav`);
        let originalFileSize = 0;
        let audioDuration = 0;

        try {
            // Passo 1: Obter o arquivo de áudio (de base64 ou URL)
            if (audioData) {
                const buffer = Buffer.from(audioData, 'base64');
                originalFileSize = buffer.length;
                fs.writeFileSync(tempInputPath, buffer);
            } else {
                const response = await axios.get(audioUrl, { responseType: 'arraybuffer' });
                originalFileSize = response.data.length;
                fs.writeFileSync(tempInputPath, response.data);
            }

            // Passo 2: Converter o áudio para o formato WAV correto
            await processAudio(tempInputPath, tempWavPath);

            // Passo 3: Obter a duração do áudio
            const metadata = await new Promise((resolve, reject) => {
                fluent_ffmpeg.ffprobe(tempWavPath, (err, data) => {
                    if (err) return reject(err);
                    resolve(data);
                });
            });
            audioDuration = Math.ceil(metadata.format.duration);

            // Calcula o tempo estimado de transcrição
            const estimatedTranscriptionTime = Math.ceil((audioDuration / CONVERSION_TIME_RATE) + 1); // Adiciona 1 segundo de buffer

            // Envia a resposta inicial com a duração e o tempo estimado
            const dados = { executionId, audioDuration, estimatedTranscriptionTime };
            logger.info(`[${executionId}] Transcrição inciada: ${JSON.stringify(dados)}`);

            res.status(202).json({ executionId, audioDuration, estimatedTranscriptionTime });

            // Passo 4: Executar a transcrição
            const transcribedText = await runWhisper(tempWavPath);

            // Passo 5: Armazenar o resultado final
            tasks[executionId] = {
                status: 'complete',
                fileSize: originalFileSize,
                duration: audioDuration,
                text: transcribedText,
            };

            logger.info(`[${executionId}] Transcrição concluída: ${JSON.stringify(tasks[executionId], null, '\t')}`);

        } catch (error) {
            tasks[executionId] = {
                status: 'error',
                message: error.message || 'Ocorreu um erro desconhecido.',
            };
            logger.error(`[${executionId}] Erro no processamento:`, error);
        } finally {
            // Passo 6: Limpar arquivos temporários
            if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
            if (fs.existsSync(tempWavPath)) fs.unlinkSync(tempWavPath);
        }
    })();
});

/**
 * GET /status/:executionId
 * Consulta o status de um processo de transcrição.
 */
app.get('/status/:executionId', (req, res) => {
    const { executionId } = req.params;
    const task = tasks[executionId];

    if (!task) {
        return res.status(404).json({ error: 'ID de execução não encontrado.' });
    }

    res.json(task);
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
app.listen(PORT, () => {
    logger.info(`🎙️  Servidor da API de Transcrição rodando na porta ${PORT}`);
    logger.info('Aguardando requisições...');
});
