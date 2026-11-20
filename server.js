// Importação dos módulos necessários
require('dotenv').config();
const express = require('express');
const logger = require('./logger');
const selfHeal = require('./selfHeal');
const { exec, execFile } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const path = require('path');
const fluent_ffmpeg = require('fluent-ffmpeg');
const axios = require('axios');
const multer = require('multer');
const swaggerUi = require('swagger-ui-express');
const swaggerJsdoc = require('swagger-jsdoc');

// Configuração do Swagger
const swaggerOptions = {
    definition: {
        openapi: '3.0.0',
        info: {
            title: 'Faster Whisper API',
            version: '1.0.0',
            description: 'API de transcrição de áudio assíncrona utilizando Faster Whisper XXL',
        },
        servers: [
            {
                url: `http://localhost:${process.env.PORT || 3378}`,
                description: 'Servidor Local',
            },
        ],
    },
    apis: ['./server.js'], // Caminho para os arquivos com anotações
};

const swaggerDocs = swaggerJsdoc(swaggerOptions);

// Configuração do aplicativo Express
const app = express();
app.use(express.json({ limit: '50mb' })); // Aumenta o limite de tamanho do corpo da requisição para aceitar áudios em base64
app.use(express.urlencoded({ extended: true, limit: '50mb' }));

// Rota para documentação Swagger
app.use('/api-docs', swaggerUi.serve, swaggerUi.setup(swaggerDocs));

// Middleware para logar todas as requisições
app.use((req, res, next) => {
    logger.info(`${req.method} ${req.originalUrl}`);
    next();
});

// --- CONFIGURAÇÕES ---
const PORT = process.env.PORT || 3378;
const CONVERSION_TIME_RATE = Number(process.env.CONVERSION_TIME_RATE) || 5;

// Configurações do Faster Whisper
const WHISPER_EXECUTABLE = process.env.WHISPER_EXECUTABLE;
const WHISPER_MODEL = process.env.WHISPER_MODEL || "large-v3-turbo";
const WHISPER_COMPUTE_TYPE = process.env.WHISPER_COMPUTE_TYPE || "float16";
const WHISPER_RUN_ON = process.env.WHISPER_RUN_ON || "";
const WHISPER_LANGUAGE = process.env.WHISPER_LANGUAGE || "pt";
const API_KEY = process.env.API_KEY || "";

// Armazenamento em memória para os status das transcrições
const tasks = {};

// Diretório para armazenar arquivos temporários
const TEMP_DIR = path.join(__dirname, 'temp');
if (!fs.existsSync(TEMP_DIR)) {
    fs.mkdirSync(TEMP_DIR);
}

// Configuração do Multer para uploads multipart (OpenAI /v1/audio/transcriptions)
const uploadStorage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, TEMP_DIR),
    filename: (req, file, cb) => {
        const ext = path.extname(file.originalname || '').replace(/[^a-zA-Z0-9.]/g, '').slice(0, 10) || '.audio';
        cb(null, `openai-${uuidv4()}${ext}`);
    },
});
const uploadAudio = multer({
    storage: uploadStorage,
    limits: { fileSize: 100 * 1024 * 1024 }, // 100 MB
});

function verifyOptionalAuth(req, res, next) {
    if (!API_KEY) {
        return next();
    }
    const authHeader = req.headers.authorization || '';
    const xApiKey = req.headers['x-api-key'] || '';
    let token = '';
    if (authHeader.startsWith('Bearer ')) {
        token = authHeader.slice(7).trim();
    } else if (xApiKey) {
        token = String(xApiKey).trim();
    }
    if (!token) {
        return res.status(401).json({ error: { message: 'Missing Authorization Bearer token.', type: 'invalid_request_error' } });
    }
    if (token !== API_KEY) {
        return res.status(403).json({ error: { message: 'Invalid API key.', type: 'invalid_request_error' } });
    }
    return next();
}

// Rotina periódica de limpeza automática da pasta temp (a cada 10 minutos, remove arquivos com mais de 5 minutos)
const TEMP_CLEANUP_INTERVAL_MS = 10 * 60 * 1000;
const TEMP_MAX_AGE_MS = 5 * 60 * 1000;

setInterval(() => {
    try {
        const now = Date.now();
        const files = fs.readdirSync(TEMP_DIR);
        let removed = 0;
        for (const file of files) {
            const filePath = path.join(TEMP_DIR, file);
            try {
                const stats = fs.statSync(filePath);
                if (stats.isFile() && (now - stats.mtimeMs > TEMP_MAX_AGE_MS)) {
                    fs.unlinkSync(filePath);
                    removed++;
                }
            } catch (err) {
                // Arquivo pode ter sido removido concorrentemente
            }
        }
        if (removed > 0) {
            logger.info(`[GarbageCollector] Limpeza automática da pasta temp: ${removed} arquivos removidos.`);
        }
    } catch (e) {
        logger.error(`[GarbageCollector] Erro ao varrer pasta temp: ${e.message}`);
    }
}, TEMP_CLEANUP_INTERVAL_MS);

// Rotina de expiração de tarefas em memória (a cada 15 minutos, remove tarefas com mais de 30 minutos)
const TASKS_CLEANUP_INTERVAL_MS = 15 * 60 * 1000;
const TASKS_MAX_AGE_MS = 30 * 60 * 1000;

setInterval(() => {
    try {
        const now = Date.now();
        let evicted = 0;
        for (const [id, task] of Object.entries(tasks)) {
            if (task.startTime && (now - task.startTime > TASKS_MAX_AGE_MS)) {
                delete tasks[id];
                evicted++;
            }
        }
        if (evicted > 0) {
            logger.info(`[GarbageCollector] Expiração de tarefas em memória: ${evicted} tarefas antigas removidas.`);
        }
    } catch (e) {
        logger.error(`[GarbageCollector] Erro na limpeza de tarefas: ${e.message}`);
    }
}, TASKS_CLEANUP_INTERVAL_MS);

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
 * Função para executar a transcrição com o Faster Whisper (com auto-reparo e retry)
 * @param {string} audioPath - Caminho do arquivo de áudio WAV
 * @param {boolean} isRetry - Indica se já é uma tentativa após auto-cura
 * @returns {Promise<string>} - O texto transcrito
 */
function runWhisper(audioPath, isRetry = false) {
    return new Promise((resolve, reject) => {
        // Monta o comando de execução de forma limpa
        const modelArg = `-m ${WHISPER_MODEL}`;
        const computeArg = `--compute_type ${WHISPER_COMPUTE_TYPE}`;
        const languageArg = `--language ${WHISPER_LANGUAGE}`;
        const outputArg = `--output_dir "${TEMP_DIR}" --output_format txt`;
        
        const command = `"${WHISPER_EXECUTABLE}" "${audioPath}" ${WHISPER_RUN_ON} ${modelArg} ${languageArg} ${computeArg} ${outputArg}`;
        const whisperOutputPath = audioPath.replace(/\.[^/.]+$/, '') + '.txt';

        logger.info(`Executando comando: ${command}`);

        exec(command, async (error, stdout, stderr) => {
            if (error) {
                const errMsg = stderr || error.message || '';
                logger.error(`Erro ao executar o Faster Whisper: ${errMsg}`);

                // Autocorreção: se o binário quebrar em tempo de execução, repara e tenta novamente 1 vez
                if (!isRetry) {
                    logger.warn(`[SelfHeal] Falha crítica no Whisper. Executando auto-reparo antes de falhar tarefa...`);
                    const healed = selfHeal.repairWhisperInstallation(WHISPER_EXECUTABLE, __dirname);
                    if (healed) {
                        logger.info(`[SelfHeal] Auto-reparo bem-sucedido. Reexecutando transcrição...`);
                        try {
                            const retryResult = await runWhisper(audioPath, true);
                            return resolve(retryResult);
                        } catch (retryErr) {
                            return reject(retryErr);
                        }
                    }
                }

                return reject(new Error(`Erro ao executar o Faster Whisper: ${errMsg}`));
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

function normalizeLanguageCode(lang) {
    if (!lang || typeof lang !== 'string') return null;
    const cleaned = lang.trim().toLowerCase();
    if (!cleaned || cleaned === 'auto') return null;
    // Normaliza formatos como pt-br / pt_BR -> pt (faster-whisper aceita ISO 639-1)
    const primary = cleaned.split(/[-_]/)[0];
    if (/^[a-z]{2,3}$/.test(primary)) {
        return primary;
    }
    return null;
}

/**
 * Executa o Faster Whisper para o endpoint compatível com OpenAI (usa execFile para segurança e suporta json/srt/vtt)
 * @param {string} audioPath - Caminho do arquivo WAV
 * @param {{ language?: string|null, whisperFormat?: string }} options
 * @param {boolean} isRetry
 * @returns {Promise<{ text: string, language: string|null, segments: Array, raw: string }>}
 */
function runWhisperOpenAI(audioPath, { language = null, whisperFormat = 'json' } = {}, isRetry = false) {
    return new Promise((resolve, reject) => {
        const runOnArgs = WHISPER_RUN_ON ? WHISPER_RUN_ON.trim().split(/\s+/).filter(Boolean) : [];
        const args = [
            audioPath,
            ...runOnArgs,
            '-m', WHISPER_MODEL,
            '--compute_type', WHISPER_COMPUTE_TYPE,
            '--output_dir', TEMP_DIR,
            '--output_format', whisperFormat,
        ];

        const normalizedLang = normalizeLanguageCode(language);
        if (normalizedLang) {
            args.push('--language', normalizedLang);
        }

        const whisperOutputPath = audioPath.replace(/\.[^/.]+$/, '') + `.${whisperFormat}`;
        logger.info(`[OpenAI STT] Executando: "${WHISPER_EXECUTABLE}" ${args.join(' ')}`);

        execFile(WHISPER_EXECUTABLE, args, { maxBuffer: 20 * 1024 * 1024 }, async (error, stdout, stderr) => {
            if (error) {
                const errMsg = stderr || error.message || '';
                logger.error(`[OpenAI STT] Erro ao executar Faster Whisper: ${errMsg}`);

                if (!isRetry) {
                    logger.warn(`[SelfHeal] Falha crítica no Whisper (OpenAI STT). Executando auto-reparo...`);
                    const healed = selfHeal.repairWhisperInstallation(WHISPER_EXECUTABLE, __dirname);
                    if (healed) {
                        logger.info(`[SelfHeal] Auto-reparo bem-sucedido. Reexecutando transcrição...`);
                        try {
                            const retryResult = await runWhisperOpenAI(audioPath, { language, whisperFormat }, true);
                            return resolve(retryResult);
                        } catch (retryErr) {
                            return reject(retryErr);
                        }
                    }
                }
                return reject(new Error(`Erro ao executar o Faster Whisper: ${errMsg}`));
            }

            try {
                const raw = fs.readFileSync(whisperOutputPath, 'utf8');
                if (whisperFormat === 'json') {
                    const parsed = JSON.parse(raw);
                    const text = (parsed.text || '').trim();
                    return resolve({
                        text,
                        language: parsed.language || normalizedLang || WHISPER_LANGUAGE,
                        segments: Array.isArray(parsed.segments) ? parsed.segments : [],
                        raw,
                    });
                }
                return resolve({
                    text: raw.trim(),
                    language: normalizedLang || WHISPER_LANGUAGE,
                    segments: [],
                    raw,
                });
            } catch (e) {
                return reject(new Error(`Erro ao ler saída do Whisper (${whisperFormat}): ${e.message}`));
            }
        });
    });
}

// --- ENDPOINTS DA API ---

/**
 * OpenAI-compatible GET /v1/models
 */
app.get('/v1/models', verifyOptionalAuth, (req, res) => {
    const now = Math.floor(Date.now() / 1000);
    res.json({
        object: 'list',
        data: [
            { id: 'whisper-1', object: 'model', created: now, owned_by: 'hyperion-local' },
            { id: WHISPER_MODEL, object: 'model', created: now, owned_by: 'hyperion-local' },
        ],
    });
});

/**
 * OpenAI-compatible POST /v1/audio/transcriptions
 * Aceita multipart/form-data com `file`, `model`, `language` (opcional), `response_format` (json | verbose_json | text | srt | vtt)
 */
app.post('/v1/audio/transcriptions', verifyOptionalAuth, (req, res, next) => {
    uploadAudio.single('file')(req, res, (err) => {
        if (err) {
            return res.status(400).json({
                error: {
                    message: err.message || 'Erro ao processar arquivo multipart.',
                    type: 'invalid_request_error',
                },
            });
        }
        next();
    });
}, async (req, res) => {
    if (!req.file) {
        return res.status(400).json({
            error: {
                message: 'O campo "file" (multipart/form-data) é obrigatório.',
                type: 'invalid_request_error',
                param: 'file',
            },
        });
    }

    const requestId = uuidv4();
    const uploadedPath = req.file.path;
    const tempWavPath = path.join(TEMP_DIR, `openai-${requestId}.wav`);
    const requestedModel = (req.body && req.body.model) || 'whisper-1';
    const requestedLanguage = (req.body && req.body.language) || null;
    const responseFormat = String((req.body && req.body.response_format) || 'json').trim().toLowerCase();

    const supportedFormats = new Set(['json', 'verbose_json', 'text', 'srt', 'vtt']);
    if (!supportedFormats.has(responseFormat)) {
        try { if (fs.existsSync(uploadedPath)) fs.unlinkSync(uploadedPath); } catch (_) {}
        return res.status(400).json({
            error: {
                message: `response_format inválido: "${responseFormat}". Use json, verbose_json, text, srt ou vtt.`,
                type: 'invalid_request_error',
                param: 'response_format',
            },
        });
    }

    const whisperFormat = (responseFormat === 'srt' || responseFormat === 'vtt') ? responseFormat : 'json';
    const whisperOutputPath = tempWavPath.replace(/\.[^/.]+$/, '') + `.${whisperFormat}`;

    try {
        logger.info(`[OpenAI STT ${requestId}] file="${req.file.originalname}" size=${req.file.size} model="${requestedModel}" lang="${requestedLanguage || 'auto'}" fmt="${responseFormat}"`);

        await processAudio(uploadedPath, tempWavPath);

        let audioDuration = 0;
        try {
            const metadata = await new Promise((resolve, reject) => {
                fluent_ffmpeg.ffprobe(tempWavPath, (err, data) => {
                    if (err) return reject(err);
                    resolve(data);
                });
            });
            audioDuration = Number(metadata?.format?.duration || 0);
        } catch (probeErr) {
            logger.warn(`[OpenAI STT ${requestId}] Falha no ffprobe: ${probeErr.message}`);
        }

        const result = await runWhisperOpenAI(tempWavPath, {
            language: requestedLanguage,
            whisperFormat,
        });

        logger.info(`[OpenAI STT ${requestId}] Concluído (${audioDuration.toFixed(2)}s, lang=${result.language}): "${result.text.slice(0, 120)}"`);

        if (responseFormat === 'verbose_json') {
            return res.status(200).json({
                task: 'transcribe',
                language: result.language || WHISPER_LANGUAGE,
                duration: Number(audioDuration.toFixed(2)),
                text: result.text,
                segments: result.segments,
            });
        }
        if (responseFormat === 'text') {
            return res.status(200).type('text/plain; charset=utf-8').send(result.text);
        }
        if (responseFormat === 'srt' || responseFormat === 'vtt') {
            return res.status(200).type('text/plain; charset=utf-8').send(result.raw);
        }
        return res.status(200).json({ text: result.text });
    } catch (error) {
        logger.error(`[OpenAI STT ${requestId}] Erro na transcrição:`, error);
        return res.status(500).json({
            error: {
                message: error.message || 'Erro ao transcrever o áudio.',
                type: 'server_error',
            },
        });
    } finally {
        [uploadedPath, tempWavPath, whisperOutputPath].forEach((filePath) => {
            if (filePath && fs.existsSync(filePath)) {
                try {
                    fs.unlinkSync(filePath);
                } catch (err) {
                    logger.warn(`[OpenAI STT ${requestId}] Falha ao remover temporário ${filePath}: ${err.message}`);
                }
            }
        });
    }
});

/**
 * @swagger
 * /transcribe:
 *   post:
 *     summary: Inicia o processo de transcrição de um arquivo de áudio.
 *     description: Recebe um áudio via base64 ou URL e retorna um ID de execução para consulta posterior.
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             properties:
 *               audioData:
 *                 type: string
 *                 description: Áudio codificado em base64.
 *               audioUrl:
 *                 type: string
 *                 description: URL para um arquivo de áudio.
 *     responses:
 *       202:
 *         description: Transcrição iniciada com sucesso.
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 executionId:
 *                   type: string
 *                 audioDuration:
 *                   type: number
 *                 estimatedTranscriptionTime:
 *                   type: number
 *       400:
 *         description: Requisição inválida (falta audioData ou audioUrl).
 */
app.post('/transcribe', async (req, res) => {
    const executionId = uuidv4();
    const { audioData, audioUrl } = req.body || {};

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
            if (!res.headersSent) {
                res.status(500).json({ executionId, error: error.message || 'Erro no processamento do áudio.' });
            }
        } finally {
            // Passo 6: Limpar todos os arquivos temporários gerados (.tmp, .wav, .txt)
            const whisperOutputPath = tempWavPath.replace(/\.[^/.]+$/, '') + '.txt';
            [tempInputPath, tempWavPath, whisperOutputPath].forEach((filePath) => {
                if (filePath && fs.existsSync(filePath)) {
                    try {
                        fs.unlinkSync(filePath);
                    } catch (err) {
                        logger.warn(`[${executionId}] Falha ao remover temporário ${filePath}: ${err.message}`);
                    }
                }
            });
        }
    })();
});

/**
 * @swagger
 * /status/{executionId}:
 *   get:
 *     summary: Consulta o status de um processo de transcrição.
 *     description: Retorna o status atual (running, complete, error) e o resultado final caso concluído.
 *     parameters:
 *       - in: path
 *         name: executionId
 *         required: true
 *         schema:
 *           type: string
 *         description: ID da execução retornado pelo endpoint /transcribe.
 *     responses:
 *       200:
 *         description: Status retornado com sucesso.
 *       404:
 *         description: ID de execução não encontrado.
 */
app.get('/status/:executionId', (req, res) => {
    const { executionId } = req.params;
    const task = tasks[executionId];

    if (!task) {
        return res.status(404).json({ error: 'ID de execução não encontrado.' });
    }

    res.json(task);
});

/**
 * @swagger
 * /health:
 *   get:
 *     summary: Healthcheck do serviço e validação do binário Faster Whisper.
 *     responses:
 *       200:
 *         description: Serviço e binários saudáveis.
 *       503:
 *         description: Falha no healthcheck do binário.
 */
app.get('/health', (req, res) => {
    const health = selfHeal.checkWhisperHealth(WHISPER_EXECUTABLE);
    if (health.healthy) {
        return res.status(200).json({ status: 'ok', whisper: 'healthy' });
    }
    res.status(503).json({ status: 'degraded', error: health.error });
});

// --- INICIALIZAÇÃO DO SERVIDOR ---
// Valida o binário e aplica autocorreção imediata se corrompido ou sem permissões
selfHeal.ensureHealthy(WHISPER_EXECUTABLE, __dirname);

app.listen(PORT, () => {
    logger.info(`🎙️  Servidor da API de Transcrição rodando na porta ${PORT}`);
    logger.info(`📝 Documentação Swagger disponível em http://localhost:${PORT}/api-docs`);
    logger.info('Aguardando requisições...');
});
