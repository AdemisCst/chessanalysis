/* Regressões estáticas da Fase 1. Executar com: npm test */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = name => readFile(join(root, name), 'utf8');

test('index.html não contém elementos removidos na Fase 1', async () => {
    const html = await read('index.html');
    assert.equal(html.includes('dropZone'), false);
    assert.equal(html.includes('dropzone'), false);
    assert.equal(html.includes('Detalhes da conexão'), false);
    assert.equal(html.includes('Código de acesso'), false);
    assert.equal(html.includes('licenças completas'), false);
    assert.equal(html.includes('Organizador de partidas'), false);
    assert.equal(html.includes('Assistente de IA'), false);
    assert.equal(html.includes('aiModeSelect'), false);
    assert.equal(html.includes('aiProxyInput'), false);
    assert.equal(html.includes('localhost'), false);
});

test('navegação principal tem as seis áreas oficiais', async () => {
    const html = await read('index.html');
    const nav = html.slice(html.indexOf('<nav class="rail"'), html.indexOf('</nav>'));
    const views = [...nav.matchAll(/data-view="([^"]+)"/g)].map(match => match[1]);
    assert.deepEqual(views, ['library', 'analyses', 'game', 'stats', 'ai', 'settings']);
});

test('importação e exportação ficam na Biblioteca com os IDs usados pelos handlers', async () => {
    const html = await read('index.html');
    const header = html.slice(html.indexOf('<header class="app-header">'), html.indexOf('</header>'));
    const libraryStart = html.indexOf('<section id="view-library"');
    const library = html.slice(libraryStart, html.indexOf('</section>', libraryStart));
    const handlers = await read('js/library.js');

    for (const id of ['importBtn', 'exportBtn']) {
        assert.equal((html.match(new RegExp(`id="${id}"`, 'g')) || []).length, 1, `ID duplicado ou ausente: ${id}`);
        assert.equal(header.includes(`id="${id}"`), false, `#${id} ainda está no cabeçalho`);
        assert.ok(library.includes(`id="${id}"`), `#${id} não está na Biblioteca`);
        assert.ok(handlers.includes(`$('${id}')`), `handler de #${id} ausente`);
    }
});

test('Central de Análises tem view, controles e módulo ligado', async () => {
    const html = await read('index.html');
    assert.ok(html.includes('id="view-analyses"'));
    assert.ok(html.includes('js/queue-ui.js'));
    for (const id of [
        'queueStartBtn', 'queuePauseBtn', 'queueStopBtn', 'queueClearDoneBtn',
        'queueList', 'queueFilters', 'queueEmpty', 'railQueueBadge', 'queueAllBtn',
    ]) {
        assert.ok(html.includes(`id="${id}"`), 'faltou #' + id);
    }
    assert.ok(html.includes('data-queue-filter="all"') === false); // filtros são renderizados pela UI
    assert.ok(html.includes('adicionar à fila') || html.includes('Adicionar à fila'));
    const ui = await read('js/queue-ui.js');
    assert.ok(ui.includes('data-queue-filter='));
});

test('UI da fila usa o executor existente e não reimplementa storage', async () => {
    const ui = await read('js/queue-ui.js');
    assert.ok(ui.includes('new BroadcastChannel(CHANNEL_NAME)'));
    assert.ok(ui.includes('QueueRunner.start()'));
    assert.ok(ui.includes('QueueRunner.pause()'));
    assert.ok(ui.includes('QueueRunner.stop()'));
    assert.ok(ui.includes('DB.enqueueAnalyses('));
    assert.ok(ui.includes('DB.getQueue()'));
    assert.equal(ui.includes('claimLease('), false);
    assert.equal(ui.includes('finishQueueItem('), false);
});

test('Biblioteca e Configurações enfileiram em vez de executar o modal antigo', async () => {
    const library = await read('js/library.js');
    const settings = await read('js/settings.js');
    assert.ok(library.includes('QueueUI.enqueueGames('));
    assert.ok(settings.includes('QueueUI.enqueueGames('));
    assert.equal(settings.includes("title: 'Analisando partidas'"), false);
});

test('relatório, aviso de privacidade e controles de consentimento estão ligados', async () => {
    const html = await read('index.html');
    assert.ok(html.includes('js/report.js'));
    assert.ok(html.includes('id="aiPrivacyNotice"'));
    assert.ok(html.includes('id="aiBlockInput"'));
    assert.ok(html.includes('id="revokeConsentBtn"'));
});

test('tema padrão é escuro e a classe alternativa é light', async () => {
    const storage = await read('js/storage.js');
    const css = await read('style.css');
    assert.match(storage, /theme:\s*'dark'/);
    assert.ok(css.includes('body.light'));
    assert.equal(css.includes('body.dark'), false);
});

test('ordem visual das anotações segue a diretriz oficial', async () => {
    const engine = await read('js/engine.js');
    assert.ok(engine.includes("'brilliant', 'great', 'best', 'excellent', 'good'"));
    assert.ok(engine.includes("'book', 'inaccuracy', 'mistake', 'missed', 'blunder'"));
    assert.ok(engine.includes('setoption name MultiPV value 2'));
});

test('cores das classificações correspondem à paleta definida', async () => {
    const css = await read('style.css');
    const colors = {
        '--ann-brilliant': '#26c2a3',
        '--ann-great': '#1b9aff',
        '--ann-best': '#96bc4b',
        '--ann-excellent': '#96bc4b',
        '--ann-good': '#95bb4a',
        '--ann-book': '#a88865',
        '--ann-inaccuracy': '#f7c631',
        '--ann-mistake': '#ffa459',
        '--ann-missed': '#fa412d',
        '--ann-blunder': '#fa412d',
    };
    Object.entries(colors).forEach(([token, color]) => {
        assert.ok(css.includes(`${token}: ${color};`), `${token} deve usar ${color}`);
    });
});

test('motor atualizado para o Stockfish 19 lite single com WDL capturado', async () => {
    const engine = await read('js/engine.js');
    assert.ok(engine.includes("vendor/stockfish/stockfish-19-lite-single.js"));
    assert.ok(engine.includes('setoption name UCI_ShowWDL value true'));
    assert.ok(engine.includes('function parseWdl'));
    assert.equal(engine.includes("'vendor/stockfish/stockfish.js'"), false);
    // A interface continua usando a curva sobre cp nesta fase.
    assert.ok(engine.includes('0.00368208'));
    for (const name of ['stockfish-19-lite-single.js', 'stockfish-19-lite-single.wasm']) {
        const info = await stat(join(root, 'vendor/stockfish', name));
        assert.ok(info.size > 1000, name + ' parece vazio');
    }
});

test('exports e backup usam a identidade nova sem perder o banco legado', async () => {
    const library = await read('js/library.js');
    const storage = await read('js/storage.js');
    assert.ok(library.includes("app: 'chess-analysis'"));
    assert.ok(library.includes('chess-analysis-backup-'));
    assert.equal(library.includes('acervo64-backup-'), false);
    assert.ok(storage.includes("const NAME = 'acervo64'"));
    assert.ok(storage.includes("const KEY = 'acervo64_settings_v1'"));
});

test('cliente da IA não guarda código de acesso e usa o proxy do site', async () => {
    const ai = await read('js/ai.js');
    const settings = await read('js/settings.js');
    assert.equal(ai.includes('accessCode'), false);
    assert.equal(settings.includes('accessCode'), false);
    assert.ok(ai.includes('function useProxy()'));
    assert.ok(ai.includes('return true;'));
    assert.ok(ai.includes('ensureConsent'));
});

test('.env.example aponta para a Groq e não reintroduz código de acesso', async () => {
    const env = await read('.env.example');
    assert.ok(env.includes('AI_BASE_URL=https://api.groq.com/openai/v1'));
    assert.ok(env.includes('AI_MODEL=openai/gpt-oss-120b'));
    assert.ok(env.includes('AI_MAX_TOKENS=4096'));
    assert.equal(env.includes('deepseek'), false);
    assert.equal(env.includes('llama-3.3-70b-versatile'), false);
    assert.equal(env.includes('AI_ACCESS_MODE'), false);
    assert.equal(env.includes('AI_ACCESS_CODES'), false);
});

test('cliente e proxy não voltam a citar o provedor/modelo antigos', async () => {
    const ai = await read('js/ai.js');
    const html = await read('index.html');
    const lib = await read('api/_lib.js');
    assert.equal(html.includes('(DeepSeek)'), false);
    assert.equal(lib.includes('deepseek-chat'), false);
    assert.ok(ai.includes("'api.groq.com': 'https://groq.com/privacy-policy'"));
    assert.equal(ai.includes('llama-3.3-70b-versatile'), false);
});
