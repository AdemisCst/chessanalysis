/* ========================================================================
   ARQUIVO: js/app.js
   DESCRIÇÃO: Núcleo da interface. Estado global, utilidades, navegação entre
   telas, tema, modais, avisos, markdown seguro e inicialização.
   Os demais módulos (library.js, game.js, analytics.js, settings.js) usam
   as funções e o objeto State definidos aqui.
   ======================================================================== */

const State = {
    games: [],
    filtered: [],
    page: 0,
    view: 'library',
    current: null,
    data: null,
    ply: 0,
    orientation: 'white',
    analysis: null,
    analysisRun: null,
    ai: { online: false, models: [], error: null },
    aiSummaries: {},
    insights: null,
    repertoire: null,
    aiCacheLoaded: false,
    aiBusy: false,
    aiController: null,
    aiMoveController: null,
    chatHistory: [],
    chatSources: [],
    importReport: null,
    selected: new Set(),
    filters: { tokens: [], color: '', sort: 'date_desc' },
    filterSource: 'all',
};

const $ = id => document.getElementById(id);
const $$ = selector => Array.from(document.querySelectorAll(selector));

/* ===================== UTILITÁRIOS ===================== */
function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, ch => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[ch]));
}

function debounce(fn, wait) {
    let timer = null;
    return function (...args) {
        clearTimeout(timer);
        timer = setTimeout(() => fn.apply(this, args), wait);
    };
}

function formatDate(iso, fallback) {
    if (!iso) return fallback || '—';
    const parts = iso.split('-');
    if (parts.length !== 3) return iso;
    return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

function openingLabel(game) {
    if (!game.opening) return game.eco || '—';
    return game.eco ? `${game.eco} · ${game.opening}` : game.opening;
}

function identity() {
    return Stats.identifyPlayer(State.games, Settings.playerNameList());
}

function userColorOf(game) {
    return Stats.userColor(game, identity());
}

function downloadFile(filename, content, mime) {
    const blob = new Blob([content], { type: mime || 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
}

function todayStamp() {
    const now = new Date();
    return `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
}

function copyText(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
        return navigator.clipboard.writeText(text);
    }
    return new Promise((resolve, reject) => {
        const area = document.createElement('textarea');
        area.value = text;
        area.style.position = 'fixed';
        area.style.opacity = '0';
        document.body.appendChild(area);
        area.select();
        try {
            document.execCommand('copy');
            resolve();
        } catch (error) {
            reject(error);
        } finally {
            area.remove();
        }
    });
}

/* ===================== AVISOS (TOASTS) ===================== */
function toast(message, type) {
    const host = $('toastHost');
    if (!host) return;
    const item = document.createElement('div');
    item.className = 'toast ' + (type || '');
    item.textContent = message;
    item.addEventListener('click', () => item.remove());
    host.appendChild(item);
    setTimeout(() => item.remove(), 5200);
}

/* ===================== MODAL ===================== */
let modalState = { closable: true, onClose: null, previousFocus: null };
let modalCloseHandler = null;

/** Elementos focáveis visíveis dentro do modal, na ordem do DOM. */
function modalFocusables() {
    return $$('#modal button, #modal input, #modal select, #modal textarea, #modal a[href]')
        .filter(element => !element.disabled && element.offsetParent !== null);
}

function openModal(options) {
    const opts = options || {};
    const modal = $('modal');
    const wasHidden = modal.classList.contains('hidden') || modal.classList.contains('is-closing');
    if (modalCloseHandler) {
        modal.removeEventListener('animationend', modalCloseHandler);
        modalCloseHandler = null;
    }
    $('modalTitle').textContent = opts.title || '';
    $('modalBody').innerHTML = opts.body || '';
    $('modalFooter').innerHTML = opts.footer || '';
    $('modalClose').style.visibility = opts.closable === false ? 'hidden' : 'visible';
    modalState = {
        closable: opts.closable !== false,
        onClose: opts.onClose || null,
        previousFocus: wasHidden ? document.activeElement : modalState.previousFocus,
    };
    modal.inert = false;
    modal.setAttribute('aria-hidden', 'false');
    modal.classList.remove('hidden', 'is-closing');
    // Leva o foco para o primeiro controle útil, sem roubar o foco de quem
    // abriu um teclado virtual em um campo específico.
    setTimeout(() => {
        const target = $('modalBody').querySelector('input, select, textarea, button')
            || $('modalFooter').querySelector('button')
            || $('modalClose');
        if (target) target.focus();
    }, 30);
}

function closeModal() {
    const modal = $('modal');
    if (modal.classList.contains('hidden') || modal.classList.contains('is-closing')) return;
    const callback = modalState.onClose;
    const previous = modalState.previousFocus;
    modalState = { closable: true, onClose: null, previousFocus: null };
    modal.inert = true;
    modal.setAttribute('aria-hidden', 'true');
    modal.classList.add('is-closing');
    modalCloseHandler = event => {
        if (event.target !== modal || event.animationName !== 'modalOut') return;
        modal.removeEventListener('animationend', modalCloseHandler);
        modalCloseHandler = null;
        if (!modal.classList.contains('is-closing')) return;
        modal.classList.remove('is-closing');
        modal.classList.add('hidden');
    };
    modal.addEventListener('animationend', modalCloseHandler);
    if (previous && typeof previous.focus === 'function') previous.focus();
    if (callback) callback();
}

function confirmAction(title, message, confirmLabel) {
    return new Promise(resolve => {
        let settled = false;
        function finish(value) {
            if (settled) return;
            settled = true;
            resolve(value);
            closeModal();
        }
        openModal({
            title,
            body: `<p>${escapeHtml(message)}</p>`,
            footer: `<button class="btn btn-ghost" data-act="cancel">Cancelar</button>
                     <button class="btn btn-primary" data-act="ok">${escapeHtml(confirmLabel || 'Confirmar')}</button>`,
            onClose: () => finish(false),
        });
        $('modalFooter').querySelector('[data-act="ok"]').addEventListener('click', () => finish(true));
        $('modalFooter').querySelector('[data-act="cancel"]').addEventListener('click', () => finish(false));
    });
}

/* ===================== MARKDOWN SEGURO (para textos da IA) ===================== */
function inlineMarkdown(text) {
    return text
        .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
        .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdown(text) {
    if (!text) return '';
    const lines = escapeHtml(text).replace(/\r\n?/g, '\n').split('\n');
    let html = '';
    let listType = null;

    function closeList() {
        if (listType) {
            html += `</${listType}>`;
            listType = null;
        }
    }

    for (const raw of lines) {
        const line = raw.trim();
        if (!line) { closeList(); continue; }
        let match = line.match(/^#{1,4}\s+(.*)$/);
        if (match) { closeList(); html += `<h4>${inlineMarkdown(match[1])}</h4>`; continue; }
        match = line.match(/^[-*•]\s+(.*)$/);
        if (match) {
            if (listType !== 'ul') { closeList(); html += '<ul>'; listType = 'ul'; }
            html += `<li>${inlineMarkdown(match[1])}</li>`;
            continue;
        }
        match = line.match(/^\d+[.)]\s+(.*)$/);
        if (match) {
            if (listType !== 'ol') { closeList(); html += '<ol>'; listType = 'ol'; }
            html += `<li>${inlineMarkdown(match[1])}</li>`;
            continue;
        }
        closeList();
        html += `<p>${inlineMarkdown(line)}</p>`;
    }
    closeList();
    return html;
}

function streamTarget(element) {
    let text = '';
    let lastPaint = 0;
    element.innerHTML = '<p class="spinner-line">Gerando com o assistente… isso pode levar alguns segundos.</p>';
    return {
        push(token) {
            text += token;
            const now = Date.now();
            if (now - lastPaint > 70) {
                lastPaint = now;
                element.innerHTML = renderMarkdown(text) + '<span class="stream-cursor"></span>';
                element.scrollTop = element.scrollHeight;
            }
        },
        get text() { return text; },
        finish() {
            element.innerHTML = renderMarkdown(text);
            return text;
        },
        fail(message) {
            element.innerHTML = `<p class="muted">${escapeHtml(message)}</p>`;
        },
    };
}

/* ===================== TEMA ===================== */
/**
 * O tema escuro é o padrão. A classe `light` é uma alternativa opcional;
 * nunca dependemos da presença de `dark` para o tema principal.
 */
function applyTheme(theme) {
    const light = theme === 'light';
    document.body.classList.toggle('light', light);
    const button = $('themeBtn');
    if (button) {
        button.textContent = light ? '🌙' : '☀';
        button.title = light ? 'Ativar tema escuro' : 'Ativar tema claro';
    }
}

function toggleTheme() {
    const settings = Settings.get();
    const next = settings.theme === 'light' ? 'dark' : 'light';
    Settings.save({ theme: next });
    applyTheme(next);
}

/* ===================== NAVEGAÇÃO ENTRE TELAS ===================== */
function setView(name) {
    State.view = name;
    $$('.view').forEach(view => view.classList.toggle('active', view.id === 'view-' + name));

    // Aberturas é auxiliar de Desempenho: mantém o item pai como ativo.
    const railView = name === 'openings' ? 'stats' : name;
    $$('.rail-btn').forEach(button => {
        const active = button.dataset.view === railView;
        button.classList.toggle('active', active);
        if (active) button.setAttribute('aria-current', 'page');
        else button.removeAttribute('aria-current');
    });

    if (name === 'game') {
        $('noGame').classList.toggle('hidden', !!State.current);
        $('gameContent').classList.toggle('hidden', !State.current);
    }
    if (name === 'openings') renderOpeningsView();
    if (name === 'stats') renderStatsView();
    if (name === 'analyses' && window.QueueUI) QueueUI.activate();
    if (name === 'ai') { renderAIStatus(); loadAICache(); }
    if (name === 'settings') fillSettingsForm();
}

/* ===================== STATUS DA IA E PRIVACIDADE ===================== */
function setAIStatus(online, text) {
    const chip = $('aiStatusChip');
    if (!chip) return;
    chip.classList.remove('online', 'offline');
    chip.classList.add(online ? 'online' : 'offline');
    const label = $('aiStatusText');
    if (label) label.textContent = text;
}

/** Rótulo público do provedor. Nunca mostramos localhost no site publicado. */
function aiProviderLabel() {
    const remote = State.ai || {};
    if (remote.providerLabel) return remote.providerLabel;
    return 'provedor externo';
}

async function checkAI(quiet) {
    setAIStatus(false, 'Treinador IA: verificando…');
    const result = await AI.check();
    State.ai = result;
    if (result.online) {
        setAIStatus(true, 'Treinador IA: pronto');
        const chip = $('aiStatusChip');
        if (chip) chip.title = `Conectado a ${aiProviderLabel()}${result.model ? ' · modelo ' + result.model : ''}`;
        renderModelOptions();
    } else {
        const blocked = result.code === 'privacy_blocked';
        setAIStatus(false, blocked ? 'IA externa desativada' : 'Treinador IA: offline');
        const chip = $('aiStatusChip');
        if (chip) chip.title = result.error || 'Treinador IA indisponível';
        if (!quiet) toast(
            blocked
                ? 'O envio de dados à IA está desativado nas Configurações.'
                : 'Treinador IA indisponível. Abra Configurações para revisar o servidor.',
            'warning'
        );
    }
    renderAIStatus();
    return result;
}

function renderModelOptions() {
    const list = $('aiModelList');
    if (!list) return;
    list.innerHTML = (State.ai.models || [])
        .map(model => `<option value="${escapeHtml(model.name)}"></option>`)
        .join('');
}

/**
 * Indicador persistente da área Treinador IA. Explica o provedor externo, o
 * consentimento e o motivo de uma eventual indisponibilidade — sem expor
 * chaves, endereços internos ou prometer um assistente que não funciona.
 */
function renderAIStatus() {
    const notice = $('aiPrivacyNotice');
    if (!notice) return;
    const privacy = AI.privacy();
    const online = !!State.ai.online;
    const consent = AI.hasConsent();
    const provider = escapeHtml(aiProviderLabel());
    const model = State.ai && State.ai.model ? escapeHtml(State.ai.model) : '';

    if (privacy.blocked) {
        notice.className = 'notice warning';
        notice.innerHTML = '🌐 <strong>IA externa desativada.</strong> Nenhum dado sai deste navegador. '
            + 'Biblioteca, Stockfish, estatísticas e PDF continuam funcionando. '
            + 'Para reativar, abra <strong>Configurações → Treinador IA</strong>.';
        return;
    }

    if (online) {
        notice.className = 'notice accent';
        notice.innerHTML = `🌐 <strong>IA externa conectada</strong> · ${provider}${model ? ' · modelo ' + model : ''}. `
            + (consent
                ? 'Você autorizou o envio de dados minimizados (lances SAN, avaliações, abertura e resultado; sem nomes, usernames, URLs, evento ou local). '
                : 'Você será consultado antes do primeiro envio. ')
            + 'A chave do provedor fica somente no servidor.';
        return;
    }

    notice.className = 'notice';
    notice.innerHTML = `🌐 <strong>IA externa indisponível.</strong> ${escapeHtml(State.ai.error || 'O servidor não confirmou o assistente.')} `
        + 'Biblioteca, Stockfish, estatísticas e PDF continuam funcionando. '
        + 'Abra <strong>Configurações → Treinador IA</strong> para revisar.';
}

function setAIBusy(busy) {
    ['aiSummaryBtn', 'aiTagsBtn', 'genInsightsBtn', 'genRepertoireBtn'].forEach(id => {
        const element = $(id);
        if (element) element.disabled = !!busy;
    });
    $$('[data-explain-ply]').forEach(element => { element.disabled = !!busy; });
}

/**
 * Autorização completa antes de qualquer chamada externa:
 * privacidade → disponibilidade → consentimento informado.
 * Nunca simula funcionamento quando a IA está desligada.
 */
async function requireAI(options) {
    const opts = options || {};
    if (AI.isBlocked()) {
        toast('O envio de dados à IA está desativado nas Configurações.', 'warning');
        return false;
    }
    if (!State.ai.online) await checkAI(true);
    if (!State.ai.online) {
        toast('O Treinador IA não está disponível. A biblioteca e a análise local continuam funcionando.', 'warning');
        return false;
    }
    const allowed = await AI.ensureConsent();
    if (!allowed) {
        if (!opts.silentDeny) toast('Envio não autorizado. Nenhum dado foi enviado à IA.', 'info');
        return false;
    }
    return true;
}

/* ===================== CARREGAMENTO DE CACHES ===================== */
async function loadAISummariesIndex() {
    try {
        const records = await DB.getAll('ai');
        State.aiSummaries = {};
        records.forEach(record => {
            if (record.kind === 'summary' && record.gameId) State.aiSummaries[record.gameId] = record;
        });
    } catch (error) {
        State.aiSummaries = {};
    }
}

async function loadAICache() {
    if (State.aiCacheLoaded) return;
    State.aiCacheLoaded = true;
    try {
        const insights = await DB.getMeta('insights');
        const repertoire = await DB.getMeta('repertoire');
        State.insights = insights ? insights.value : null;
        State.repertoire = repertoire ? repertoire.value : null;
    } catch (error) {
        State.insights = null;
        State.repertoire = null;
    }
    renderInsights();
    renderRepertoire();
}

function aiRecordMeta(record) {
    if (!record) return '';
    const date = record.createdAt ? new Date(record.createdAt).toLocaleString('pt-BR') : '';
    return `Gerado por ${record.model || 'Treinador IA'}${date ? ' em ' + date : ''}.`;
}

/* ===================== RELOAD GERAL ===================== */
async function reloadGames() {
    State.games = await DB.getAll('games');
    State.games.sort((a, b) => (b.dateISO || '').localeCompare(a.dateISO || '') || (b.importedAt || 0) - (a.importedAt || 0));
    await loadAISummariesIndex();
    renderLibrary();
    renderRailCount();
    if ($('view-stats').classList.contains('active')) renderStatsView();
}

function renderRailCount() {
    const foot = $('railCount');
    if (foot) foot.textContent = State.games.length === 1 ? '1 partida' : `${State.games.length} partidas`;
}

/* ===================== MIGRAÇÃO DAS ANÁLISES ===================== */
/**
 * Proveniência: análises gravadas antes desta tarefa não têm `engineBuild`.
 * A migração grava o build inferido **no mesmo registro e na mesma chave**,
 * sem tocar em posições, avaliações, resumos ou `version`. Análises do SF10
 * continuam acessíveis e jamais são sobrescritas por uma reanálise, porque a
 * análise nova usa `gameId@depth@build`.
 *
 * O marcador `analysisProvenanceMigration` evita repetir o trabalho. Ele é
 * independente de `analysisMigration` (que reconstrói anotações v1).
 */
async function migrateAnalysisProvenance(force) {
    if (!window.Engine || typeof Engine.buildOf !== 'function') return { updated: 0, summaries: 0, skipped: true };
    const marker = await DB.getMeta('analysisProvenanceMigration').catch(() => null);
    if (!force && marker && Number(marker.value) >= 1) return { updated: 0, summaries: 0, skipped: true };

    let updated = 0;
    const records = await DB.getAll('analysis').catch(() => []);
    for (const record of records) {
        if (record.engineBuild) continue;
        const next = Object.assign({}, record, { engineBuild: Engine.buildOf(record) });
        await DB.put('analysis', next);
        updated++;
    }

    let summaries = 0;
    for (const game of State.games) {
        if (!game.analysisSummary) continue;
        let changed = false;
        if (!game.analysisSummary.engineBuild) {
            const list = await DB.getByIndex('analysis', 'gameId', game.id).catch(() => []);
            const best = (list || []).sort((a, b) => (b.depth - a.depth) || (b.createdAt - a.createdAt))[0];
            game.analysisSummary.engineBuild = Engine.buildOf(best || game.analysisSummary);
            changed = true;
        }
        if (game.analyzedBuild !== game.analysisSummary.engineBuild) {
            game.analyzedBuild = game.analysisSummary.engineBuild;
            changed = true;
        }
        if (changed) {
            await DB.put('games', game);
            summaries++;
        }
    }

    await DB.saveMeta('analysisProvenanceMigration', 1).catch(() => {});
    return { updated, summaries, skipped: false };
}

/**
 * Análises geradas antes da versão 2 não têm anotações (!!, ★, ×, ??, ?,
 * !, 👍), ACPL nem precisão por fase. Como as posições do Stockfish já estão
 * salvas, é possível reconstruir tudo sem reanalisar nenhuma partida.
 *
 * A migração roda uma vez por navegador e grava o marcador `analysisMigration`
 * para não repetir o trabalho a cada abertura do aplicativo.
 */
async function migrateAnalysisData(force) {
    if (!window.Engine || typeof Engine.enrichAnalysis !== 'function') return { updated: 0, skipped: true };
    // Reprocessar análises também reaplica a proveniência, sem alterar chaves.
    if (force) await migrateAnalysisProvenance(true);
    const marker = await DB.getMeta('analysisMigration').catch(() => null);
    if (!force && marker && Number(marker.value) >= 3) return { updated: 0, skipped: true };

    const candidates = State.games;
    let updated = 0;

    for (const game of candidates) {
        try {
            const [analysis, data] = await Promise.all([
                DB.getAnalysis(game.id),
                DB.get('data', game.id),
            ]);
            if (!data) continue;
            const enriched = analysis ? Engine.enrichAnalysis(analysis, data) : null;
            const analysisChanged = !!enriched && enriched !== analysis;
            if (window.Openings && data.moves) Openings.enrichGame(game);
            const tagsChanged = window.Tags ? Tags.apply(game, enriched, data.moves) : false;
            if (!analysisChanged && !tagsChanged) continue;
            if (analysisChanged) {
                await DB.saveAnalysis(enriched);
                game.analysisSummary = enriched.summary;
                game.analyzedBuild = Engine.buildOf(enriched);
            }
            await DB.put('games', game);
            updated++;
        } catch (error) {
            console.warn('Falha ao migrar a análise de', game.id, error);
        }
    }

    await DB.saveMeta('analysisMigration', 3).catch(() => {});
    if (updated) {
        renderLibrary();
        if ($('view-stats').classList.contains('active')) renderStatsView();
    }
    return { updated, skipped: false };
}

async function migrateGameSources() {
    const marker = 'acervo64_source_migration_done';
    if (localStorage.getItem(marker) === 'true') return { updated: 0, skipped: true };

    const games = await DB.getAll('games');
    const updates = [];
    games.forEach(game => {
        if (!game || (game.source != null && game.source !== '')) return;
        const headers = game.headers || {};
        const sourceHeaders = Object.keys(headers)
            .filter(name => name.toLowerCase() === 'site' || name.toLowerCase() === 'link')
            .map(name => String(headers[name] == null ? '' : headers[name]))
            .join(' ')
            .toLowerCase();
        const source = sourceHeaders.includes('chess.com')
            ? 'chesscom'
            : sourceHeaders.includes('lichess.org') ? 'lichess' : 'manual';
        updates.push(Object.assign({}, game, { source }));
    });

    const batchSize = 200;
    for (let offset = 0; offset < updates.length; offset += batchSize) {
        await DB.bulkPut('games', updates.slice(offset, offset + batchSize));
        if (offset + batchSize < updates.length) {
            await new Promise(resolve => setTimeout(resolve, 0));
        }
    }

    localStorage.setItem(marker, 'true');
    return { updated: updates.length, skipped: false };
}

/* ===================== INICIALIZAÇÃO ===================== */
function bindGlobalEvents() {
    $$('.rail-btn').forEach(button => {
        button.addEventListener('click', () => setView(button.dataset.view));
    });
    $$('[data-goto]').forEach(button => {
        button.addEventListener('click', () => setView(button.dataset.goto));
    });
    $('themeBtn').addEventListener('click', toggleTheme);
    $('modalClose').addEventListener('click', closeModal);
    $('modal').addEventListener('click', event => {
        if (event.target === $('modal') && modalState.closable) closeModal();
    });
    document.addEventListener('keydown', event => {
        if (!event.key) return;
        const modalOpen = !$('modal').classList.contains('hidden');
        if (event.key === 'Escape' && modalOpen && modalState.closable) {
            event.preventDefault();
            closeModal();
            return;
        }
        if (event.key === 'Tab' && modalOpen) {
            const focusables = modalFocusables();
            if (!focusables.length) return;
            const first = focusables[0];
            const last = focusables[focusables.length - 1];
            if (event.shiftKey && document.activeElement === first) {
                event.preventDefault();
                last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
                event.preventDefault();
                first.focus();
            }
            return;
        }
        if (State.view !== 'game' || !State.current) return;
        const tag = (event.target.tagName || '').toLowerCase();
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
        if (event.key === 'ArrowLeft') { event.preventDefault(); setPly(State.ply - 1); }
        if (event.key === 'ArrowRight') { event.preventDefault(); setPly(State.ply + 1); }
        if (event.key === 'Home') { event.preventDefault(); setPly(0); }
        if (event.key === 'End') { event.preventDefault(); setPly(State.data ? State.data.moves.length : 0); }
    });
    $('aiStatusChip').addEventListener('click', () => setView('ai'));
}

async function init() {
    Settings.get();
    applyTheme(Settings.get().theme);
    Board.init($('board'));

    if (location.protocol === 'file:') {
        $('protocolBanner').classList.remove('hidden');
    }

    bindGlobalEvents();
    bindLibraryEvents();
    bindGameEvents();
    bindAnalyticsEvents();
    bindSettingsEvents();

    try {
        await DB.open();
        try {
            await migrateGameSources();
        } catch (error) {
            console.error('Falha ao migrar a origem das partidas.', error);
            toast('Não foi possível atualizar a origem das partidas. A migração será tentada novamente na próxima abertura.', 'warning');
        }
        await Openings.load().catch(() => []);
        await reloadGames();
        // Primeiro carimba a proveniência; depois reaproveita análises antigas.
        await migrateAnalysisProvenance(false);
        await migrateAnalysisData(false);
    } catch (error) {
        toast('Não foi possível abrir o banco local: ' + error.message, 'error');
    }

    fillSettingsForm();
    renderImportReport();
    renderLibrary();
    renderRailCount();
    if (window.QueueUI) QueueUI.init();
    checkAI(true);
}

document.addEventListener('DOMContentLoaded', init);
