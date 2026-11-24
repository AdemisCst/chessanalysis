/* ========================================================================
   ARQUIVO: js/tags.js
   DESCRIÇÃO: Tags fixas por lado da partida.

   Diferente das tags livres, estas cinco categorias são calculadas a partir
   do que realmente aconteceu no tabuleiro e ficam separadas por cor:

     Abertura    a partida passou por uma linha nomeada da base
     Tática      o lado encontrou (ou perdeu) um recurso tático concreto
     Finais      a partida chegou a um final com poucas peças
     Brilhante   o lado tem pelo menos um lance marcado como !!
     Erro Grosseiro  o lado cometeu pelo menos uma perda superior a 20pp

   O cálculo é determinístico e roda sem internet. A IA pode ser usada depois
   para comentar as tags, mas não decide sozinha o que é um erro grosseiro.
   ======================================================================== */

const Tags = (() => {
    const FIXED = ['Abertura', 'Tática', 'Finais', 'Brilhante', 'Erro Grosseiro'];
    const DESCRIPTIONS = {
        Abertura: 'A partida seguiu uma linha nomeada da base de aberturas.',
        Tática: 'Houve um recurso tático concreto (sacrifício, combinação ou chance perdida).',
        Finais: 'A partida chegou a um final.',
        Brilhante: 'O lado tem pelo menos um lance marcado como brilhante (!!).',
        'Erro Grosseiro': 'O lado cometeu pelo menos um erro grosseiro (??).',
    };

    function blank() {
        return { w: [], b: [] };
    }

    function ensure(game) {
        if (!game.tagsBySide || typeof game.tagsBySide !== 'object') game.tagsBySide = blank();
        if (!Array.isArray(game.tagsBySide.w)) game.tagsBySide.w = [];
        if (!Array.isArray(game.tagsBySide.b)) game.tagsBySide.b = [];
        ['w', 'b'].forEach(color => {
            game.tagsBySide[color] = game.tagsBySide[color].map(tag =>
                tag === 'Capivarada' ? 'Erro Grosseiro' : tag
            );
        });
        return game.tagsBySide;
    }

    function unique(list) {
        return Array.from(new Set(list.filter(tag => FIXED.includes(tag))));
    }

    function add(record, color, tag) {
        if (!FIXED.includes(tag)) return;
        if (!record[color].includes(tag)) record[color].push(tag);
    }

    function movesOf(game, provided) {
        if (Array.isArray(provided)) return provided;
        if (Array.isArray(game.moves)) return game.moves;
        return [];
    }

    function countCaptures(moves, color) {
        let total = 0;
        moves.forEach((move, index) => {
            if (index % 2 !== (color === 'w' ? 0 : 1)) return;
            if (move && typeof move.san === 'string' && move.san.includes('x')) total++;
        });
        return total;
    }

    /**
     * Recalcula as tags de ambos os lados. A análise é opcional: sem ela, usa
     * apenas cabeçalhos e lances; com ela, acrescenta Brilhante, Erro Grosseiro e
     * Tática com base nas anotações do Stockfish.
     */
    function derive(game, analysis, providedMoves) {
        const record = blank();
        const moves = movesOf(game, providedMoves);
        const plyCount = Number(game.plyCount) || moves.length || 0;
        const openingKnown = !!(game.opening || game.eco);
        const summary = analysis ? analysis.summary : game.analysisSummary;

        // Abertura: a base reconheceu a linha e a partida andou o suficiente
        // para não ser apenas um lance isolado.
        if (openingKnown && plyCount >= 4) {
            add(record, 'w', 'Abertura');
            add(record, 'b', 'Abertura');
        }

        // Finais: mais de 60 lances (30 de cada lado) ou posição final com
        // material reduzido. A segunda condição pega finais curtos.
        let endgame = plyCount >= 60;
        if (!endgame && moves.length) {
            const lastFen = moves[moves.length - 1] && moves[moves.length - 1].fen;
            if (lastFen) {
                const board = String(lastFen).split(' ')[0];
                const heavy = (board.match(/[qrQR]/g) || []).length;
                const pieces = (board.match(/[pnbrqkPNBRQK]/g) || []).length;
                endgame = heavy <= 2 || pieces <= 12;
            }
        }
        if (endgame) {
            add(record, 'w', 'Finais');
            add(record, 'b', 'Finais');
        }

        if (summary && summary.counts) {
            ['w', 'b'].forEach(color => {
                const counts = summary.counts[color] || {};
                if (Number(counts.brilliant) > 0) {
                    add(record, color, 'Brilhante');
                    add(record, color, 'Tática');
                }
                if (Number(counts.blunder) > 0) add(record, color, 'Erro Grosseiro');
                if (Number(counts.missed) > 0) add(record, color, 'Tática');
            });
        } else {
            // Sem análise: uma sequência de capturas é um indício conservador
            // de jogo tático. Não marca brilho nem erros grosseiros sem engine.
            ['w', 'b'].forEach(color => {
                if (countCaptures(moves, color) >= 4) add(record, color, 'Tática');
            });
        }

        // Garante a ordem canônica, que também é a ordem exibida na interface.
        record.w = FIXED.filter(tag => record.w.includes(tag));
        record.b = FIXED.filter(tag => record.b.includes(tag));
        game.tagsBySide = record;
        return record;
    }

    /** Verifica se algo mudou antes de gravar, para evitar writes inúteis. */
    function apply(game, analysis, providedMoves) {
        const before = JSON.stringify(game.tagsBySide || null);
        const record = derive(game, analysis, providedMoves);
        return JSON.stringify(record) !== before;
    }

    function forSide(game, color) {
        ensure(game);
        return game.tagsBySide[color] || [];
    }

    /** Lista plana para busca e exportação. */
    function all(game) {
        ensure(game);
        return unique([].concat(game.tagsBySide.w, game.tagsBySide.b));
    }

    return {
        FIXED,
        DESCRIPTIONS,
        blank,
        ensure,
        derive,
        apply,
        forSide,
        all,
    };
})();

window.Tags = Tags;
