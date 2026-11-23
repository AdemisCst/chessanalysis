/* ========================================================================
   ARQUIVO: js/queue-ui.js
   DESCRIÇÃO: Central de Análises (Fase 3, etapa M5).
   - A view `analyses` lê a fila por `DB.getQueue()` e o executor por
     `QueueRunner.status()`; não reimplementa regra de fila.
   - Enfileirar usa `DB.enqueueAnalyses`; iniciar usa explicitamente
     `QueueRunner.start()` (o executor não auto-inicia).
   - Atualiza em tempo real por um BroadcastChannel próprio + polling e
     visibilidade como fallback. Nada recarrega a página.
   - Pausa, retomada, cancelamento e retry usam apenas a API pública já
     existente em `QueueRunner`/`DB`; `storage.js`, `queue.js` e `engine.js`
     não são alterados.
   ======================================================================== */

const QueueUI = (() => {
    const CHANNEL_NAME = 'acervo64-queue';
    const EVENT_KEY = 'acervo64-queue-event';
    const PAUSE_KEY = 'analysisQueuePaused';
    const POLL_MS = 2500;
    const THROTTLE_MS = 250;

    const STATES = {
        pending: { label: 'Pendente', chip: '', group: 'pending' },
        running: { label: 'Rodando', chip: 'accent', group: 'active' },
        paused: { label: 'Pausada', chip: 'warning', group: 'pending' },
        interrupted: { label: 'Interrompida', chip: 'warning', group: 'pending' },
        error: { label: 'Erro', chip: 'danger', group: 'failed' },
        done: { label: 'Concluída', chip: 'success', group: 'done' },
        canceled: { label: 'Cancelada', chip: '', group: 'done' },
    };

    const FILTERS = [
        { id: 'all', label: 'Todos' },
        { id: 'pending', label: 'Pendentes' },
        { id: 'active', label: 'Em andamento' },
        { id: 'failed', label: 'Falhas' },
        { id: 'done', label: 'Concluídas' },
    ];

    let initialized = false;
    let channel = null;
    let pollTimer = null;
    let refreshTimer = null;
    let refreshing = false;
    let refreshAgain = false;
    let filter = 'all';
    let doneSignature = null;
    let last = { items: [], paused: false, status: null, lease: null };

    const el = id => document.getElementById(id);
    const now = () => Date.now();

    function notify(message, type) {
        if (typeof toast === 'function') toast(message, type);
    }

    function escape(value) {
        const text = String(value == null ? '' : value);
        if (typeof escapeHtml === 'function') return escapeHtml(text);
        return text.replace(/[&<>"']/g, character => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[character]));
    }

    function stateMeta(state) {
        return STATES[state] || { label: state || 'Desconhecido', chip: '', group: 'other' };
    }

    function isActive(item) {
        if (typeof Queue !== 'undefined' && Queue && typeof Queue.isActive === 'function') {
            return Queue.isActive(item);
        }
        return ['pending', 'running', 'paused', 'interrupted', 'error'].indexOf(item && item.state) !== -1;
    }

    /**
     * Progresso exibido de um item. Enquanto ele roda, o status vivo do
     * executor tem prioridade sobre o último checkpoint gravado no banco.
     */
    function progressOf(item, status) {
        const total = Number(item && item.positionsTotal);
        const live = !!(item && item.state === 'running' && status && status.itemKey === item.key);
        const liveTotal = live ? Number(status.total) : 0;
        const liveDone = live ? Number(status.done) : 0;
        const totalSafe = Number.isFinite(total) && total > 0
            ? total
            : (Number.isFinite(liveTotal) && liveTotal > 0 ? liveTotal : 0);
        let doneSafe = Number(item && item.positionsDone);
        if (!Number.isFinite(doneSafe) || doneSafe < 0) doneSafe = 0;
        if (live && Number.isFinite(liveDone) && liveDone >= 0) doneSafe = Math.max(doneSafe, liveDone);
        if (totalSafe > 0) doneSafe = Math.min(doneSafe, totalSafe);
        if (item && item.state === 'done' && totalSafe > 0) doneSafe = totalSafe;
        const pct = totalSafe > 0
            ? Math.round((doneSafe / totalSafe) * 100)
            : (item && item.state === 'done' ? 100 : 0);
        return {
            done: doneSafe,
            total: totalSafe,
            pct: Math.max(0, Math.min(100, pct)),
            known: totalSafe > 0,
        };
    }

    function matchesFilter(item, id) {
        if (!id || id === 'all') return true;
        return stateMeta(item && item.state).group === id;
    }

    /**
     * Resumo global. Canceladas ficam fora do denominador para não impedirem
     * que a barra chegue a 100% quando o usuário limpa a fila.
     */
    function summarize(items, status) {
        const summary = { done: 0, total: 0, pct: 0, unknown: 0, counters: {} };
        (items || []).forEach(item => {
            const state = item && item.state;
            summary.counters[state] = (summary.counters[state] || 0) + 1;
            if (state === 'canceled') return;
            const progress = progressOf(item, status);
            if (!progress.known) { summary.unknown++; return; }
            summary.total += progress.total;
            summary.done += state === 'done' ? progress.total : Math.min(progress.done, progress.total);
        });
        summary.pct = summary.total > 0 ? Math.round((summary.done / summary.total) * 100) : 0;
        return summary;
    }

    /** ETA pela média móvel das últimas 5 partidas concluídas. */
    function estimateRemaining(items, summary) {
        if (!summary || summary.total <= summary.done) return null;
        const finished = (items || [])
            .filter(item => item.state === 'done'
                && Number(item.startedAt) > 0
                && Number(item.finishedAt) > Number(item.startedAt)
                && Number(item.positionsTotal) > 0)
            .sort((a, b) => Number(b.finishedAt) - Number(a.finishedAt))
            .slice(0, 5);
        if (!finished.length) return null;
        const average = finished.reduce((sum, item) => (
            sum + ((Number(item.finishedAt) - Number(item.startedAt)) / Number(item.positionsTotal))
        ), 0) / finished.length;
        const ms = average * (summary.total - summary.done);
        return Number.isFinite(ms) && ms > 0 ? ms : null;
    }

    function formatDuration(ms) {
        if (!Number.isFinite(ms) || ms <= 0) return '';
        if (ms < 2000) return 'menos de 2 s';
        if (ms < 60000) return `~${Math.round(ms / 1000)} s`;
        if (ms < 3600000) return `~${Math.ceil(ms / 60000)} min`;
        return `~${(ms / 3600000).toFixed(1)} h`;
    }

    function activeCount(items) {
        return (items || []).filter(isActive).length;
    }

    function gameLabel(item) {
        const games = (typeof State !== 'undefined' && Array.isArray(State.games)) ? State.games : [];
        const game = games.find(candidate => candidate.id === item.gameId);
        if (!game) return `Partida ${String(item.gameId || '').slice(0, 8) || 'removida'}`;
        return `${game.white || 'Brancas'} × ${game.black || 'Pretas'}`;
    }

    function ordered(items) {
        const rank = { running: 0, pending: 1, paused: 2, interrupted: 3, error: 4, done: 5, canceled: 6 };
        return (items || []).slice().sort((a, b) => (
            (rank[a.state] === undefined ? 9 : rank[a.state])
            - (rank[b.state] === undefined ? 9 : rank[b.state])
        ) || ((Number(a.priority) || 0) - (Number(b.priority) || 0)));
    }

    function renderBadge() {
        const badge = el('railQueueBadge');
        if (!badge) return;
        const count = activeCount(last.items);
        badge.textContent = String(count);
        badge.classList.toggle('hidden', count === 0);
        badge.title = count === 1 ? '1 item ativo na fila' : `${count} itens ativos na fila`;
    }

    function renderControls() {
        const status = last.status || { running: false, role: 'idle', itemKey: null };
        const paused = last.paused;
        const items = last.items || [];

        const start = el('queueStartBtn');
        if (start) {
            start.disabled = !!status.running && !paused;
            start.textContent = paused
                ? '▶ Retomar'
                : (status.running ? '▶ Em execução' : '▶ Iniciar');
        }

        const pause = el('queuePauseBtn');
        if (pause) pause.disabled = paused || !status.running;

        const stop = el('queueStopBtn');
        if (stop) stop.disabled = !status.running && !status.itemKey;

        const clearDone = el('queueClearDoneBtn');
        if (clearDone) {
            clearDone.disabled = !items.some(item => item.state === 'done' || item.state === 'canceled');
        }

        const cancelPending = el('queueCancelPendingBtn');
        if (cancelPending) {
            cancelPending.disabled = !items.some(item => (
                item.state === 'pending' || item.state === 'paused' || item.state === 'interrupted'
            ));
        }

        const enqueueAll = el('queueEnqueueAllBtn');
        if (enqueueAll) {
            const games = (typeof State !== 'undefined' && Array.isArray(State.games)) ? State.games : [];
            enqueueAll.disabled = games.length === 0;
        }
    }

    function itemHtml(item) {
        const meta = stateMeta(item.state);
        const progress = progressOf(item, last.status);
        const attempts = Number(item.attempts) || 0;
        const positions = progress.known
            ? `${progress.done}/${progress.total} posições`
            : (progress.done ? `${progress.done} posições` : 'posições —');
        const actions = [];
        if (item.gameId) {
            actions.push(`<button class="btn btn-sm btn-ghost" data-queue-action="open" data-key="${escape(item.key)}" data-game="${escape(item.gameId)}">Abrir</button>`);
        }
        if (item.state === 'error') {
            actions.push(`<button class="btn btn-sm btn-secondary" data-queue-action="retry" data-key="${escape(item.key)}">Tentar novamente</button>`);
        }
        if (item.state === 'pending' || item.state === 'paused' || item.state === 'interrupted') {
            actions.push(`<button class="btn btn-sm btn-ghost danger" data-queue-action="cancel" data-key="${escape(item.key)}">Cancelar</button>`);
        }
        if (item.state === 'done' || item.state === 'canceled') {
            actions.push(`<button class="btn btn-sm btn-ghost" data-queue-action="remove" data-key="${escape(item.key)}">Remover</button>`);
        }

        return `<article class="queue-item state-${escape(item.state)}" data-key="${escape(item.key)}">
            <div class="queue-item-head">
                <div class="queue-item-title">
                    <span class="chip ${meta.chip}">${meta.label}</span>
                    <strong>${escape(gameLabel(item))}</strong>
                </div>
                <div class="queue-item-actions">${actions.join('')}</div>
            </div>
            <div class="queue-item-meta muted small">
                <span>profundidade ${item.depth || '—'}</span>
                <span>build ${escape(item.engineBuild || '—')}</span>
                <span>${positions}</span>
                ${attempts ? `<span>${attempts} tentativa(s)</span>` : ''}
                ${item.lastError ? `<span class="queue-error">${escape(item.lastError)}</span>` : ''}
            </div>
            <div class="progress-track queue-item-progress" role="progressbar"
                 aria-valuenow="${progress.pct}" aria-valuemin="0" aria-valuemax="100"
                 aria-label="Progresso de ${escape(gameLabel(item))}">
                <div class="progress-fill" style="width:${progress.pct}%"></div>
            </div>
        </article>`;
    }

    function render() {
        const items = last.items || [];
        const status = last.status || { running: false, role: 'idle', itemKey: null };
        const summary = summarize(items, status);

        const subtitle = el('analysesSubtitle');
        if (subtitle) {
            subtitle.textContent = items.length
                ? `${activeCount(items)} item(ns) ativo(s) · ${items.length} registro(s) na fila · profundidade ${(typeof Settings !== 'undefined' ? Settings.get().depth : '—')}`
                : 'A fila está vazia. Adicione partidas pela Biblioteca.';
        }

        const counters = el('queueCounters');
        if (counters) {
            counters.innerHTML = Object.keys(STATES).map(state => {
                const meta = stateMeta(state);
                const count = summary.counters[state] || 0;
                return `<span class="chip ${meta.chip}">${meta.label} <strong>${count}</strong></span>`;
            }).join('');
        }

        const summaryText = el('queueSummaryText');
        if (summaryText) {
            if (!items.length) {
                summaryText.textContent = 'Nenhum item na fila.';
            } else if (!summary.total) {
                summaryText.textContent = `${items.length} item(ns) na fila; progresso disponível após o início.`;
            } else {
                const unknown = summary.unknown ? ` · ${summary.unknown} sem total` : '';
                summaryText.textContent = `${summary.done} de ${summary.total} posições concluídas${unknown}.`;
            }
        }

        const fill = el('queueProgressFill');
        if (fill) fill.style.width = `${summary.pct}%`;

        const eta = el('queueEta');
        if (eta) {
            if (last.paused) {
                eta.textContent = 'Pausada';
            } else {
                const remaining = estimateRemaining(items, summary);
                eta.textContent = remaining ? `ETA ${formatDuration(remaining)}` : '';
            }
        }

        const owner = el('queueOwner');
        if (owner) {
            owner.textContent = status.role === 'owner'
                ? 'Executor: esta aba'
                : (status.role === 'observer' ? 'Executor: outra aba' : 'Executor: parado');
        }

        const notice = el('queueStatusNotice');
        if (notice) {
            let text = '';
            let extra = '';
            if (last.paused) {
                text = 'Fila pausada globalmente. O item em execução salva o checkpoint e para; use Retomar para continuar.';
            } else if (status.role === 'observer') {
                text = 'Outra aba está executando a fila. Esta aba acompanha em tempo real e assume se a aba dona parar.';
                extra = ' accent';
            }
            notice.className = 'notice' + extra + (text ? '' : ' hidden');
            notice.textContent = text;
        }

        const filters = el('queueFilters');
        if (filters) {
            filters.innerHTML = FILTERS.map(entry => {
                const count = entry.id === 'all'
                    ? items.length
                    : items.filter(item => matchesFilter(item, entry.id)).length;
                return `<button type="button" class="chip ${entry.id === filter ? 'accent' : ''}"
                    data-queue-filter="${entry.id}" aria-pressed="${entry.id === filter}">
                    ${entry.label} (${count})
                </button>`;
            }).join('');
        }

        const list = el('queueList');
        const empty = el('queueEmpty');
        if (!items.length) {
            if (list) { list.innerHTML = ''; list.classList.add('hidden'); }
            if (empty) empty.classList.remove('hidden');
            renderControls();
            return;
        }
        if (empty) empty.classList.add('hidden');
        if (!list) { renderControls(); return; }
        list.classList.remove('hidden');
        const visible = ordered(items.filter(item => matchesFilter(item, filter)));
        list.innerHTML = visible.length
            ? visible.map(itemHtml).join('')
            : `<p class="queue-filter-empty muted small">Nenhum item neste filtro.</p>`;
        renderControls();
    }

    async function refresh() {
        if (typeof DB === 'undefined') return;
        if (refreshing) { refreshAgain = true; return; }
        refreshing = true;
        try {
            const [items, pausedRecord, lease] = await Promise.all([
                DB.getQueue(),
                DB.getMeta(PAUSE_KEY).catch(() => null),
                typeof DB.getLease === 'function' ? DB.getLease().catch(() => null) : Promise.resolve(null),
            ]);
            last = {
                items: Array.isArray(items) ? items : [],
                paused: !!(pausedRecord && pausedRecord.value),
                status: (typeof QueueRunner !== 'undefined' && QueueRunner) ? QueueRunner.status() : null,
                lease: lease || null,
            };

            // Uma conclusão no banco também atualiza Biblioteca/Desempenho sem
            // recarregar a página. A assinatura evita re-render repetido.
            const signature = last.items
                .filter(item => item.state === 'done')
                .map(item => item.key)
                .sort()
                .join('|');
            if (doneSignature !== null && signature && signature !== doneSignature
                && typeof reloadGames === 'function') {
                reloadGames().catch(() => {});
            }
            doneSignature = signature;

            renderBadge();
            if (typeof State !== 'undefined' && State.view === 'analyses') render();
        } catch (error) {
            console.warn('Central de Análises: falha ao ler a fila.', error);
        } finally {
            refreshing = false;
            if (refreshAgain) {
                refreshAgain = false;
                scheduleRefresh(80);
            }
        }
    }

    /** Throttle: eventos frequentes de progresso não disparam um render por posição. */
    function scheduleRefresh(delay) {
        if (refreshTimer) return;
        const wait = Number.isFinite(Number(delay)) && Number(delay) >= 0 ? Number(delay) : THROTTLE_MS;
        refreshTimer = setTimeout(() => {
            refreshTimer = null;
            refresh().catch(() => {});
        }, wait);
    }

    async function askConfirm(title, message, confirmLabel) {
        if (typeof confirmAction === 'function') return confirmAction(title, message, confirmLabel);
        return window.confirm(message);
    }

    async function startQueue() {
        try {
            const before = QueueRunner.status();
            const result = await QueueRunner.start();
            await refresh();
            if (result && result.role === 'observer') {
                notify('Outra aba está executando a fila. Esta aba vai acompanhar em tempo real.', 'info');
            } else if (before.running) {
                notify('A fila já está em execução.', 'info');
            } else {
                notify('Fila iniciada. O item atual aparece como Rodando.', 'success');
            }
            return result;
        } catch (error) {
            notify('Não foi possível iniciar a fila: ' + (error.message || error), 'error');
            return null;
        }
    }

    async function pauseQueue() {
        try {
            const result = await QueueRunner.pause();
            if (!result || !result.ok) {
                // Aba observadora: grava a pausa global para a dona parar ao
                // terminar o item atual. O start() explícito limpa a pausa.
                await DB.saveMeta(PAUSE_KEY, now());
                notify('Pausa solicitada. A aba que executa a fila para ao concluir o item atual.', 'info');
            } else {
                notify('Fila pausada. O checkpoint do item atual foi preservado.', 'info');
            }
            await refresh();
            return result;
        } catch (error) {
            notify('Não foi possível pausar a fila: ' + (error.message || error), 'error');
            return null;
        }
    }

    async function stopQueue() {
        try {
            const status = QueueRunner.status();
            if (!status.running && !status.itemKey) {
                notify('Não há execução em andamento.', 'info');
                return;
            }
            const ok = await askConfirm(
                'Parar análise',
                'Parar o item em execução? Ele ficará como interrompido e poderá ser retomado do checkpoint.',
                'Parar'
            );
            if (!ok) return;
            await QueueRunner.stop();
            await refresh();
            notify('Execução interrompida. Use Retomar para continuar do checkpoint.', 'info');
        } catch (error) {
            notify('Não foi possível parar a fila: ' + (error.message || error), 'error');
        }
    }

    async function clearDone() {
        const done = (last.items || []).filter(item => item.state === 'done' || item.state === 'canceled');
        if (!done.length) {
            notify('Não há itens concluídos para limpar.', 'info');
            return;
        }
        const ok = await askConfirm(
            'Limpar concluídas',
            `Remover ${done.length} item(ns) concluído(s) da fila? As análises já gravadas são mantidas.`,
            'Limpar'
        );
        if (!ok) return;
        await DB.clearQueue({ states: ['done', 'canceled'] });
        await refresh();
        notify(`${done.length} item(ns) removido(s) da fila.`, 'success');
    }

    async function cancelPending() {
        const targets = (last.items || []).filter(item => (
            item.state === 'pending' || item.state === 'paused' || item.state === 'interrupted'
        ));
        if (!targets.length) {
            notify('Não há itens pendentes para cancelar.', 'info');
            return;
        }
        const ok = await askConfirm(
            'Cancelar pendentes',
            `Cancelar ${targets.length} item(ns) que ainda não estão em execução? A fila em andamento não é afetada.`,
            'Cancelar itens'
        );
        if (!ok) return;
        let canceled = 0;
        for (const item of targets) {
            try {
                const fresh = await DB.getQueueItem(item.key);
                if (!fresh || fresh.state === 'running') continue;
                const updated = await DB.updateQueueItem(item.key, {
                    state: 'canceled',
                    lastError: null,
                    finishedAt: now(),
                    leaseOwner: null,
                    heartbeatAt: null,
                });
                if (!updated) continue;
                await DB.deleteCheckpoint(item.key).catch(() => {});
                canceled++;
            } catch (error) {
                console.warn('Falha ao cancelar item da fila.', item.key, error);
            }
        }
        await refresh();
        notify(`${canceled} item(ns) cancelado(s).`, canceled ? 'info' : 'warning');
    }

    async function cancelItem(key) {
        try {
            const fresh = await DB.getQueueItem(key);
            if (!fresh) return;
            if (fresh.state === 'running') {
                notify('Pare a execução antes de cancelar este item.', 'warning');
                return;
            }
            if (fresh.state === 'done' || fresh.state === 'canceled') return;
            const ok = await askConfirm(
                'Cancelar item',
                'Cancelar este item da fila? O checkpoint parcial será descartado; análises já concluídas não são apagadas.',
                'Cancelar item'
            );
            if (!ok) return;
            await DB.updateQueueItem(key, {
                state: 'canceled',
                lastError: null,
                finishedAt: now(),
                leaseOwner: null,
                heartbeatAt: null,
            });
            await DB.deleteCheckpoint(key).catch(() => {});
            await refresh();
            notify('Item cancelado.', 'info');
        } catch (error) {
            notify('Não foi possível cancelar o item: ' + (error.message || error), 'error');
        }
    }

    async function retryItem(key) {
        try {
            const fresh = await DB.getQueueItem(key);
            if (!fresh || fresh.state !== 'error') return;
            // O checkpoint de erro é mantido de propósito: se ainda descrever
            // esta partida/build/profundidade, a retomada continua de onde parou.
            await DB.updateQueueItem(key, {
                state: 'pending',
                lastError: null,
                finishedAt: null,
                leaseOwner: null,
                heartbeatAt: null,
            });
            await QueueRunner.start();
            await refresh();
            notify('Item reenfileirado. A retomada usa o checkpoint se ele for válido.', 'info');
        } catch (error) {
            notify('Não foi possível tentar novamente: ' + (error.message || error), 'error');
        }
    }

    async function removeItem(key) {
        try {
            const fresh = await DB.getQueueItem(key);
            if (!fresh || (fresh.state !== 'done' && fresh.state !== 'canceled')) return;
            await DB.removeQueueItem(key);
            await refresh();
            notify('Registro removido da fila. A análise permanece na biblioteca.', 'success');
        } catch (error) {
            notify('Não foi possível remover o registro: ' + (error.message || error), 'error');
        }
    }

    async function openQueued(item) {
        if (!item || !item.gameId || typeof openGame !== 'function') return;
        await openGame(item.gameId);
        if (typeof setView === 'function') setView('game');
    }

    function onListClick(event) {
        const button = event.target.closest('[data-queue-action]');
        if (!button) return;
        const key = button.dataset.key;
        const action = button.dataset.queueAction;
        const run = async () => {
            if (action === 'open') {
                const item = await DB.getQueueItem(key);
                await openQueued(item);
                return;
            }
            if (action === 'retry') return retryItem(key);
            if (action === 'cancel') return cancelItem(key);
            if (action === 'remove') return removeItem(key);
            return undefined;
        };
        run().catch(error => notify(error.message || String(error), 'error'));
    }

    function bind() {
        const on = (id, handler) => {
            const node = el(id);
            if (node) node.addEventListener('click', event => {
                event.preventDefault();
                handler().catch(error => notify(error.message || String(error), 'error'));
            });
        };
        on('queueStartBtn', startQueue);
        on('queuePauseBtn', pauseQueue);
        on('queueStopBtn', stopQueue);
        on('queueClearDoneBtn', clearDone);
        on('queueCancelPendingBtn', cancelPending);
        on('queueEnqueueAllBtn', enqueuePending);

        const list = el('queueList');
        if (list) list.addEventListener('click', onListClick);

        const filters = el('queueFilters');
        if (filters) filters.addEventListener('click', event => {
            const button = event.target.closest('[data-queue-filter]');
            if (!button) return;
            filter = button.dataset.queueFilter || 'all';
            render();
        });

        const empty = el('queueEmptyLibraryBtn');
        if (empty) empty.addEventListener('click', () => {
            if (typeof setView === 'function') setView('library');
        });
    }

    function init() {
        if (initialized) return;
        initialized = true;
        bind();

        if (typeof BroadcastChannel !== 'undefined') {
            try {
                channel = new BroadcastChannel(CHANNEL_NAME);
                channel.onmessage = () => scheduleRefresh(120);
            } catch (error) {
                channel = null;
            }
        }

        if (typeof window !== 'undefined' && window.addEventListener) {
            window.addEventListener('storage', event => {
                if (event.key === EVENT_KEY) scheduleRefresh(120);
            });
        }

        if (typeof document !== 'undefined' && document.addEventListener) {
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden) scheduleRefresh(0);
            });
        }

        pollTimer = setInterval(() => {
            if (typeof document !== 'undefined' && document.hidden) return;
            scheduleRefresh(0);
        }, POLL_MS);

        refresh().catch(() => {});
    }

    function activate() {
        init();
        scheduleRefresh(0);
    }

    /**
     * Enfileira partidas para a profundidade/build atuais e inicia o executor.
     * Itens já analisados nessa combinação são ignorados; duplicatas ativas
     * são deduplicadas dentro da transação por `DB.enqueueAnalyses`.
     */
    async function enqueueGames(scope, options) {
        const opts = options || {};
        if (typeof Engine === 'undefined' || !Engine.supported()) {
            notify('A análise em lote precisa que você abra o projeto com iniciar.bat.', 'warning');
            return { added: 0, skipped: 0, invalid: 0, rejected: 0, capReached: false };
        }
        if (typeof State === 'undefined' || !Array.isArray(State.games) || !State.games.length) {
            notify('Não há partidas para analisar.', 'warning');
            return { added: 0, skipped: 0, invalid: 0, rejected: 0, capReached: false };
        }

        const depth = Number(Settings.get().depth);
        const build = Engine.BUILD_ID;
        const selected = Array.isArray(scope) && scope.length ? scope : State.games;
        const pending = selected.filter(game => {
            if (!game.analyzedDepth || game.analyzedDepth < depth) return true;
            return (game.analyzedBuild || '') !== build;
        });
        if (!pending.length) {
            notify(`Todas as partidas selecionadas já foram analisadas na profundidade ${depth}.`, 'success');
            return { added: 0, skipped: 0, invalid: 0, rejected: 0, capReached: false };
        }

        const dataById = new Map();
        try {
            const records = await DB.getAll('data');
            (records || []).forEach(record => dataById.set(record.id, record));
        } catch (error) {
            // Sem os registros de lances o item entra sem total; o executor
            // descobre o total ao abrir a partida.
        }

        const entries = pending.map(game => {
            const data = dataById.get(game.id);
            return {
                gameId: game.id,
                depth,
                engineBuild: build,
                positionsTotal: data && Array.isArray(data.moves) ? data.moves.length + 1 : null,
            };
        });

        let result;
        try {
            result = await DB.enqueueAnalyses(entries);
        } catch (error) {
            notify('Não foi possível adicionar à fila: ' + (error.message || error), 'error');
            return { added: 0, skipped: 0, invalid: 0, rejected: 0, capReached: false };
        }

        const parts = [`${result.added} partida(s) adicionada(s) à fila`];
        if (result.skipped) parts.push(`${result.skipped} já estava(m) na fila`);
        if (result.rejected) {
            const limit = (typeof Queue !== 'undefined' && Queue.MAX_ITEMS) ? Queue.MAX_ITEMS : 200;
            parts.push(`${result.rejected} recusada(s) pelo limite de ${limit}`);
        }
        if (result.invalid) parts.push(`${result.invalid} inválida(s)`);
        notify(parts.join(' · ') + '.', result.added ? 'success' : 'warning');
        if (result.capReached) {
            notify('Limite de itens ativos atingido. Conclua ou cancele itens antes de adicionar mais.', 'warning');
        }

        if (opts.start !== false && result.added) {
            try {
                const started = await QueueRunner.start();
                if (started && started.role === 'observer') {
                    notify('Outra aba já executa a fila; esta aba vai acompanhar.', 'info');
                }
            } catch (error) {
                notify('Itens enfileirados, mas não foi possível iniciar: ' + (error.message || error), 'error');
            }
        }

        if (opts.goToView !== false && typeof setView === 'function') setView('analyses');
        await refresh();
        return result;
    }

    function enqueuePending() {
        return enqueueGames(null, { start: true, goToView: true });
    }

    return {
        init,
        activate,
        refresh,
        scheduleRefresh,
        enqueueGames,
        enqueuePending,
        start: startQueue,
        pause: pauseQueue,
        stop: stopQueue,
        clearDone,
        cancelPending,
        cancelItem,
        retryItem,
        removeItem,
        render,
        // Funções puras expostas para testes sem navegador.
        stateMeta,
        matchesFilter,
        progressOf,
        summarize,
        estimateRemaining,
        formatDuration,
        STATES,
        FILTERS,
    };
})();

if (typeof window !== 'undefined') window.QueueUI = QueueUI;
