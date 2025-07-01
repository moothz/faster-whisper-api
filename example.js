// Importação dos módulos necessários
const axios = require('axios');
const fs = require('fs');
const path = require('path');

// --- CONFIGURAÇÕES ---
const API_URL = 'http://localhost:3378'; // URL base da sua API

/**
 * Função para aguardar um determinado tempo.
 * @param {number} ms - Tempo em milissegundos para aguardar.
 * @returns {Promise<void>}
 */
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * Verifica se uma string é uma URL válida.
 * @param {string} string - A string a ser verificada.
 * @returns {boolean} - Retorna true se for uma URL válida, false caso contrário.
 */
function isValidUrl(string) {
    try {
        new URL(string);
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Função principal do cliente de exemplo.
 */
async function main() {
    console.log('🤖 Cliente de Exemplo da API de Transcrição');

    // Passo 1: Verificar se o caminho do arquivo de áudio ou URL foi fornecido
    const input = process.argv[2];
    if (!input) {
        console.error('Erro: Forneça o caminho para um arquivo de áudio ou uma URL como argumento.');
        console.log('Uso: node example.js <caminho_do_audio.mp3_ou_url>');
        return; // Encerra o script se nenhum argumento for fornecido
    }

    let postResponse;
    let requestBody = {};

    if (isValidUrl(input)) {
        console.log(`Detectado URL: ${input}`);
        console.log('Enviando URL para a API...');
        requestBody.audioUrl = input;
    } else {
        // Verifica se o arquivo realmente existe
        if (!fs.existsSync(input)) {
            console.error(`Erro: O arquivo "${input}" não foi encontrado.`);
            return;
        }
        console.log(`Carregando o arquivo: ${path.basename(input)}`);
        // Ler o arquivo de áudio e converter para base64
        const audioBuffer = fs.readFileSync(input);
        requestBody.audioData = audioBuffer.toString('base64');
        console.log('Enviando áudio para a API...');
    }

    try {
        // Fazer a requisição POST para o endpoint /transcribe
        postResponse = await axios.post(`${API_URL}/transcribe`, requestBody);

        const { executionId, audioDuration, estimatedTranscriptionTime } = postResponse.data;
        if (!executionId) {
            throw new Error('A API não retornou um executionId.');
        }

        console.log(`🚀 Processo de transcrição iniciado! ID de Execução: ${executionId}`);
        console.log(`Duração do áudio: ${audioDuration} segundos.`);
        console.log(`Tempo estimado para a primeira verificação: ${estimatedTranscriptionTime} segundos.`);
        console.log('Verificando o status...');

        // Passo 4: Fazer polling no endpoint GET /status/:executionId
        let finalResult = null;
        let firstCheck = true;
        while (!finalResult) {
            const sleepTime = firstCheck ? estimatedTranscriptionTime * 1000 : 10000; // Aguarda o tempo estimado na primeira vez, depois 10 segundos
            await sleep(sleepTime);
            firstCheck = false;

            try {
                const statusResponse = await axios.get(`${API_URL}/status/${executionId}`);
                const result = statusResponse.data;

                console.log(`[${new Date().toLocaleTimeString()}] Status atual: ${result.status}`);

                // Verifica se o processo foi concluído ou deu erro
                if (result.status === 'complete') {
                    finalResult = result;
                    console.log('\n✅ Transcrição Concluída!\n');
                } else if (result.status === 'error') {
                    finalResult = result;
                    console.error('\n❌ Ocorreu um erro durante a transcrição.\n');
                }
                // Se o status for 'running', o loop continua

            } catch (error) {
                // Trata erros na consulta de status (ex: API caiu)
                throw new Error(`Não foi possível obter o status: ${error.message}`);
            }
        }

        // Passo 5: Imprimir o resultado final
        console.log('--- RESULTADO FINAL ---');
        console.log(JSON.stringify(finalResult, null, 2)); // Imprime o JSON formatado

    } catch (error) {
        console.error(`\n🚨 Erro Crítico: ${error.message}`);
        console.log(error);
        if (error.response) {
            // Imprime detalhes do erro da API, se disponíveis
            console.error('Detalhes do erro da API:', error.response.data);
        }
    }
}

// Executa a função principal
main();
