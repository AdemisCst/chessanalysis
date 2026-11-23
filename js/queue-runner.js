/* ========================================================================
   ARQUIVO: js/queue-runner.js
   DESCRIÇÃO: Executor da fila de análise (Fase 3, etapa M4).
   - Uma aba dona por vez, coordenada por lease em `meta` + BroadcastChannel.
   - Heartbeat de 5 s renova o lease de 20 s.
   - Checkpoint a cada 4 posições, gravado junto do progresso da fila.
   - Nunca grava análise parcial em `analysis`: só `DB.finishQueueItem`, na
     mesma transação, grava resultado completo + metadados + `done`.

   Não há interface aqui: a view da Central de Análises é a M5.
   ======================================================================== */

const QueueRunner = (() => {
    const CHANNEL_NAME = 'acervo64-queue';
    const EVENT_KEY = 'acervo64-queue-event';
    const PAUSE_META_KEY = 'analysisQueuePaused';
    const WATCHDOG_MS = 2000;

    const tabId = (typeof crypto !== 'undefined' && crypto.randomUUID)
        ? crypto.randomUUID()
        : 'tab-' + Math.random().toString(36).slice(2) + Date.now().toString(36);

    let channel = null;
    let listening = false;
    let running = false;
    let role = 'idle'; // idle | owner | observer
    let pumping = false;
    let current = null;
    let requestedStop = null; // 'paused' | 'interrupted'
    let heartbeatTimer = null;
    let watchdogTimer = null;
    let claiming = false;

    const WAKE_EVENTS = ['lease-released', 'queue-idle', 'item-done', 'item-error', 'queue-changed', 'lease-lost'];

    function now() {
        return Date.now();
    }

    /**
     * Pausa da fila é global. Sem isso, a aba observadora assumiria o lease
     * depois que a dona pausasse e retomaria sozinha o item pausado.
     */
    async function isQueuePaused() {
        const record = await DB.getMeta(PAUSE_META_KEY);
        return !!(record && record.value);
    }

    async function setQueuePaused(paused) {
        await DB.saveMeta(PAUSE_META_KEY, paused ? now() : null);
    }

    function fenAt(data, index) {
        const moves = data.moves || [];
        if (index <= 0) return data.startFen;
        const move = moves[index - 1];
        return move ? move.fen : null;
    }

    function safeMessage(error) {
        const name = error && error.name;
        const text = String((error && error.message) || '');
        if (name === 'QuotaExceededError' || /quota/i.test(text)) {
            return 'Armazenamento cheio. Exporte um backup e remova partidas.';
        }
        if (/indexeddb|progresso|banco/i.test(text)) {
            return 'Falha ao salvar o progresso. Libere espaço e retome.';
        }
        if (/stockfish|worker|motor/i.test(text)) {
            return 'Não foi possível iniciar o Stockfish. Recarregue a página.';
        }
        // Sem stack e sem conteúdo do PGN: mensagem curta e acionável.
        return text ? text.slice(0, 160) : 'Falha inesperada na análise.';
    }

    /* ---------- BroadcastChannel (com fallback para evento storage) ---------- */
    function initChannel() {
        if (listening) return;
        listening = true;
        if (typeof BroadcastChannel !== 'undefined') {
            try {
                channel = new BroadcastChannel(CHANNEL_NAME);
                channel.onmessage = event => handleEvent(event.data);
            } catch (error) {
                channel = null;
            }
        }
        window.addEventListener('storage', event => {
            if (event.key !== EVENT_KEY || !event.newValue) return;
            try { handleEvent(JSON.parse(event.newValue)); } catch (error) { /* ignora */ }
        });
    }

    function announce(type, extra) {
        const message = Object.assign({ type, tabId, at: now() }, extra || {});
        if (channel) {
            try { channel.postMessage(message); return; } catch (error) { /* cai no storage */ }
        }
        try {
            localStorage.setItem(EVENT_KEY, JSON.stringify(Object.assign({}, message, {
                nonce: Math.random().toString(36).slice(2),
            })));
        } catch (error) { /* sem canal disponível */ }
    }

    function handleEvent(message) {
        if (!message || message.tabId === tabId) return;
        if (message.type === 'lease-taken') {
            if (role === 'owner') handleLeaseLost();
            return;
        }
        if (role === 'observer' && !current && WAKE_EVENTS.indexOf(message.type) !== -1) {
            takeOver();
        }
    }

    /* ---------- lease / watchdog ---------- */
    async function takeOver() {
        if (!running || role !== 'observer' || current || claiming) return false;
        claiming = true;
        try {
            const claimed = await DB.claimLease(tabId, null, now(), Queue.LEASE_MS);
            if (!claimed.ok) return false;
            // Pausa global: assumir o lease não significa retomar. Só um
            // `start()` explícito limpa a pausa.
            if (await isQueuePaused()) {
                await DB.releaseLease(tabId);
                clearWatchdog();
                clearHeartbeat();
                role = 'idle';
                running = false;
                return false;
            }
            clearWatchdog();
            role = 'owner';
            announce('lease-taken');
            runPump();
            return true;
        } finally {
            claiming = false;
        }
    }

    function startWatchdog() {
        if (watchdogTimer) return;
        watchdogTimer = setInterval(() => { takeOver().catch(() => {}); }, WATCHDOG_MS);
    }

    function clearWatchdog() {
        if (watchdogTimer) clearInterval(watchdogTimer);
        watchdogTimer = null;
    }

    function clearHeartbeat() {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = null;
    }

    function startHeartbeat(itemKey) {
        clearHeartbeat();
        heartbeatTimer = setInterval(async () => {
            if (!current) return;
            try {
                const result = await DB.renewLease(tabId, itemKey, now());
                if (!result.ok) {
                    handleLeaseLost();
                    current.controller.abort();
                }
            } catch (error) {
                // Falha de IndexedDB no heartbeat: para de gravar e tenta de
                // novo como observador; o checkpoint já gravado permanece.
                handleLeaseLost();
                current.controller.abort();
            }
        }, Queue.HEARTBEAT_MS);
    }

    function handleLeaseLost() {
        if (role !== 'observer') announce('lease-lost', { itemKey: current ? current.item.key : null });
        role = 'observer';
        clearHeartbeat();
        startWatchdog();
    }

    /* ---------- checkpoint ---------- */
    function checkpointFor(run, resumeAt) {
        const positions = run.positions.slice(0, resumeAt);
        return {
            key: run.item.key,
            gameId: run.item.gameId,
            depth: run.item.depth,
            engineBuild: Engine.BUILD_ID,
            startFen: run.data.startFen,
            movesLength: (run.data.moves || []).length,
            positions,
            resumeAt,
            fenAtResume: resumeAt < run.total ? fenAt(run.data, resumeAt) : null,
        };
    }

    async function persistCheckpoint(run) {
        if (!run || !run.data || run.done <= 0) return { ok: true };
        return DB.saveQueueProgress(run.item.key, tabId, checkpointFor(run, run.done), {
            positionsDone: run.done,
        });
    }

    /* ---------- execução de um item ---------- */
    async function runItem(item) {
        const controller = new AbortController();
        const run = {
            item,
            controller,
            data: null,
            positions: [],
            done: 0,
            total: Number(item.positionsTotal || 0) || 0,
        };
        current = run;
        requestedStop = null;
        startHeartbeat(item.key);
        announce('item-start', { itemKey: item.key });

        try {
            const game = await DB.get('games', item.gameId);
            const data = await DB.get('data', item.gameId);
            if (!game || !data) {
                await DB.settleQueueItem(item.key, tabId, 'error', {
                    message: 'Partida removida da biblioteca.',
                });
                announce('item-error', { itemKey: item.key, message: 'Partida removida da biblioteca.' });
                return;
            }
            if (item.engineBuild && item.engineBuild !== Engine.BUILD_ID) {
                await DB.settleQueueItem(item.key, tabId, 'error', {
                    message: 'Este item pede outro build do Stockfish.',
                });
                announce('item-error', { itemKey: item.key, message: 'Build indisponível.' });
                return;
            }

            run.data = data;
            const moves = data.moves || [];
            run.total = moves.length + 1;

            // Retomada: só aceita checkpoint que descreve exatamente esta
            // partida, este build e esta profundidade. Qualquer divergência
            // descarta o checkpoint e recomeça — nunca lança erro fatal.
            let resumeAt = 0;
            let seeds = [];
            const checkpoint = await DB.getCheckpoint(item.key);
            if (checkpoint) {
                const candidate = Number(checkpoint.resumeAt);
                const expectedFen = Number.isInteger(candidate) && candidate >= 0 && candidate < run.total
                    ? fenAt(data, candidate)
                    : null;
                const check = Queue.validateCheckpoint(checkpoint, {
                    key: item.key,
                    gameId: item.gameId,
                    depth: item.depth,
                    engineBuild: Engine.BUILD_ID,
                    startFen: data.startFen,
                    movesLength: moves.length,
                    total: run.total,
                    fenAtResume: expectedFen,
                });
                if (check.ok) {
                    resumeAt = check.resumeAt;
                    seeds = check.positions;
                } else {
                    await DB.deleteCheckpoint(item.key);
                    announce('checkpoint-reset', { itemKey: item.key, reason: check.reason });
                }
            }

            run.positions = seeds.slice();
            run.done = resumeAt;
            if (resumeAt > 0) {
                const synced = await DB.saveQueueProgress(item.key, tabId, checkpointFor(run, resumeAt), {
                    positionsDone: resumeAt,
                });
                if (!synced.ok) {
                    handleLeaseLost();
                    return;
                }
                announce('item-progress', { itemKey: item.key, done: resumeAt, total: run.total, resumed: true });
            }

            const analysis = await Engine.analyzeGame(game, data, {
                depth: item.depth,
                signal: controller.signal,
                startIndex: resumeAt,
                seedPositions: seeds,
                onPosition: async ({ index, position, done }) => {
                    run.positions[index] = position;
                    run.done = done;
                    if (done % Queue.CHECKPOINT_EVERY === 0 || done === run.total) {
                        const saved = await DB.saveQueueProgress(
                            item.key,
                            tabId,
                            checkpointFor(run, done),
                            { positionsDone: done }
                        );
                        if (!saved.ok) {
                            const lost = new Error('lease-lost');
                            lost.leaseLost = true;
                            throw lost;
                        }
                    }
                    announce('item-progress', { itemKey: item.key, done, total: run.total });
                },
            });

            analysis.key = item.key;
            game.analysisSummary = analysis.summary;
            game.analyzedDepth = Math.max(game.analyzedDepth || 0, item.depth);
            game.analyzedBuild = analysis.engineBuild;
            if (window.Tags && typeof Tags.apply === 'function') {
                try { Tags.apply(game, analysis, moves); } catch (error) { /* tags são acessórias */ }
            }

            const finished = await DB.finishQueueItem(item.key, tabId, analysis, game);
            if (!finished.ok) {
                handleLeaseLost();
                return;
            }
            announce('item-done', { itemKey: item.key, gameId: item.gameId });
        } catch (error) {
            const stop = requestedStop;
            requestedStop = null;

            if (stop === 'paused' || stop === 'interrupted') {
                try {
                    await persistCheckpoint(run);
                    await DB.settleQueueItem(item.key, tabId, stop, {
                        message: stop === 'paused' ? 'pausada pelo usuário' : 'interrompida',
                        checkpoint: run.data ? checkpointFor(run, run.done) : null,
                    });
                } catch (dbError) {
                    // Mesmo sem persistir, não inventa conclusão.
                }
                await DB.releaseLease(tabId).catch(() => {});
                role = 'idle';
                running = false;
                clearWatchdog();
                announce(stop === 'paused' ? 'queue-paused' : 'queue-interrupted', { itemKey: item.key });
                return;
            }

            if ((error && (error.name === 'AbortError' || error.leaseLost)) || role === 'observer') {
                handleLeaseLost();
                return;
            }

            const message = safeMessage(error);
            try {
                await DB.settleQueueItem(item.key, tabId, 'error', {
                    message,
                    checkpoint: run.data ? checkpointFor(run, run.done) : null,
                });
            } catch (dbError) {
                // Falha de persistência: sai do item e libera a aba.
                await DB.releaseLease(tabId).catch(() => {});
                role = 'idle';
                running = false;
            }
            announce('item-error', { itemKey: item.key, message });
        } finally {
            clearHeartbeat();
            current = null;
        }
    }

    /* ---------- laço ---------- */
    async function pump() {
        if (pumping) return;
        pumping = true;
        try {
            while (running && role === 'owner') {
                if (await isQueuePaused()) {
                    await DB.releaseLease(tabId);
                    role = 'idle';
                    running = false;
                    announce('queue-paused');
                    return;
                }
                const lease = await DB.getLease();
                if (!lease || lease.tabId !== tabId || !Queue.isLeaseActive(lease, now())) {
                    handleLeaseLost();
                    return;
                }
                const items = await DB.getQueue();
                const next = Queue.nextItem(items, now());
                if (!next) {
                    await DB.releaseLease(tabId);
                    role = 'idle';
                    running = false;
                    announce('queue-idle');
                    return;
                }
                const started = await DB.startQueueItem(next.key, tabId, now());
                if (!started.ok) {
                    if (started.reason === 'missing') continue;
                    handleLeaseLost();
                    return;
                }
                await runItem(started.item);
                if (!running) return;
            }
        } catch (error) {
            console.error('Fila de análise interrompida:', error);
            await DB.releaseLease(tabId).catch(() => {});
            role = 'idle';
            running = false;
        } finally {
            pumping = false;
            // Se start()/takeOver() chegou enquanto o laço anterior ainda
            // fechava, retoma agora em vez de ficar dono sem executor.
            if (running && role === 'owner') runPump();
        }
    }

    function runPump() {
        pump().catch(() => {});
    }

    /* ---------- API pública (UI usa na M5) ---------- */
    async function start() {
        if (running) return { started: true, role, tabId };
        initChannel();
        running = true;
        const claimed = await DB.claimLease(tabId, null, now(), Queue.LEASE_MS);
        if (!claimed.ok) {
            role = 'observer';
            startWatchdog();
            announce('lease-seen', { owner: claimed.lease ? claimed.lease.tabId : null });
            return { started: true, role, tabId };
        }
        role = 'owner';
        clearWatchdog();
        try {
            await setQueuePaused(false);
        } catch (error) {
            await DB.releaseLease(tabId).catch(() => {});
            role = 'idle';
            running = false;
            throw error;
        }
        announce('lease-taken');
        runPump();
        return { started: true, role, tabId };
    }

    async function pause() {
        if (role !== 'owner') return { ok: false, reason: 'not-owner' };
        await setQueuePaused(true);
        if (!current) {
            running = false;
            clearWatchdog();
            clearHeartbeat();
            await DB.releaseLease(tabId).catch(() => {});
            role = 'idle';
            announce('queue-paused');
            return { ok: true };
        }
        requestedStop = 'paused';
        current.controller.abort();
        return { ok: true, itemKey: current.item.key };
    }

    async function stop() {
        if (!running && !current) return { ok: true };
        requestedStop = 'interrupted';
        running = false;
        if (current) current.controller.abort();
        clearWatchdog();
        clearHeartbeat();
        await DB.releaseLease(tabId).catch(() => {});
        role = 'idle';
        return { ok: true };
    }

    function status() {
        return {
            tabId,
            running,
            role,
            itemKey: current ? current.item.key : null,
            done: current ? current.done : 0,
            total: current ? current.total : 0,
        };
    }

    async function resume() {
        return start();
    }

    window.addEventListener('pagehide', () => {
        if (!current) {
            DB.releaseLease(tabId).catch(() => {});
            return;
        }
        requestedStop = 'interrupted';
        current.controller.abort();
        DB.releaseLease(tabId).catch(() => {});
    });

    return {
        start,
        stop,
        pause,
        resume,
        status,
        tabId,
    };
})();

window.QueueRunner = QueueRunner;
