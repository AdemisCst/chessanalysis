/* ========================================================================
   ARQUIVO: js/sync.js
   DESCRIÇÃO: Sincronização de partidas Chess.com/Lichess pela API local.
   ======================================================================== */

const Sync = (() => {
    const STORAGE_KEY = 'acervo64_sync_sources_v1';
    const PERIODS = [3, 6, 12];
    const PERF_OPTIONS = [
        { id: 'ultraBullet', label: 'Ultra-bullet' },
        { id: 'bullet', label: 'Bullet' },
        { id: 'blitz', label: 'Blitz' },
        { id: 'rapid', label: 'Rápida' },
        { id: 'classical', label: 'Clássica' },
        { id: 'correspondence', label: 'Correspondência' },
    ];
    const SOURCES = {
        chesscom: { label: 'Chess.com', failureLabel: ['mês', 'meses'] },
        lichess: { label: 'Lichess', failureLabel: ['consulta', 'consultas'] },
    };

    let initialized = false;
    let activeSource = 'chesscom';
    let drafts = {};
    let warnedStorage = false;

    function escapeHtml(value) {
        return String(value == null ? '' : value).replace(/[&<>"']/g, character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[character]));
    }

    function readConnections() {
        try {
            const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || '{}');
            const result = {};
            Object.keys(SOURCES).forEach(source => {
                const record = parsed && parsed[source];
                if (!record || typeof record.username !== 'string') return;
                result[source] = {
                    username: record.username,
                    lastSyncAt: typeof record.lastSyncAt === 'string' ? record.lastSyncAt : '',
                    months: PERIODS.includes(Number(record.months)) ? Number(record.months) : 3,
                    perfTypes: Array.isArray(record.perfTypes)
                        ? record.perfTypes.filter(type => Sources.PERF_TYPES.includes(type))
                        : Sources.PERF_TYPES.slice(),
                    newCount: Number(record.newCount) || 0,
                    existingCount: Number(record.existingCount) || 0,
                    failedCount: Number(record.failedCount) || 0,
                };
            });
            return result;
        } catch (error) {
            if (!warnedStorage) {
                console.warn('Não foi possível ler as configurações de sincronização.', error);
                warnedStorage = true;
            }
            return {};
        }
    }

    function saveConnection(source, values) {
        try {
            const all = readConnections();
            all[source] = values;
            window.localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
            return true;
        } catch (error) {
            console.warn('Não foi possível salvar as configurações de sincronização.', error);
            toast('Sincronização concluída, mas não foi possível salvar a conta neste navegador.', 'warning');
            return false;
        }
    }

    function formatSyncDate(value) {
        const date = new Date(value);
        if (!Number.isFinite(date.getTime())) return 'data desconhecida';
        return date.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit' });
    }

    function renderConnections() {
        const host = document.getElementById('syncSources');
        if (!host) return;
        const connections = readConnections();
        const items = Object.keys(SOURCES)
            .filter(source => connections[source])
            .map(source => {
                const item = connections[source];
                const definition = Sources.SOURCES[source];
                const profile = definition.profilePage(item.username);
                return `<span class="sync-source-item">
                    <a href="${escapeHtml(profile)}" target="_blank" rel="noopener noreferrer">${SOURCES[source].label}</a>
                    · ${escapeHtml(item.username)} · Última sync: ${escapeHtml(formatSyncDate(item.lastSyncAt))}
                </span>`;
            });
        host.innerHTML = items.join('');
        host.classList.toggle('hidden', items.length === 0);
    }

    function buildRequests(source, username, months, reference) {
        const now = reference == null ? new Date() : (reference instanceof Date ? reference : new Date(reference));
        if (!Number.isFinite(now.getTime())) throw new Error('Data de referência inválida.');
        const period = Sources.monthsBack(months, now);
        if (source === 'chesscom') {
            return period.map(month => ({
                month,
                url: Sources.buildProxyUrl('chesscom', { username, month }),
            }));
        }
        if (source === 'lichess') {
            const start = Sources.parseMonth(period[0]);
            return [{
                month: null,
                url: Sources.buildProxyUrl('lichess', {
                    username,
                    max: Sources.LICHESS_MAX,
                    since: Date.UTC(start.year, start.month - 1, 1),
                    until: now.getTime(),
                }),
            }];
        }
        throw new Error('Fonte de partidas desconhecida.');
    }

    function classifyTimeControl(value, headers) {
        const tags = headers || {};
        if (/correspondence/i.test(String(tags.Event || ''))) return 'correspondence';
        const text = String(value || '').trim();
        if (text === '-' || /^correspondence$/i.test(text)) return 'correspondence';

        const match = text.match(/^(?:\d+\/)?(\d+(?:\.\d+)?)(?:\+(\d+(?:\.\d+)?))?/);
        if (!match) return null;
        const initial = Number(match[1]);
        const increment = Number(match[2] || 0);
        const estimatedSeconds = initial + increment * 40;
        if (estimatedSeconds < 30) return 'ultraBullet';
        if (estimatedSeconds < 180) return 'bullet';
        if (estimatedSeconds < 480) return 'blitz';
        if (estimatedSeconds < 1500) return 'rapid';
        return 'classical';
    }

    function filterGamesByPerf(games, perfTypes) {
        const selected = new Set((perfTypes || []).filter(type => Sources.PERF_TYPES.includes(type)));
        if (!selected.size) return [];
        if (selected.size === Sources.PERF_TYPES.length) return (games || []).slice();
        return (games || []).filter(game => {
            const headers = game.headers || {};
            const perf = classifyTimeControl(game.timeControl || headers.TimeControl, headers);
            return selected.has(perf);
        });
    }

    function captureDraft() {
        const username = document.getElementById('syncUsername');
        const months = document.getElementById('syncMonths');
        if (!username || !months) return;
        drafts[activeSource] = {
            username: username.value,
            months: Number(months.value),
            perfTypes: Array.from(document.querySelectorAll('[data-sync-perf]:checked'))
                .map(input => input.value),
        };
    }

    function renderForm(source) {
        activeSource = source;
        const saved = readConnections()[source] || {};
        const draft = drafts[source] || {};
        const username = draft.username !== undefined ? draft.username : (saved.username || '');
        const months = PERIODS.includes(Number(draft.months))
            ? Number(draft.months)
            : (PERIODS.includes(Number(saved.months)) ? Number(saved.months) : 3);
        const selectedTypes = new Set(draft.perfTypes || saved.perfTypes || Sources.PERF_TYPES);
        const tabs = Object.keys(SOURCES).map(id => `
            <button type="button" class="btn btn-sm ${id === source ? 'btn-secondary sync-tab' : 'btn-ghost sync-tab'}"
                    role="tab" aria-selected="${id === source}" data-sync-tab="${id}">
                ${SOURCES[id].label}
            </button>`).join('');
        const periodOptions = PERIODS.map(count =>
            `<option value="${count}" ${months === count ? 'selected' : ''}>Últimos ${count} meses</option>`
        ).join('');
        const perfOptions = PERF_OPTIONS.map(option => `
            <label class="sync-perf-option">
                <input type="checkbox" data-sync-perf value="${option.id}" ${selectedTypes.has(option.id) ? 'checked' : ''}>
                ${option.label}
            </label>`).join('');

        openModal({
            title: 'Sincronizar partidas',
            body: `
                <div class="sync-tabs" role="tablist" aria-label="Fonte de partidas">${tabs}</div>
                <form id="syncForm" class="sync-form">
                    <label for="syncUsername">Usuário ${SOURCES[source].label}
                        <input id="syncUsername" class="input" type="text" autocomplete="username"
                               placeholder="Nome de usuário" value="${escapeHtml(username)}" required>
                    </label>
                    <label for="syncMonths">Período
                        <select id="syncMonths" class="select">${periodOptions}</select>
                    </label>
                    <fieldset>
                        <legend class="muted small">Controles de tempo</legend>
                        <div class="sync-perf-grid">${perfOptions}</div>
                    </fieldset>
                    <p class="sync-note">O filtro de ritmo é aplicado localmente pelo TimeControl do PGN (estimativa de 40 lances).</p>
                </form>`,
            footer: `<button id="syncCancel" class="btn btn-ghost" type="button">Cancelar</button>
                     <button class="btn btn-primary" type="submit" form="syncForm">Buscar partidas</button>`,
        });

        document.querySelectorAll('[data-sync-tab]').forEach(button => {
            button.addEventListener('click', () => {
                captureDraft();
                renderForm(button.dataset.syncTab);
            });
        });
        document.getElementById('syncCancel').addEventListener('click', closeModal);
        document.getElementById('syncForm').addEventListener('submit', event => {
            event.preventDefault();
            captureDraft();
            const currentDraft = drafts[source];
            const validation = Sources.validateUsername(source, currentDraft.username);
            if (!validation.ok) {
                toast(validation.message, 'warning');
                document.getElementById('syncUsername').focus();
                return;
            }
            const chosen = currentDraft.perfTypes;
            if (!chosen.length) {
                toast('Selecione ao menos um controle de tempo.', 'warning');
                return;
            }
            start(source, validation.username, currentDraft.months, chosen);
        });
    }

    function open(source) {
        renderForm(SOURCES[source] ? source : 'chesscom');
    }

    function showProgress(source, current, total, status) {
        const fill = document.getElementById('syncProgressFill');
        const statusElement = document.getElementById('syncStatus');
        if (fill) {
            fill.style.width = `${Math.max(0, Math.min(100, (current / total) * 100))}%`;
            fill.parentElement.setAttribute('aria-valuenow', String(current));
        }
        if (statusElement) statusElement.textContent = status;
        if (!fill || !statusElement) {
            openModal({
                title: `Sincronizando ${SOURCES[source].label}`,
                body: `<p id="syncStatus">${escapeHtml(status)}</p>
                       <div class="modal-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${total}" aria-valuenow="${current}">
                           <span id="syncProgressFill" style="width:${Math.max(0, Math.min(100, (current / total) * 100))}%"></span>
                       </div>
                       <p class="muted small">A consulta pode levar alguns instantes.</p>`,
                closable: false,
            });
        }
    }

    async function fetchPgn(url) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 15000);
        try {
            const response = await fetch(url, {
                headers: { Accept: 'application/x-chess-pgn' },
                signal: controller.signal,
            });
            const contentType = response.headers.get('content-type') || '';
            const classification = Sources.classifyResponse({
                status: response.status,
                expect: 'pgn',
                contentType,
                retryAfter: response.headers.get('retry-after'),
            });
            if (classification.ok && contentType.toLowerCase().includes('json')) {
                return { ok: false, error: Sources.describeError('invalid_response') };
            }
            if (!classification.ok) {
                let message = classification.message || Sources.describeError('upstream');
                if (contentType.toLowerCase().includes('json')) {
                    try {
                        const payload = await response.json();
                        if (payload && typeof payload.error === 'string') message = payload.error;
                    } catch (error) {
                        // Mantém a mensagem HTTP quando o corpo não for JSON válido.
                    }
                }
                return { ok: false, error: message };
            }
            return { ok: true, text: await response.text() };
        } catch (error) {
            const code = error.name === 'AbortError' ? 'timeout' : 'network';
            return { ok: false, error: Sources.describeError(code) };
        } finally {
            clearTimeout(timer);
        }
    }

    function wait(milliseconds) {
        return new Promise(resolve => setTimeout(resolve, milliseconds));
    }

    function countText(count, singular, plural) {
        return `${count} ${count === 1 ? singular : plural}`;
    }

    function showSummary(result) {
        const parts = [
            countText(result.imported, 'nova', 'novas'),
            countText(result.existing, 'existente', 'existentes'),
        ];
        if (result.failures.length) {
            const labels = SOURCES[result.source].failureLabel;
            parts.push(`${countText(result.failures.length, labels[0], labels[1])} ${result.failures.length === 1 ? 'falhou' : 'falharam'}`);
        }
        const detailItems = result.details.slice(0, 8)
            .map(detail => `<li>${escapeHtml(detail)}</li>`).join('');
        const queueButton = result.imported
            ? `<button id="syncQueueBtn" class="btn btn-primary">Adicionar ${result.imported} ${result.imported === 1 ? 'nova' : 'novas'} à fila</button>`
            : '';
        openModal({
            title: 'Resumo da sincronização',
            body: `<p class="sync-summary">${parts.join(' · ')}</p>
                   ${result.filteredOut ? `<p class="muted small">${result.filteredOut} partida(s) fora dos controles selecionados.</p>` : ''}
                   ${detailItems ? `<div class="modal-detail"><ul>${detailItems}</ul></div>` : ''}`,
            footer: `${queueButton}<button id="syncSummaryClose" class="btn btn-ghost">Fechar</button>`,
        });
        document.getElementById('syncSummaryClose').addEventListener('click', closeModal);
        const queue = document.getElementById('syncQueueBtn');
        if (queue) {
            queue.addEventListener('click', async () => {
                closeModal();
                const ids = new Set(result.newIds);
                const games = State.games.filter(game => ids.has(game.id));
                if (!games.length) {
                    toast('As novas partidas não estão disponíveis na biblioteca.', 'warning');
                    return;
                }
                await QueueUI.enqueueGames(games, { start: true, goToView: true });
            });
        }
    }

    async function start(source, username, months, perfTypes) {
        try {
            const requests = buildRequests(source, username, months, new Date());
            const pgnParts = [];
            const failures = [];
            openModal({
                title: `Sincronizando ${SOURCES[source].label}`,
                body: `<p id="syncStatus">Preparando consulta…</p>
                       <div class="modal-progress" role="progressbar" aria-valuemin="0" aria-valuemax="${requests.length}" aria-valuenow="0">
                           <span id="syncProgressFill"></span>
                       </div>
                       <p class="muted small">A consulta pode levar alguns instantes.</p>`,
                closable: false,
            });

            for (let index = 0; index < requests.length; index++) {
                const request = requests[index];
                if (index) await wait(Sources.REQUEST_GAP_MS);
                showProgress(source, index, requests.length, request.month
                    ? `Buscando ${request.month}…`
                    : `Buscando até 100 partidas de ${username}…`);
                const result = await fetchPgn(request.url);
                if (result.ok) {
                    if (result.text.trim()) pgnParts.push(result.text);
                } else {
                    failures.push({
                        month: request.month,
                        message: request.month ? `${request.month}: ${result.error}` : result.error,
                    });
                }
                showProgress(source, index + 1, requests.length, `${index + 1} de ${requests.length} consulta(s) concluída(s)`);
            }

            const pgn = pgnParts.join('\n\n');
            const parsed = pgn ? PGN.parse(pgn, `${SOURCES[source].label} - ${username}`) : { games: [], errors: [] };
            const filtered = filterGamesByPerf(parsed.games, perfTypes);
            const seen = new Set((State.games || []).map(game => game.id));
            const candidates = [];
            let existing = 0;
            filtered.forEach(game => {
                if (seen.has(game.id)) {
                    existing++;
                    return;
                }
                seen.add(game.id);
                candidates.push(game);
            });

            if (candidates.length) {
                await importSources([{
                    name: `${SOURCES[source].label} - ${username}.pgn`,
                    text: candidates.map(game => PGN.serialize(game)).join('\n\n'),
                }], { source });
            } else {
                closeModal();
            }

            const candidateIds = new Set(candidates.map(game => game.id));
            const importedGames = (State.games || []).filter(game => candidateIds.has(game.id));
            const details = failures.map(failure => failure.message);
            (parsed.errors || []).slice(0, 5).forEach(error => details.push(error.message));
            const report = State.importReport;
            if (report && report.errors && report.errors.length && importedGames.length < candidates.length) {
                report.errors.slice(0, 5).forEach(error => details.push(error));
            }
            if (importedGames.length < candidates.length) {
                details.push('Algumas partidas não puderam ser gravadas no banco local.');
            }
            const completedAt = new Date().toISOString();
            saveConnection(source, {
                username,
                lastSyncAt: completedAt,
                months,
                perfTypes,
                newCount: importedGames.length,
                existingCount: existing,
                failedCount: failures.length,
            });
            renderConnections();
            showSummary({
                source,
                imported: importedGames.length,
                existing,
                failures,
                details,
                filteredOut: parsed.games.length - filtered.length,
                newIds: importedGames.map(game => game.id),
            });
        } catch (error) {
            console.error('Falha ao sincronizar partidas:', error);
            closeModal();
            toast(`Não foi possível concluir a sincronização: ${error.message || error}`, 'error');
        }
    }

    function init() {
        if (initialized) return;
        const syncButton = document.getElementById('syncBtn');
        if (!syncButton) return;
        initialized = true;
        syncButton.addEventListener('click', () => open('chesscom'));
        document.getElementById('emptyChesscomSyncBtn').addEventListener('click', () => open('chesscom'));
        document.getElementById('emptyLichessSyncBtn').addEventListener('click', () => open('lichess'));
        renderConnections();
    }

    return {
        init,
        open,
        buildRequests,
        classifyTimeControl,
        filterGamesByPerf,
    };
})();

window.Sync = Sync;
if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', Sync.init, { once: true });
    } else {
        Sync.init();
    }
}
