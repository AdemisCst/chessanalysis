/* ========================================================================
   ARQUIVO: js/storage.js
   DESCRIÇÃO: Persistência local.
   - IndexedDB: partidas (metadados), dados do PGN (lances/FEN), análises,
     textos da IA e chaves auxiliares.
   - localStorage: preferências (tema, modelo, profundidade etc.).
   ======================================================================== */

const DB = (() => {
    const NAME = 'acervo64';
    // v2 (Fase 3/M1): acrescenta `queue` e `checkpoints`. O upgrade é aditivo:
    // nenhum store existente é recriado ou limpo.
    const VERSION = 2;
    let dbPromise = null;

    function open() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            if (!window.indexedDB) {
                reject(new Error('Este navegador não suporta IndexedDB.'));
                return;
            }

            function upgrade(db) {
                if (!db.objectStoreNames.contains('games')) {
                    const games = db.createObjectStore('games', { keyPath: 'id' });
                    ['dateISO', 'result', 'white', 'black', 'eco', 'event', 'year', 'favorite', 'maxElo', 'importedAt']
                        .forEach(name => games.createIndex(name, name, { unique: false }));
                }
                if (!db.objectStoreNames.contains('data')) {
                    db.createObjectStore('data', { keyPath: 'id' });
                }
                if (!db.objectStoreNames.contains('analysis')) {
                    const analysis = db.createObjectStore('analysis', { keyPath: 'key' });
                    analysis.createIndex('gameId', 'gameId', { unique: false });
                }
                if (!db.objectStoreNames.contains('ai')) {
                    const ai = db.createObjectStore('ai', { keyPath: 'key' });
                    ai.createIndex('gameId', 'gameId', { unique: false });
                }
                if (!db.objectStoreNames.contains('meta')) {
                    db.createObjectStore('meta', { keyPath: 'key' });
                }
                // Fase 3: fila de análise e checkpoints ficam fora de
                // `analysis` de propósito — análise parcial nunca entra nas
                // estatísticas nem no gráfico.
                if (!db.objectStoreNames.contains('queue')) {
                    const queue = db.createObjectStore('queue', { keyPath: 'key' });
                    queue.createIndex('state', 'state', { unique: false });
                    queue.createIndex('priority', 'priority', { unique: false });
                    queue.createIndex('gameId', 'gameId', { unique: false });
                }
                if (!db.objectStoreNames.contains('checkpoints')) {
                    const checkpoints = db.createObjectStore('checkpoints', { keyPath: 'key' });
                    checkpoints.createIndex('gameId', 'gameId', { unique: false });
                }
            }

            /**
             * `allowFallback` protege o rollback: se o navegador já tem o banco
             * em versão mais nova que a deste código, `open(NAME, VERSION)`
             * falha com `VersionError`. Em vez de deixar o app inutilizável,
             * reabrimos sem versão declarada e usamos os stores conhecidos.
             * Nada é apagado nem rebaixado — só lemos o que já existe.
             */
            function attempt(version, allowFallback) {
                const request = version ? indexedDB.open(NAME, version) : indexedDB.open(NAME);
                request.onupgradeneeded = () => upgrade(request.result);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => {
                    const error = request.error;
                    if (allowFallback && error && error.name === 'VersionError') {
                        console.warn('Banco local em versão mais nova; abrindo sem rebaixar.');
                        attempt(null, false);
                        return;
                    }
                    reject(error || new Error('Falha ao abrir o banco local.'));
                };
            }

            attempt(VERSION, true);
        });
        return dbPromise;
    }

    function ask(request) {
        return new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    }

    async function store(name, mode) {
        const db = await open();
        return db.transaction(name, mode || 'readonly').objectStore(name);
    }

    async function get(name, key) {
        return ask((await store(name)).get(key));
    }

    async function getAll(name) {
        return ask((await store(name)).getAll());
    }

    async function put(name, value) {
        return ask((await store(name, 'readwrite')).put(value));
    }

    async function del(name, key) {
        return ask((await store(name, 'readwrite')).delete(key));
    }

    async function clear(name) {
        return ask((await store(name, 'readwrite')).clear());
    }

    async function count(name) {
        return ask((await store(name)).count());
    }

    /* Grava muitos registros em uma única transação (importação rápida). */
    async function bulkPut(name, values) {
        if (!values.length) return;
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(name, 'readwrite');
            const os = tx.objectStore(name);
            values.forEach(value => os.put(value));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
            tx.onabort = () => reject(tx.error || new Error('Importação cancelada.'));
        });
    }

    async function getByIndex(name, indexName, value) {
        const os = await store(name);
        return ask(os.index(indexName).getAll(value));
    }

    async function deleteGame(id) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(['games', 'data', 'analysis', 'ai', 'queue', 'checkpoints'], 'readwrite');
            tx.objectStore('games').delete(id);
            tx.objectStore('data').delete(id);
            ['analysis', 'ai', 'queue', 'checkpoints'].forEach(name => {
                const index = tx.objectStore(name).index('gameId');
                index.openKeyCursor(IDBKeyRange.only(id)).onsuccess = event => {
                    const cursor = event.target.result;
                    if (cursor) {
                        tx.objectStore(name).delete(cursor.primaryKey);
                        cursor.continue();
                    }
                };
            });
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function clearAll() {
        const db = await open();
        return new Promise((resolve, reject) => {
            const names = ['games', 'data', 'analysis', 'ai', 'meta', 'queue', 'checkpoints'];
            const tx = db.transaction(names, 'readwrite');
            names.forEach(name => tx.objectStore(name).clear());
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    /* ---------- atalhos para análise e IA ---------- */
    /**
     * Chave de uma análise. O build entra na chave para que uma análise do
     * SF10 (`gameId@depth`) e uma do SF19 (`gameId@depth@build`) coexistam:
     * reanalisar nunca sobrescreve o resultado antigo. Sem o terceiro
     * argumento, a forma legada é preservada.
     */
    function analysisKey(gameId, depth, build) {
        const base = `${gameId}@${depth}`;
        return build ? `${base}@${build}` : base;
    }

    /**
     * Análise de `gameId`, preferindo o build informado (por padrão, o build
     * atual do motor). Se não houver nenhuma do build atual, devolve a melhor
     * análise legada — o chamador avisa que ela veio de outro motor. Nunca
     * mistura registros: a escolha é sempre por build inteiro.
     */
    async function getAnalysis(gameId, build) {
        const list = await getByIndex('analysis', 'gameId', gameId);
        if (!list || !list.length) return null;
        const wanted = build !== undefined
            ? build
            : (typeof Engine !== 'undefined' && Engine.BUILD_ID ? Engine.BUILD_ID : null);
        const preferred = wanted
            ? list.filter(record => (record.engineBuild || record.build || '') === wanted)
            : [];
        const pool = preferred.length ? preferred : list;
        return pool.sort((a, b) => (b.depth - a.depth) || (b.createdAt - a.createdAt))[0];
    }

    async function getAnalyses(gameId) {
        const list = await getByIndex('analysis', 'gameId', gameId);
        return (list || []).sort((a, b) => (b.depth - a.depth) || (b.createdAt - a.createdAt));
    }

    /**
     * Grava sem trocar chave existente: o enriquecimento de uma análise antiga
     * deve continuar no mesmo registro. Análises novas recebem a chave com o
     * build (`gameId@depth@build`), que não colide com a forma legada.
     */
    async function saveAnalysis(record) {
        if (!record.key) {
            record.key = analysisKey(record.gameId, record.depth, record.engineBuild || record.build);
        }
        await put('analysis', record);
        return record;
    }

    /* ---------- fila de análise (Fase 3) ---------- */
    /**
     * A fila usa a mesma identidade da análise. Assim fila, checkpoint e
     * resultado falam exatamente do mesmo alvo (`gameId@depth@build`).
     */
    function queueKey(gameId, depth, build) {
        return analysisKey(gameId, depth, build);
    }

    /**
     * Enfileira entradas `{gameId, depth, engineBuild, positionsTotal?}`.
     * Dedupe e teto de itens ativos são decididos dentro da transação: duas
     * abas não conseguem furar o limite. Itens terminais (done/canceled) não
     * ocupam vaga.
     */
    async function enqueueAnalyses(entries) {
        const planner = window.Queue;
        if (!planner || typeof planner.plan !== 'function') {
            throw new Error('Módulo de fila não carregado.');
        }
        const list = Array.isArray(entries) ? entries : [];
        if (!list.length) {
            return { added: 0, skipped: 0, invalid: 0, rejected: 0, capReached: false, addedKeys: [] };
        }
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('queue', 'readwrite');
            const store = tx.objectStore('queue');
            const request = store.getAll();
            let result = null;
            request.onsuccess = () => {
                const existing = request.result || [];
                const active = existing.filter(item => planner.isActive(item));
                const candidates = list
                    .filter(entry => entry && entry.gameId)
                    .map(entry => Object.assign({}, entry, {
                        key: queueKey(entry.gameId, entry.depth, entry.engineBuild),
                    }));
                const plan = planner.plan(active, candidates, planner.MAX_ITEMS);
                plan.accepted.forEach(item => store.put(item));
                result = {
                    added: plan.accepted.length,
                    skipped: plan.skipped.length,
                    invalid: plan.invalid.length,
                    rejected: plan.rejected.length,
                    capReached: plan.capReached,
                    addedKeys: plan.accepted.map(item => item.key),
                };
            };
            tx.oncomplete = () => resolve(result || {
                added: 0, skipped: 0, invalid: 0, rejected: 0, capReached: false, addedKeys: [],
            });
            tx.onerror = () => reject(tx.error || new Error('Falha ao enfileirar análises.'));
            tx.onabort = () => reject(tx.error || new Error('Fila cancelada.'));
        });
    }

    /** Itens da fila em ordem de prioridade; `states` opcional filtra. */
    async function getQueue(filter) {
        const all = await getAll('queue');
        const states = filter && Array.isArray(filter.states) ? filter.states : null;
        return (all || [])
            .filter(item => !states || states.indexOf(item.state) !== -1)
            .sort((a, b) => (a.priority - b.priority) || (a.createdAt - b.createdAt));
    }

    async function getQueueItem(key) {
        return get('queue', key);
    }

    /**
     * Atualiza um item preservando `key` e carimbando `updatedAt`. Devolve o
     * registro gravado, ou `null` se a chave não existir mais.
     */
    async function updateQueueItem(key, patch) {
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('queue', 'readwrite');
            const store = tx.objectStore('queue');
            const request = store.get(key);
            let updated = null;
            request.onsuccess = () => {
                const current = request.result;
                if (!current) return;
                updated = Object.assign({}, current, patch, { key: current.key, updatedAt: Date.now() });
                store.put(updated);
            };
            tx.oncomplete = () => resolve(updated);
            tx.onerror = () => reject(tx.error || new Error('Falha ao atualizar a fila.'));
        });
    }

    async function removeQueueItem(key) {
        await del('queue', key);
        return true;
    }

    /** Remove itens da fila. Sem filtro, esvazia tudo. */
    async function clearQueue(filter) {
        const states = filter && Array.isArray(filter.states) ? filter.states : null;
        if (!states) return clear('queue');
        const items = await getQueue({ states });
        if (!items.length) return true;
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('queue', 'readwrite');
            const store = tx.objectStore('queue');
            items.forEach(item => store.delete(item.key));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    /* ---------- checkpoints ---------- */
    async function saveCheckpoint(record) {
        if (!record || !record.key) throw new Error('Checkpoint sem chave.');
        const next = Object.assign({}, record, { updatedAt: Date.now() });
        await put('checkpoints', next);
        return next;
    }

    async function getCheckpoint(key) {
        return get('checkpoints', key);
    }

    async function deleteCheckpoint(key) {
        await del('checkpoints', key);
        return true;
    }

    async function clearCheckpointsForGame(gameId) {
        const list = await getByIndex('checkpoints', 'gameId', gameId);
        if (!list || !list.length) return true;
        const db = await open();
        return new Promise((resolve, reject) => {
            const tx = db.transaction('checkpoints', 'readwrite');
            const store = tx.objectStore('checkpoints');
            list.forEach(item => store.delete(item.key));
            tx.oncomplete = () => resolve(true);
            tx.onerror = () => reject(tx.error);
        });
    }

    async function getAI(gameId, kind) {
        return get('ai', `${gameId}:${kind}`);
    }

    async function saveAI(gameId, kind, payload) {
        const record = Object.assign({ key: `${gameId}:${kind}`, gameId, kind, createdAt: Date.now() }, payload);
        await put('ai', record);
        return record;
    }

    async function getMeta(key) { return get('meta', key); }
    async function saveMeta(key, value) { return put('meta', { key, value, createdAt: Date.now() }); }

    return {
        open, get, getAll, put, del, clear, count, bulkPut, getByIndex, deleteGame, clearAll,
        getAnalysis, getAnalyses, saveAnalysis, getAI, saveAI, getMeta, saveMeta, analysisKey,
        queueKey, enqueueAnalyses, getQueue, getQueueItem, updateQueueItem, removeQueueItem,
        clearQueue, saveCheckpoint, getCheckpoint, deleteCheckpoint, clearCheckpointsForGame,
    };
})();

const Settings = (() => {
    // Chave legada preservada de propósito: renomear apagaria as preferências
    // de quem já usa o aplicativo. O nome interno não aparece na interface.
    const KEY = 'acervo64_settings_v1';
    const DEFAULTS = {
        theme: 'dark',
        playerNames: '',
        depth: 12,
        pageSize: 50,
        ai: {
            // proxyUrl vazio usa a própria origem. O app nunca fala com
            // localhost no site publicado.
            proxyUrl: '',
            model: '',
            temperature: 0.3,
            numCtx: 4096,
            privacy: {
                blocked: false,
                consentVersion: '',
                consentAt: 0,
                provider: '',
            },
        },
    };
    let cache = null;

    function clone(value) { return JSON.parse(JSON.stringify(value)); }

    function load() {
        if (cache) return cache;
        let stored = {};
        try {
            stored = JSON.parse(localStorage.getItem(KEY) || '{}');
        } catch (e) { stored = {}; }
        cache = Object.assign(clone(DEFAULTS), stored);
        cache.ai = Object.assign(clone(DEFAULTS.ai), stored.ai || {});
        cache.ai.privacy = Object.assign(
            clone(DEFAULTS.ai.privacy),
            (stored.ai && stored.ai.privacy) || {}
        );
        cache.depth = Number(cache.depth) || DEFAULTS.depth;
        cache.pageSize = Number(cache.pageSize) || DEFAULTS.pageSize;
        return cache;
    }

    function get() { return load(); }

    function save(patch) {
        const current = load();
        const next = Object.assign({}, current, patch || {});
        if (patch && patch.ai) next.ai = Object.assign({}, current.ai, patch.ai);
        if (patch && patch.ai && patch.ai.privacy) {
            next.ai.privacy = Object.assign({}, current.ai.privacy, patch.ai.privacy);
        }
        cache = next;
        try { localStorage.setItem(KEY, JSON.stringify(next)); } catch (e) { /* modo privado */ }
        return next;
    }

    function playerNameList() {
        // Aceita vários apelidos separados por ponto e vírgula ou por quebra de linha.
        // A vírgula é preservada porque nomes de PGN costumam ser "Sobrenome, Nome".
        return String(load().playerNames || '')
            .split(/[;\n]+/)
            .map(name => name.trim())
            .filter(Boolean);
    }

    return { get, save, playerNameList, DEFAULTS };
})();

window.DB = DB;
window.Settings = Settings;
