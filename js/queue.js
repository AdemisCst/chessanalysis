/* ========================================================================
   ARQUIVO: js/queue.js
   DESCRIÇÃO: Regras puras da fila de análise (Fase 3, etapa M1).
   - Não conhece IndexedDB, DOM, motor nem estado global.
   - `DB.enqueueAnalyses` usa `Queue.plan` dentro de uma transação; os testes
     carregam este arquivo em `vm` sem navegador.

   Estados:
     pending      aguardando a vez
     running      em execução (um por aba, garantido pelo lease na M4)
     paused       pausada pelo usuário
     interrupted  aba fechada/recarregada ou lease expirado
     error        falhou; exige "Tentar novamente" (nunca automático)
     done         concluída (terminal)
     canceled     cancelada pelo usuário (terminal)
   ======================================================================== */

const Queue = (() => {
    /** Teto de itens ativos. Done/canceled não ocupam vaga. */
    const MAX_ITEMS = 200;

    const ACTIVE_STATES = ['pending', 'running', 'paused', 'interrupted', 'error'];
    const TERMINAL_STATES = ['done', 'canceled'];

    function isActive(item) {
        return !!item && ACTIVE_STATES.indexOf(item.state) !== -1;
    }

    function isTerminal(item) {
        return !!item && TERMINAL_STATES.indexOf(item.state) !== -1;
    }

    /**
     * Normaliza uma entrada vinda da interface. A `key` já deve ter sido
     * calculada por `DB.queueKey` — a fila não duplica a regra de identidade.
     * Entrada sem chave, partida ou profundidade válida é descartada.
     */
    function normalize(entry, now, index) {
        if (!entry || !entry.key || !entry.gameId) return null;
        const depth = Number(entry.depth);
        if (!Number.isFinite(depth) || depth < 1) return null;
        const rawTotal = entry.positionsTotal;
        const total = rawTotal === null || rawTotal === undefined || rawTotal === '' ? NaN : Number(rawTotal);
        const stamp = Number(now) + Number(index || 0);
        return {
            key: String(entry.key),
            gameId: String(entry.gameId),
            depth: Math.round(depth),
            engineBuild: entry.engineBuild ? String(entry.engineBuild) : null,
            state: 'pending',
            priority: stamp,
            attempts: 0,
            lastError: null,
            createdAt: stamp,
            updatedAt: stamp,
            startedAt: null,
            finishedAt: null,
            positionsDone: 0,
            positionsTotal: Number.isFinite(total) && total >= 0 ? Math.round(total) : null,
            leaseOwner: null,
            heartbeatAt: null,
        };
    }

    /**
     * Decide o que entra na fila: deduplica (inclusive dentro do próprio lote)
     * e respeita o teto de itens ativos. Não grava nada — devolve o plano para
     * `DB.enqueueAnalyses` aplicar na transação.
     *
     * `active` deve conter só itens ativos (o chamador já filtra); a função
     * refiltra por segurança.
     */
    function plan(active, candidates, max) {
        const limit = Number.isFinite(Number(max)) ? Number(max) : MAX_ITEMS;
        const activeList = Array.isArray(active) ? active.filter(isActive) : [];
        const known = new Set(activeList.map(item => item.key));
        const accepted = [];
        const skipped = [];
        const invalid = [];
        const rejected = [];
        const now = Date.now();

        (Array.isArray(candidates) ? candidates : []).forEach((entry, index) => {
            const item = normalize(entry, now, index);
            if (!item) { invalid.push(entry); return; }
            if (known.has(item.key)) { skipped.push(item.key); return; }
            if (activeList.length + accepted.length >= limit) { rejected.push(item.key); return; }
            known.add(item.key);
            accepted.push(item);
        });

        return {
            accepted,
            skipped,
            invalid,
            rejected,
            capReached: rejected.length > 0,
            limit,
        };
    }

    return {
        MAX_ITEMS,
        ACTIVE_STATES,
        TERMINAL_STATES,
        isActive,
        isTerminal,
        normalize,
        plan,
    };
})();

window.Queue = Queue;
