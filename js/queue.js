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

    /* Coordenação entre abas (M4). O lease vale 20 s e é renovado a cada 5 s. */
    const LEASE_MS = 20000;
    const HEARTBEAT_MS = 5000;
    const CHECKPOINT_EVERY = 4;

    const ACTIVE_STATES = ['pending', 'running', 'paused', 'interrupted', 'error'];
    const TERMINAL_STATES = ['done', 'canceled'];
    const RUNNABLE_STATES = ['pending', 'interrupted', 'paused'];

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

    /** Lease válido quando o último heartbeat tem menos de 20 s. */
    function isLeaseActive(lease, now) {
        if (!lease || !lease.tabId) return false;
        const beat = Number(lease.heartbeatAt);
        if (!Number.isFinite(beat)) return false;
        return (Number(now) - beat) < LEASE_MS;
    }

    /**
     * Próximo item executável: `pending`, `interrupted` ou `paused`, em ordem
     * de prioridade. `done`/`canceled` ficam de fora e `error` só volta por
     * retry manual (o chamador muda o estado antes).
     */
    function nextItem(items, now) {
        const stamp = Number.isFinite(Number(now)) ? Number(now) : Date.now();
        return (Array.isArray(items) ? items : [])
            .filter(item => RUNNABLE_STATES.indexOf(item.state) !== -1)
            .filter(item => {
                if (!item.leaseOwner) return true;
                return !isLeaseActive({ tabId: item.leaseOwner, heartbeatAt: item.heartbeatAt }, stamp);
            })
            .sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt))[0] || null;
    }

    /**
     * Valida um checkpoint contra o alvo atual. Devolve `{ok, resumeAt,
     * positions}` ou `{ok:false, empty, reason}`. Checkpoint ausente não é
     * erro: significa começar do zero (`empty: true`).
     *
     * `expected.fenAtResume` é a FEN da posição `resumeAt` (ou `null` quando o
     * checkpoint já cobre a partida inteira).
     */
    function validateCheckpoint(checkpoint, expected) {
        const exp = expected || {};
        if (!checkpoint || !checkpoint.key) {
            return { ok: false, empty: true, reason: 'checkpoint ausente' };
        }
        const fail = reason => ({ ok: false, empty: false, reason });
        if (checkpoint.key !== exp.key) return fail('chave do checkpoint');
        if (checkpoint.gameId !== exp.gameId) return fail('partida do checkpoint');
        if (Number(checkpoint.depth) !== Number(exp.depth)) return fail('profundidade do checkpoint');
        if ((checkpoint.engineBuild || null) !== (exp.engineBuild || null)) return fail('build do checkpoint');
        if ((checkpoint.startFen || '') !== (exp.startFen || '')) return fail('posição inicial');
        if (Number(checkpoint.movesLength) !== Number(exp.movesLength)) return fail('tamanho da partida');

        const total = Number(exp.total);
        const resumeAt = Number(checkpoint.resumeAt);
        if (!Number.isInteger(resumeAt) || resumeAt < 0 || resumeAt > total) {
            return fail('ponto de retomada');
        }
        const positions = Array.isArray(checkpoint.positions) ? checkpoint.positions : [];
        if (positions.length < resumeAt) return fail('posições insuficientes');
        if (positions.length > total) return fail('posições excedentes');
        if (exp.fenAtResume !== undefined && (checkpoint.fenAtResume || null) !== (exp.fenAtResume || null)) {
            return fail('FEN de retomada');
        }
        return { ok: true, empty: false, resumeAt, positions: positions.slice(0, resumeAt) };
    }

    return {
        MAX_ITEMS,
        LEASE_MS,
        HEARTBEAT_MS,
        CHECKPOINT_EVERY,
        ACTIVE_STATES,
        TERMINAL_STATES,
        RUNNABLE_STATES,
        isActive,
        isTerminal,
        isLeaseActive,
        normalize,
        plan,
        nextItem,
        validateCheckpoint,
    };
})();

window.Queue = Queue;
