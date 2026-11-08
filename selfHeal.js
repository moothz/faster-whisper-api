const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const logger = require('./logger');

const PT_GNU_STACK = 0x6474e551;

/**
 * Remove flag PF_X (executável) do segmento PT_GNU_STACK em binários ELF 64-bit.
 * Evita erro "cannot enable executable stack as shared object requires: Invalid argument" no Linux moderno.
 * @param {string} filepath 
 * @returns {boolean} true se o arquivo foi alterado
 */
function patchElfStack(filepath) {
    if (!fs.existsSync(filepath)) return false;
    let fd;
    try {
        fd = fs.openSync(filepath, 'r+');
        const header = Buffer.alloc(64);
        fs.readSync(fd, header, 0, 64, 0);

        if (header.toString('ascii', 0, 4) !== '\x7fELF' || header.readUInt8(4) !== 2) {
            return false;
        }

        const e_phoff = Number(header.readBigUInt64LE(32));
        const e_phentsize = header.readUInt16LE(54);
        const e_phnum = header.readUInt16LE(56);

        const phBuffer = Buffer.alloc(e_phentsize);
        let patched = false;

        for (let i = 0; i < e_phnum; i++) {
            const offset = e_phoff + (i * e_phentsize);
            fs.readSync(fd, phBuffer, 0, e_phentsize, offset);
            const p_type = phBuffer.readUInt32LE(0);
            const p_flags = phBuffer.readUInt32LE(4);

            if (p_type === PT_GNU_STACK) {
                if (p_flags & 1) { // PF_X ativo
                    const newFlags = p_flags & ~1;
                    const writeBuf = Buffer.alloc(4);
                    writeBuf.writeUInt32LE(newFlags, 0);
                    fs.writeSync(fd, writeBuf, 0, 4, offset + 4);
                    logger.warn(`[SelfHeal] Flag executável removida de ${path.basename(filepath)} (0x${p_flags.toString(16)} -> 0x${newFlags.toString(16)})`);
                    patched = true;
                }
            }
        }
        return patched;
    } catch (err) {
        logger.error(`[SelfHeal] Erro ao analisar ELF ${filepath}: ${err.message}`);
        return false;
    } finally {
        if (fd !== undefined) {
            fs.closeSync(fd);
        }
    }
}

/**
 * Varre um diretório recursivamente buscando arquivos .so e aplica o patch ELF.
 * @param {string} dirPath 
 */
function patchAllSharedLibraries(dirPath) {
    if (!fs.existsSync(dirPath)) return;
    const entries = fs.readdirSync(dirPath, { withFileTypes: true });
    for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            patchAllSharedLibraries(fullPath);
        } else if (entry.isFile() && (entry.name.endsWith('.so') || entry.name.includes('.so.'))) {
            patchElfStack(fullPath);
        }
    }
}

/**
 * Verifica se o binário do Faster Whisper está funcional.
 * @param {string} executablePath 
 * @returns {{ healthy: boolean, error?: string }}
 */
function checkWhisperHealth(executablePath) {
    if (!executablePath || !fs.existsSync(executablePath)) {
        return { healthy: false, error: `Executável não encontrado em: ${executablePath}` };
    }

    try {
        execSync(`"${executablePath}" --help`, { stdio: 'pipe', timeout: 8000 });
        return { healthy: true };
    } catch (err) {
        const stderr = err.stderr ? err.stderr.toString() : '';
        const msg = stderr || err.message || 'Falha ao executar --help';
        return { healthy: false, error: msg.trim() };
    }
}

/**
 * Executa o auto-reparo do Faster Whisper:
 * 1. Descompacta o arquivo 7z de referência se disponível
 * 2. Garante permissão de execução
 * 3. Corrige headers ELF em todas as bibliotecas (.so)
 * 4. Valida a execução
 * @param {string} executablePath 
 * @param {string} rootDir 
 * @returns {boolean}
 */
function repairWhisperInstallation(executablePath, rootDir = __dirname) {
    logger.warn('[SelfHeal] 🚨 Iniciando processo de autocorreção do Faster Whisper...');

    const archiveCandidates = [
        path.join(rootDir, 'Faster-Whisper-XXL_r245.4_linux.7z'),
        path.join(rootDir, 'Faster-Whisper-XXL.7z'),
    ];

    const archivePath = archiveCandidates.find(p => fs.existsSync(p));
    if (archivePath) {
        logger.info(`[SelfHeal] Reextraindo binários a partir de: ${path.basename(archivePath)}`);
        try {
            execSync(`7z x -y "${archivePath}"`, { cwd: rootDir, stdio: 'pipe', timeout: 120000 });
            logger.info('[SelfHeal] Extração concluída com sucesso.');
        } catch (err) {
            logger.error(`[SelfHeal] Falha na extração do 7z: ${err.message}`);
        }
    } else {
        logger.warn('[SelfHeal] Arquivo de backup .7z não encontrado. Tentando reparar arquivos existentes.');
    }

    // Permissão de execução no binário
    if (fs.existsSync(executablePath)) {
        try {
            fs.chmodSync(executablePath, 0o755);
        } catch (err) {
            logger.error(`[SelfHeal] Falha ao ajustar permissões: ${err.message}`);
        }
    }

    // Corrige stack executável em todas as bibliotecas .so
    const xxlDir = path.dirname(executablePath);
    const dataDir = path.join(xxlDir, '_xxl_data');
    if (fs.existsSync(dataDir)) {
        logger.info('[SelfHeal] Verificando e corrigindo headers ELF nas bibliotecas...');
        patchAllSharedLibraries(dataDir);
    }

    // Validação final
    const health = checkWhisperHealth(executablePath);
    if (health.healthy) {
        logger.info('[SelfHeal] ✅ Faster Whisper recuperado e validado com sucesso!');
        return true;
    } else {
        logger.error(`[SelfHeal] ❌ Falha na recuperação do Faster Whisper: ${health.error}`);
        return false;
    }
}

/**
 * Garante que a instalação está saudável, auto-reparando se necessário.
 * @param {string} executablePath 
 * @param {string} rootDir 
 */
function ensureHealthy(executablePath, rootDir = __dirname) {
    const health = checkWhisperHealth(executablePath);
    if (health.healthy) {
        logger.info('[SelfHeal] Whisper healthcheck inicial OK.');
        return true;
    }
    logger.warn(`[SelfHeal] Healthcheck inicial falhou: ${health.error}`);
    return repairWhisperInstallation(executablePath, rootDir);
}

module.exports = {
    checkWhisperHealth,
    repairWhisperInstallation,
    ensureHealthy,
    patchElfStack,
};
