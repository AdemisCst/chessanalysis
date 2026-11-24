/* ========================================================================
   ARQUIVO: js/settings.js
   DESCRIÇÃO: Tela de configurações: perfil, privacidade da IA, backups,
   análise em lote e limpeza da biblioteca.
   ======================================================================== */

function fillSettingsForm() {
    const settings = Settings.get();
    $('playerNamesInput').value = settings.playerNames || '';
    $('depthSelect').value = String(settings.depth);
    if ($('aiBlockInput')) $('aiBlockInput').checked = !!(settings.ai.privacy && settings.ai.privacy.blocked);
    renderModelOptions();
    renderConsentState();
}

function renderConsentState() {
    const hint = $('aiConsentState');
    if (!hint) return;
    const privacy = AI.privacy();
    if (privacy.blocked) {
        hint.textContent = 'Envio bloqueado: nenhuma chamada externa será feita.';
        return;
    }
    if (AI.hasConsent()) {
        const date = privacy.consentAt ? new Date(privacy.consentAt).toLocaleString('pt-BR') : '';
        hint.textContent = `Envio autorizado${privacy.provider ? ' para ' + privacy.provider : ''}${date ? ' em ' + date : ''}. A autorização vale para este navegador.`;
        return;
    }
    hint.textContent = 'O primeiro envio pedirá sua autorização. Você pode recusar e continuar usando os recursos locais.';
}

function persistAIFromForm() {
    const blocked = $('aiBlockInput') ? !!$('aiBlockInput').checked : false;
    AI.savePrivacy({ blocked });
    renderConsentState();
    renderAIStatus();
    return { blocked };
}

/* ===================== BACKUP ===================== */
async function restoreBackup(file) {
    try {
        const text = await readFileText(file);
        const payload = JSON.parse(text);
        if (!payload || typeof payload !== 'object') throw new Error('O arquivo não contém um backup válido.');
        const stores = payload.stores || payload;
        const names = ['games', 'data', 'analysis', 'ai', 'meta'];
        const available = names.filter(name => Array.isArray(stores[name]));
        if (!available.includes('games')) {
            toast('O arquivo não parece ser um backup do Chess-Analysis.', 'error');
            return;
        }
        if (payload.app && payload.app !== 'chess-analysis' && payload.app !== 'acervo64') {
            toast('O backup tem uma origem desconhecida. A estrutura será validada antes de qualquer alteração.', 'warning');
        }

        const ok = await confirmAction(
            'Restaurar backup',
            'Os registros do arquivo serão mesclados com a biblioteca atual. Partidas com o mesmo identificador serão substituídas. Um backup do estado atual será baixado antes da mesclagem. Continuar?',
            'Restaurar'
        );
        if (!ok) return;

        // Proteção explícita antes de mesclar: o estado atual vira um arquivo.
        await exportJson();

        for (const name of available) {
            await DB.bulkPut(name, stores[name]);
        }
        State.aiCacheLoaded = false;
        // A seleção pode apontar para partidas que vieram de outro acervo.
        State.selected.clear();
        await reloadGames();
        // O backup pode trazer análises da versão antiga; enriquece de novo.
        await migrateAnalysisData(true);
        await loadAICache();
        fillSettingsForm();
        toast('Backup restaurado. O banco legado foi preservado e mesclado.', 'success');
    } catch (error) {
        toast('Falha ao restaurar: ' + error.message, 'error');
    }
}

/* ===================== ANÁLISE EM LOTE ===================== */
/**
 * Análise em lote agora passa pela fila (M5). A Central de Análises executa,
 * pausa e retoma; o `QueueRunner` só começa por chamada explícita da UI.
 */
async function analyzeAll(onlyGames) {
    if (typeof QueueUI === 'undefined') {
        toast('A Central de Análises não foi carregada.', 'error');
        return null;
    }
    return QueueUI.enqueueGames(Array.isArray(onlyGames) ? onlyGames : null, {
        start: true,
        goToView: true,
    });
}

/* ===================== LIMPEZA ===================== */
async function clearLibrary() {
    if (!State.games.length) {
        toast('A biblioteca já está vazia.', 'info');
        return;
    }
    const first = await confirmAction(
        'Apagar biblioteca',
        `Isso vai apagar ${State.games.length} partida(s), análises, tags e textos da IA. Deseja continuar?`,
        'Continuar'
    );
    if (!first) return;
    const second = await confirmAction(
        'Confirmar exclusão',
        'Esta ação não pode ser desfeita. Faça um backup antes se precisar. Apagar tudo agora?',
        'Apagar tudo'
    );
    if (!second) return;

    if (State.analysisRun) {
        State.analysisRun.abort();
        Engine.stop();
    }
    await DB.clearAll();
    State.games = [];
    State.filtered = [];
    State.current = null;
    State.data = null;
    State.analysis = null;
    State.ply = 0;
    State.aiSummaries = {};
    State.insights = null;
    State.repertoire = null;
    State.aiCacheLoaded = false;
    State.importReport = null;
    State.filters = { tokens: [], color: '', sort: 'date_desc' };
    State.filterSource = 'all';
    $('searchInput').value = '';
    $('gameContent').classList.add('hidden');
    $('noGame').classList.remove('hidden');
    renderInsights();
    renderRepertoire();
    renderImportReport();
    renderLibrary();
    renderRailCount();
    setView('library');
    toast('Biblioteca apagada.', 'info');
}

/* ===================== EVENTOS ===================== */
function bindSettingsEvents() {
    $('playerNamesInput').addEventListener('change', event => {
        Settings.save({ playerNames: event.target.value });
        renderLibrary();
        if (State.current) renderGameHeader();
        if ($('view-stats').classList.contains('active')) renderStatsView();
        toast('Perfil salvo.', 'success');
    });

    $('depthSelect').addEventListener('change', event => {
        Settings.save({ depth: Number(event.target.value) || 12 });
        toast('Profundidade salva. Vale para novas análises.', 'success');
    });

    $('saveAiBtn').addEventListener('click', async () => {
        const state = persistAIFromForm();
        toast('Configuração da IA salva.', 'success');
        if (state.blocked) {
            State.ai = { online: false, models: [], error: 'Envio de dados à IA desativado nas Configurações.', code: 'privacy_blocked' };
            setAIStatus(false, 'IA externa desativada');
            renderAIStatus();
            return;
        }
        await checkAI(true);
        renderAIStatus();
    });

    $('aiBlockInput').addEventListener('change', event => {
        AI.savePrivacy({ blocked: !!event.target.checked });
        renderConsentState();
        renderAIStatus();
        if (event.target.checked) {
            State.ai = { online: false, models: [], error: 'Envio de dados à IA desativado nas Configurações.', code: 'privacy_blocked' };
            setAIStatus(false, 'IA externa desativada');
            toast('Envio de dados à IA bloqueado.', 'info');
        } else {
            toast('Envio de dados à IA permitido. A autorização será pedida antes do primeiro envio.', 'info');
            checkAI(true);
        }
    });

    $('revokeConsentBtn').addEventListener('click', () => {
        AI.savePrivacy({ consentVersion: '', consentAt: 0, provider: '' });
        renderConsentState();
        renderAIStatus();
        toast('Autorização de envio revogada. O próximo uso pedirá autorização novamente.', 'info');
    });

    $('testAiBtn').addEventListener('click', async () => {
        const state = persistAIFromForm();
        const result = $('aiTestResult');
        result.className = 'test-result';
        result.textContent = 'Testando conexão…';
        if (state.blocked) {
            result.className = 'test-result error';
            result.textContent = 'O envio de dados à IA está bloqueado nas Configurações.';
            return;
        }
        const status = await checkAI(true);
        if (!status.online) {
            result.className = 'test-result error';
            result.textContent = status.error || 'Não foi possível conectar.';
            return;
        }
        result.className = 'test-result ok';
        result.textContent = `Conectado a ${aiProviderLabel()}${status.model ? ' · modelo ' + status.model : ''}. `
            + 'Nenhum dado de partida foi enviado neste teste.';
        renderAIStatus();
    });

    $('exportPgnBtn').addEventListener('click', exportAllPgn);
    $('exportJsonBtn').addEventListener('click', exportJson);
    $('importJsonBtn').addEventListener('click', () => $('jsonInput').click());
    $('jsonInput').addEventListener('change', async event => {
        const file = event.target.files[0];
        if (file) await restoreBackup(file);
        event.target.value = '';
    });

    $('analyzeAllBtn').addEventListener('click', analyzeAll);
    $('clearLibraryBtn').addEventListener('click', clearLibrary);
}
