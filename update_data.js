(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.AnimeUpdater = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {

    // ── Runtime Configuration System ─────────────────────────────────────────────
    // Browser: localStorage key 'anime_updater_config' (JSON string)
    // Node:    ./anime_updater_config.json next to update_data.js
    //
    // Nothing set = zero effect, behavior identical to original.

    let _config = {};

    (function _loadConfig() {
        let raw = null;
        if (typeof localStorage !== 'undefined') {
            try { raw = localStorage.getItem('anime_updater_config'); } catch(e) {}
        } else if (typeof require !== 'undefined') {
            try {
                const fs   = require('fs');
                const path = require('path');
                const DIR  = (typeof __dirname !== 'undefined' && __dirname)
                    ? __dirname : process.cwd();
                const p = path.join(DIR, 'anime_updater_config.json');
                if (fs.existsSync(p)) raw = fs.readFileSync(p, 'utf8');
            } catch(e) {}
        }
        if (!raw) return;
        try {
            _config = JSON.parse(raw);
            console.log('[AnimeUpdater] Config loaded.');
        } catch(e) {
            console.warn('[AnimeUpdater] Config parse failed, using defaults:', e.message);
            _config = {};
        }
    }());

    // ── _toRegex ──────────────────────────────────────────────────────────────────
    // Converts stored config value into a usable RegExp.
    //
    // Input can be:
    //   "somestring"              → /somestring/i     (default: always i)
    //   { pattern, flags }        → new RegExp(pattern, flags)  (explicit control)
    //   { pattern }               → /pattern/i        (flags optional, defaults i)
    //
    // Plain string default = i flag. This matches how every built-in filter works.
    // Only use object form if you specifically need case-sensitive or other flags.
    function _toRegex(p) {
        if (p instanceof RegExp) return p;
        if (typeof p === 'string' && p.length > 0)
            return new RegExp(p, 'i');
        if (p && typeof p === 'object' && typeof p.pattern === 'string')
            return new RegExp(p.pattern, p.flags !== undefined ? p.flags : 'i');
        return null;
    }

    // ── _buildFilter ──────────────────────────────────────────────────────────────
    // Builds a test function for a named parser's drop filter.
    //
    // overwrite set → use ONLY the overwrite pattern (replaces builtinRegex)
    // add set       → use builtinRegex PLUS add patterns
    // neither set   → use ONLY builtinRegex (original behavior, zero change)
    //
    // "add" always stacks on top regardless of whether overwrite or builtin is used.
    // This means:
    //   overwrite + add → overwrite pattern + add patterns (builtin skipped)
    //   builtin  + add → builtin pattern + add patterns
    function _buildFilter(parserName, builtinRegex) {
        const cfg = ((_config.parserDropFilters || {})[parserName]) || {};
        const patterns = [];

        if (cfg.overwrite != null) {
            // overwrite replaces the builtin
            const r = _toRegex(cfg.overwrite);
            if (r) patterns.push(r);
        } else {
            // no overwrite → use original built-in
            patterns.push(builtinRegex);
        }

        // add always appends regardless of overwrite/builtin choice
        if (Array.isArray(cfg.add)) {
            cfg.add.forEach(p => {
                const r = _toRegex(p);
                if (r) patterns.push(r);
            });
        }

        return (t) => patterns.some(p => p.test(t));
    }

    // ── Build global filter ───────────────────────────────────────────────────────
    // Same overwrite/add logic, but for the global filter.
    // Built once at module load time, used in parseContent.
    const _globalFilter = (function() {
        const cfg = _config.globalFilter || {};
        const patterns = [];

        if (cfg.overwrite != null) {
            const r = _toRegex(cfg.overwrite);
            if (r) patterns.push(r);
        } else {
            // Original built-in global filter — unchanged
            patterns.push(/(en\s*dub|en-dub|\bpv\b|ULTRA】|members?\s*only)/i);
        }

        if (Array.isArray(cfg.add)) {
            cfg.add.forEach(p => {
                const r = _toRegex(p);
                if (r) patterns.push(r);
            });
        }

        return (title) => patterns.some(p => p.test(title));
    }());

    // ── Build per-parser filters ──────────────────────────────────────────────────
    // Each parser's built-in drop regex is registered here alongside its name.
    // If config has nothing for that parser, the built-in is used unchanged.
    // Built once at module load — parsers reference these by name when called.
    const _pf = {
        aniOneId:   _buildFilter('aniOneId',   /^FULL EPISODE|Science Class/i),
        aniOneAsia: _buildFilter('aniOneAsia', /^FULL EPISODE|Highlight|Science Class|Making.?of|Lyric\s*Video|精華重溫|精彩重溫|#Shorts/i),
        aniMiAsia:  _buildFilter('aniMiAsia',  /PV|Highlight|Special Screening|FULL EPISODE/i),
        takarir:    _buildFilter('takarir',    /Semua Episode|\(Live-Action\)|PUI PUI MOLCAR|Cuplikan/i),
        itsAnime:   _buildFilter('itsAnime',   /(?!)/), // no built-in drop — regex that matches nothing
        tropics:    _buildFilter('tropics',    /Members Only|english\s*sub|en\s*sub|en-sub/i),
        youku:      _buildFilter('youku',      /Highlight|精彩片段|精彩看点|Trailer|Tralier|预告|^精华版|OP|ED|Opening|Ending|全漫同庆|合集|全集|EP\d+[-–]\d+|\d+[-–]\d+集|VIETDUB|JPN\s*DUB|Members?|会员/i),
        yuewen:     _buildFilter('yuewen',     /Trailer|TRAILER|Highlight|HIGHLIGHT|\bClip\b|\bCLIP\b|Versi Lengkap|Versi Full|Versi Lengkep|\bFULL\b|EP\s?\d+\s?[-–]\s?\d+/i),
        conan:      _buildFilter('conan',      /COMBINED EPISODE|UNCUT VERSION|SPESIAL EPISODE|\[FULL EPISODE\]|Trailer|TRAILER|Teaser|TEASER|BEST SCENE|TOP SCENE|TOP MOMENT|BEST CUT|HIGHLIGHT|Horror Animation|Animasi Horor|SEGERA TAYANG|Sunday Morning|SMA TALKS|OFFICIAL/i),
        dub:        _buildFilter('dub',        /(?!)/), // no built-in drop for dub parser
    };

    // ── _runCustomParser ──────────────────────────────────────────────────────────
    // Executes a custom parser defined entirely in config.
    // Config shape for one custom parser:
    //   {
    //     name:           string   ← identifier, used for its drop filter key
    //     channelMatch:   string   ← pattern that triggers this parser in dispatcher
    //     dropFilter:     { overwrite, add }  ← same overwrite/add system
    //     namePattern:    string   ← regex, capture group 1 = anime name
    //     episodePattern: string   ← regex, capture group 1 = episode number
    //     isDonghua:      bool
    //     isMarathon:     bool
    //   }
    //
    // The channel parser functions in built-in parsers handle complex extraction.
    // Custom parsers via config handle the common case:
    //   extract name from group 1, extract episode from group 1 of second pattern.
    // For anything more complex, add a real parser function to the source.
    function _runCustomParser(cfg, t, url, block) {
        // Build this custom parser's drop filter on first call, cache it
        if (!_pf['__custom_' + cfg.name]) {
            _pf['__custom_' + cfg.name] = _buildFilter('__custom_' + cfg.name, /(?!)/);
        }

        // Register drop filter under its config key so _buildFilter finds it
        // We need to re-check: parserDropFilters['__custom_myChannel'] in _config
        if (_pf['__custom_' + cfg.name](t)) return null;

        if (!cfg.namePattern || !cfg.episodePattern) return null;

        const nameM = t.match(new RegExp(cfg.namePattern, 'i'));
        if (!nameM || !nameM[1]) return null;
        const animeName = cleanTitle(nameM[1]);

        const epM = t.match(new RegExp(cfg.episodePattern, 'i'));
        if (!epM || !epM[1]) return null;
        const episode = parseInt(epM[1], 10);
        if (isNaN(episode)) return null;

        const video_id = extractVideoId(url);
        if (!video_id) return null;

        return [{
            animeName,
            episode,
            title:      t,
            url,
            video_id,
            is_donghua: !!cfg.isDonghua,
            is_marathon: !!cfg.isMarathon
        }];
    }

    const LS_KEY = 'anime_data';

    // ── Helper Utilities ──────────────────────────────────────────────────────

    const normalizeUrl = (url) => {
        // youtu.be/ID → full watch URL
        const short = (url || '').match(/^https?:\/\/youtu\.be\/([a-zA-Z0-9_-]{11})/);
        if (short) url = 'https://www.youtube.com/watch?v=' + short[1];
        // Strip share-tracking (?si= or &si=) and playlist context (?list= or &list=)
        url = url.replace(/[?&]si=[^&]*/g, '').replace(/[?&]list=[^&]*/g, '');
        // Clean up artifacts: doubled ?, trailing &, ?& sequences
        url = url.replace(/\?&/, '?').replace(/&&+/g, '&').replace(/[?&]$/, '');
        return url;
    };

    const extractVideoId = (url) => {
        const m = (url || '').match(/[?&]v=([a-zA-Z0-9_-]+)/);
        return m ? m[1] : null;
    };

    const isLargeRange = (start, end) => (end - start) > 3;

    const cleanTitle = (name) => name.replace(/\.{2,}/g, ' ').replace(/[\-~]+$/, '').replace(/ {2,}/g, ' ').trim();

    // Bug 1 fix: CJK names must not collapse to '' or they all land in one bucket
    // and ''.includes(x) === true always, merging CJK with everything (Bug 2).
    const normalizeForCompare = (name) => {
        const latin = name.toLowerCase().replace(/[^a-z0-9]/g, '');
        if (latin.length > 0) return latin;
        return name.toLowerCase().replace(/[\s\-_.,!?\u300a\u300b\u3010\u3011\u300c\u300d\u300e\u300f\u3008\u3009\uff08\uff09()\[\]\'"\u00b7\u30fb\u2022\uff5e~]/g, '');
    };

    const levenshtein = (s1, s2) => {
        if (s1.length < s2.length) [s1, s2] = [s2, s1];
        if (s2.length === 0) return s1.length;
        let prev = Array.from({length: s2.length + 1}, (_, i) => i);
        for (let i = 0; i < s1.length; i++) {
            let curr = [i + 1];
            for (let j = 0; j < s2.length; j++) {
                curr.push(Math.min(prev[j+1] + 1, curr[j] + 1, prev[j] + (s1[i] === s2[j] ? 0 : 1)));
            }
            prev = curr;
        }
        return prev[s2.length];
    };

    // ── 1. Text Extraction ────────────────────────────────────────────────────

    const extractPairs = (content) => {
        const pairs = [];
        // Normalize the text: remove "Title: ", "URL: " and horizontal dashed lines
        const lines = content.split('\n').map(l => l.replace(/^(Title:|URL:)\s*/i, '').trim());

        let i = 0;
        while (i < lines.length) {
            // Find a valid title line
            if (!lines[i] || lines[i].startsWith('http') || /^[-]{3,}$/.test(lines[i])) {
                i++; continue;
            }

            // Look for the URL line beneath it
            let j = i + 1;
            while (j < lines.length && (!lines[j] || /^[-]{3,}$/.test(lines[j]))) j++;

            if (j < lines.length && lines[j].startsWith('http')) {
                // We have a Title and a URL. Now grab any chapters below it.
                let rawBlock = lines[i] + '\n' + lines[j];
                let k = j + 1;
                while (k < lines.length && lines[k] && !lines[k].startsWith('http') && !/^[-]{3,}$/.test(lines[k])) {
                    rawBlock += '\n' + lines[k];
                    k++;
                }
                pairs.push({ title: lines[i], url: normalizeUrl(lines[j]), rawBlock });
                i = k;
            } else {
                i++;
            }
        }
        return pairs;
    };

    // ── 2. Dub Parser (moved to top) ───────────────────────────────────────────
    // Dub Parser — adds " (Dub Indo)" suffix and handles brackets
    const parseDub = (t, url, block) => {
        if (_pf.dub(t)) return null;
        // TROPICS Dub Style: 【Dub Indonesia】《WITCH WATCH วิทช์วอทช์》｜ตอนที่ 25｜TROPICS ENTERTAINMENT
        const tropicsM = t.match(/【Dub Indonesia】《(.+?)》｜(?:Episode|ตอนที่)\s*(\d+)｜/i);
        if (tropicsM) {
            const animeName = cleanTitle(tropicsM[1]).replace(/[《》]/g, ' ').replace(/ {2,}/g, ' ').trim();
            const episode = parseInt(tropicsM[2], 10);
            return [{ animeName: animeName + ' (Dub Indo)', episode, title: t, url, video_id: extractVideoId(url) }];
        }

        // Try to capture "Takarir" or "Bahasa Indonesia" style
        const takarirM = t.match(/^(.+?)\s+-\s+Episode\s*(\d+)\s*\[(?:Takarir Indonesia|Bahasa Indonesia)\]/i);
        if (takarirM) {
            const animeNameRaw = takarirM[1];
            const animeName = cleanTitle(animeNameRaw);
            const episode = parseInt(takarirM[2], 10);
            return [{ animeName: animeName + ' (Dub Indo)', episode, title: `${animeName} - Episode ${episode}`, url, video_id: extractVideoId(url) }];
        }

        // Generic dub format: handle optional brackets and #N
        const m = t.match(/^(.+?)\s+#(\d+(?:\.\d+)?)/);
        if (m) {
            let animeName = cleanTitle(m[1]).replace(/[《》]/g, ' ').replace(/ {2,}/g, ' ').trim();
            const episode = parseFloat(m[2]);
            return [{ animeName: animeName + ' (Dub Indo)', episode, title: t, url, video_id: extractVideoId(url) }];
        }

        // Try a looser fallback: title with " (ID Dub)" style or bracketed dub tags
        const looseM = t.match(/^(.+?)\s*\((?:ID|ID\s*Dub|ID\s*Sub|dub)\)/i);
        if (looseM) {
            let animeName = cleanTitle(looseM[1]).replace(/[《》]/g, ' ').replace(/ {2,}/g, ' ').trim();
            // no episode info -> skip if can't extract episode number
            const epM = t.match(/#(\d+(?:\.\d+)?)/);
            if (!epM) return null;
            const episode = parseFloat(epM[1]);
            return [{ animeName: animeName + ' (Dub Indo)', episode, title: t, url, video_id: extractVideoId(url) }];
        }

        return null;
    };

    // ── 3. Channel Parsers ────────────────────────────────────────────────────

    const parseAniOne = (t, url, block) => {
        if (_pf.aniOneId(t)) return null;
        let isSpecial = /^SPECIAL EPISODE/i.test(t);
        let isEncore = /\(ENCORE\)/i.test(t);

        const nameM = t.match(/《(.+?)》/);
        if (!nameM) return null;
        let animeName = cleanTitle(nameM[1]);

        const epM = t.match(/#(\d+(?:\.\d+)?)/);
        if (!epM) return null;
        const episode = parseFloat(epM[1]);

        const betweenNameAndEp = t.substring(t.indexOf('》') + 1, t.indexOf('#')).trim();
        const seasonM = betweenNameAndEp.match(/Season\s+(\d+)/i);
        if (seasonM) animeName += ` Season ${seasonM[1]}`;

        if (isSpecial) animeName += ' (Special)';
        if (isEncore) animeName += ' (Encore)';

        return [{ animeName, episode, title: t, url, video_id: extractVideoId(url), _aniOneId: true }];
    };

    const parseAniOneAsia = (t, url, block) => {
        if (_pf.aniOneAsia(t)) return null;

        let animeName, episode;

        const bracketM = t.match(/《(.+?)》/);
        if (bracketM) {
            // Standard Ani-One Asia format: 《Title》#N
            animeName = cleanTitle(bracketM[1]);
            const epM = t.match(/#(\d+(?:\.\d+)?)/);
            if (!epM) return null;
            episode = parseFloat(epM[1]);
            const between = t.substring(t.indexOf('》') + 1, t.indexOf('#')).trim();
            const seasonM = between.match(/Season\s+(\d+)/i);
            if (seasonM) animeName += ` Season ${seasonM[1]}`;
        } else {
            // No-bracket format: "Title Arc #N (ENG sub | JP dub)" (e.g. Sengoku Youko S1)
            // Strip leading/trailing quotation marks then capture name before " #N"
            const stripped = t.replace(/^[\u201c\u201d"']+|[\u201c\u201d"']+$/g, '').trim();
            const noM = stripped.match(/^(.+?)\s+#(\d+(?:\.\d+)?)\b/);
            if (!noM) return null;
            animeName = cleanTitle(noM[1]);
            episode   = parseFloat(noM[2]);
        }

        if (!animeName || isNaN(episode)) return null;
        return [{ animeName, episode, title: t, url, video_id: extractVideoId(url), is_marathon: true }];
    };

    // Ani-Mi Asia parser
    const parseAniMiAsia = (t, url, block) => {
        if (_pf.aniMiAsia(t)) return null;

        // Match patterns like "Title #N (ENG sub)【Ani-Mi Asia】" or "Title S3 #N (ENG sub)【Ani-Mi Asia】"
        const m = t.match(/^(.+?)\s+#(\d+(?:\.\d+)?)(?:\s*\((.+?)\))?/i);
        if (!m) return null;

        let animeName = cleanTitle(m[1]);
        const episode = parseFloat(m[2]);

        // Handle Season notation appended like "Some Title S3"
        const seasonM = animeName.match(/\bS(\d+)$/i);
        if (seasonM) {
            animeName = animeName.replace(/\bS(\d+)$/i, '').trim() + ` Season ${seasonM[1]}`;
        }

        // Return same object shape as others but mark as marathon (legacy behavior)
        return [{ animeName, episode, title: t, url, video_id: extractVideoId(url), is_marathon: true, is_donghua: true }];
    };

        const parseTakarir = (t, url, block) => {
            if (_pf.takarir(t)) return null;
    
            const m = t.match(/^(.+?)\s+-\s+Episode\s*(\d+(?:\s*[-–]\s*\d+)?)\s*\[Takarir Indonesia\]/i);        if (!m) return null;

        const animeName = cleanTitle(m[1]);
        const epPart = m[2].trim();

        const rangeM = epPart.match(/(\d+)\s*[-–]\s*(\d+)/);
        if (rangeM) {
            const s = parseInt(rangeM[1], 10), e = parseInt(rangeM[2], 10);
            if (isLargeRange(s, e)) return null;
            return [{
                animeName, episode: s, end_episode: e,
                title: `${animeName} - Episode ${s}-${e}`,
                url, video_id: extractVideoId(url)
            }];
        }

        const episode = parseInt(epPart, 10);
        return [{ animeName, episode, title: `${animeName} - Episode ${episode}`, url, video_id: extractVideoId(url) }];
    };

    const parseTropics = (t, url, block) => {
        if (_pf.tropics(t)) return null;

        const nameM = t.match(/《(.+?)》/);
        if (!nameM) return null;
        const animeName = cleanTitle(nameM[1]);

        const epM = t.match(/Episode\s+(\d+)/i);
        if (!epM) return null;
        const episode = parseInt(epM[1], 10);

        return [{ animeName, episode, title: `${animeName} - Episode ${episode}`, url, video_id: extractVideoId(url) }];
    };

    const parseItsAnime = (t, url, block) => {
        if (_pf.itsAnime(t)) return null;
        const video_id = extractVideoId(url);
        if (!video_id) return null;

        const m1 = t.match(/^(.+)\s+-\s+Episode\s+(\d+)[-~]+(\d+)\s*\[It's Anime\]/i);
        if (m1) {
            const animeName = cleanTitle(m1[1]);
            const results = [];

            if (/^Chapters:/m.test(block)) {
                const lines = block.split('\n');
                let inChapters = false;
                for (const line of lines) {
                    if (/^Chapters:/i.test(line)) { inChapters = true; continue; }
                    if (!inChapters) continue;

                    const chM = line.match(/^[-*]?\s*(\d{1,2}):(\d{2}):(\d{2})\s+Episode\s+(\d+)\s*[：:]?\s*(.*)$/i);
                    if (chM) {
                        const h = parseInt(chM[1], 10), min = parseInt(chM[2], 10), sec = parseInt(chM[3], 10);
                        const ep = parseInt(chM[4], 10);
                        results.push({
                            animeName, episode: ep, start_seconds: (h * 3600 + min * 60 + sec),
                            chapter_title: chM[5].trim(), url, video_id, is_marathon: true
                        });
                    }
                }
            }
            return results.length > 0 ? results : null;
        }
        return null;
    };

    // ── 3b. YOUKU Parser ─────────────────────────────────────────────────────
    //
    // Handles YOUKU ANIMATION / 优酷动漫 / Animation-YOUKU channel titles.
    //
    // Formats handled:
    //   A. ENGSUB/MULTISUB 【Chinese English Title】EPxx ...
    //   B. 【Chinese Title】EPxx ...                (no sub-type prefix)
    //   C. 【ENG SUB】English Title EPxx ...        (label-only bracket)
    //   D. ENGSUB/MULTISUB [English Title] EPxx ... (ASCII brackets)
    //   E. 《Title》第N集 [English] Episode N ...   (Animation-YOUKU format)
    //      also handles 第N季第M集 (season+episode) with Chinese numerals
    //
    // Filtered out:
    //   Highlight (精彩片段/精彩看点), Trailer (预告), 精华版 digests,
    //   OP/ED, 合集/全集 compilations, EP range videos (EPxx-yy),
    //   VIETDUB, JPN DUB, and hashtag-only social posts

    const parseYouku = (t, url, block) => {
        if (_pf.youku(t)) return null;
        // Must have a structured bracket title
        if (!/[【《\[]/.test(t)) return null;

        const video_id = extractVideoId(url);
        if (!video_id) return null;

        let animeName = null;
        let episode   = null;

        const cnToNum = {'一':1,'二':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9,'十':10};
        const toN = (s) => cnToNum[s] ?? parseInt(s, 10);

        // ── Helper: extract best English name from bracket inner content ─
        // Splits on ALL CJK runs (handles embedded CJK like 第一季, 动画 etc.)
        // then picks the last Latin-containing segment as the English title.
        const getEng = (inner) => {
            let s = inner.trim()
                .replace(/^(ENGSUB|MULTISUB|ENG\s*SUB|MULTI\s*SUB)\s*/i, '')
                .trim();
            if (!s) return null;
            const parts = s
                .split(/[\u4e00-\u9fff\u3000-\u303f\u2e80-\u2eff]+/)
                .map(p => p.replace(/^[\s\-_]+|[\s\-_\]】]+$/g, '').trim())
                .filter(p => p.length > 1 && /[A-Za-z]/.test(p));
            if (!parts.length) return null;
            // Strip leading digit artefacts (e.g. "3 Apotheosis3" → "Apotheosis3")
            const best = parts[parts.length - 1].replace(/^\d+\s+/, '').trim();
            return best ? cleanTitle(best) : null;
        };

        // ── Path 1: 【...】 or ASCII [...] format ─────────────────────────
        const squareM = t.match(/【([^】]+)】/) || t.match(/\[([^\]]+)\]/);
        if (squareM) {
            const inner = squareM[1];

            // Special sub-case: 【ENG SUB】English Title EP(\d+)
            if (/^ENG\s*SUB$/i.test(inner.trim())) {
                const after = t.slice(squareM.index + squareM[0].length).trim();
                const m = after.match(/^(.+?)\s+EP(\d+)/i);
                if (m) {
                    animeName = cleanTitle(m[1]);
                    episode   = parseInt(m[2], 10);
                }
            } else {
                animeName = getEng(inner);
                const epM = t.match(/EP(\d+)/i);
                if (epM) episode = parseInt(epM[1], 10);
            }
        }

        // ── Path 2: 《...》 format (Animation-YOUKU older / webtoon series) ─
        if (!animeName || !episode) {
            const angles = [...t.matchAll(/《([^》]+)》/g)];
            if (angles.length > 0) {
                const last  = angles[angles.length - 1];
                const inner = last[1].trim();
                const after = t.slice(last.index + last[0].length);

                // Try English from inside brackets first
                animeName = getEng(inner) || null;

                // If still CJK/null, look for English after the bracket
                // e.g. "第7季第5集 Miss Puff Season 7 | ..."
                if (!animeName || /[\u4e00-\u9fff]/.test(animeName)) {
                    const engM = after.match(
                        /(?:第[一二三四五六七八九十\d]+[季集话])+\s*([A-Za-z][A-Za-z0-9!?:'\-\s]+?)(?:\s+(?:Season\s*\d+\s+)?Episode\s+\d+|\s*[\|｜]|$)/
                    );
                    if (engM) {
                        const candidate = cleanTitle(
                            engM[1].replace(/\s+Season\s*\d+\s*$/i, '').trim()
                        );
                        // "Episode N" alone is the episode label, NOT a series name
                        if (!/^Episode\s*\d+$/i.test(candidate)) animeName = candidate;
                    }
                    // Final fallback: use Chinese title as-is
                    if (!animeName || /[\u4e00-\u9fff]/.test(animeName)) {
                        animeName = cleanTitle(inner);
                    }
                }

                // Season + episode: 第N季第M集  (supports Chinese numerals: 第一季 etc.)
                const seEpM = t.match(/第([一二三四五六七八九十\d]+)季第([一二三四五六七八九十\d]+)[集话]/);
                if (seEpM) {
                    episode = toN(seEpM[2]);
                    const sn = toN(seEpM[1]);
                    if (sn > 1 && animeName) animeName += ` Season ${sn}`;
                } else {
                    // Plain 第N集 or 第N话
                    const ep集M = t.match(/第([一二三四五六七八九十\d]+)[集话]/);
                    if (ep集M) episode = toN(ep集M[1]);
                }

                if (!episode) {
                    const eM = t.match(/Episode\s+(\d+)/i);
                    if (eM) episode = parseInt(eM[1], 10);
                }
            }
        }

        if (!animeName || !episode || isNaN(episode)) return null;
        return [{ animeName, episode, title: t, url, video_id, is_donghua: true, is_marathon: true }];
    };

    // ── 3c. YUEWEN Parser ────────────────────────────────────────────────────
    //
    // Handles YUEWEN ANIMATION / Yuewen Animation Indonesia channel titles.
    //
    // Formats handled:
    //   A. INDOSUB 【Chinese English】Season[N] Ep[N] |YUEWEN...  (bracket variant)
    //   B. [emoji][4K | ]I?NDOSUB | Series Name[ S[N]] EP[N][(skip)] | Yuewen...
    //      Sub-variants:
    //        B1. S[N]EP[N] compact  — "Title S9EP254(185)"
    //        B2. S[N] EP[N] spaced  — "Title S6 EP11"
    //        B3. plain EP[N]        — "Title EP26" / "Title EP 69"
    //      Also handles: "4K | Title S6 EP12" (no INDOSUB label)
    //      Also handles: "NDOSUB" typo (missing leading I)
    //
    // Filtered out:
    //   Trailer, Highlight, Clip, Versi Lengkap/Full/Lengkep (Indonesian "full"),
    //   FULL (catches FULL EPISODE, S3 FULL, (FULL) compilations),
    //   EP range videos (EPxx-yy), descriptive clips with no episode number

    const parseYuewen = (t, url, block) => {
        if (_pf.yuewen(t)) return null;

        // Must mention Yuewen and have a valid video ID
        if (!/YUEWEN|Yuewen/i.test(t)) return null;

        const video_id = extractVideoId(url);
        if (!video_id) return null;

        let animeName = null;
        let episode   = null;

        // ── Path A: 【Chinese English】 bracket format ─────────────────────────
        // e.g. "INDOSUB 【生死回放 Life and Death Replay】Season1 Ep14"
        const bracketM = t.match(/【([^】]+)】/);
        if (bracketM) {
            const inner = bracketM[1].trim();
            // Split on CJK runs → keep last Latin-containing segment
            const parts = inner.split(/[\u4e00-\u9fff]+/)
                               .map(p => p.trim())
                               .filter(p => p.length > 1 && /[A-Za-z]/.test(p));
            if (parts.length > 0) animeName = cleanTitle(parts[parts.length - 1]);
            const seasonM = t.match(/Season\s*(\d+)\s+Ep\s*(\d+)/i);
            if (seasonM) {
                const sn = parseInt(seasonM[1], 10);
                episode = parseInt(seasonM[2], 10);
                if (sn > 1 && animeName) animeName += ` Season ${sn}`;
            } else {
                const epM = t.match(/Ep\s*(\d+)/i);
                if (epM) episode = parseInt(epM[1], 10);
            }
        }

        // ── Path B: pipe-delimited format ─────────────────────────────────────
        // e.g. "🌟4K | INDOSUB | Battle Through the Heavens S9EP254(185) | Yuewen Animation"
        // e.g. "💕 INDOSUB | Fox Spirit Matchmaker EP 69 | Yuewen Animation Indonesia"
        if (!animeName || !episode) {
            // Strip leading emoji(s) then split by pipe
            const stripped = t.replace(
                /^[\u{1F300}-\u{1FFFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\s]+/u, ''
            );
            const segments = stripped.split(/\s*\|\s*/).map(s => s.trim()).filter(Boolean);

            // Skip known non-series segments; stop at first segment with an EP pattern
            const skipLabels = /^(I?NDOSUB|4K|\d+K|Yuewen.*|YUEWEN.*|Baru.*|.*Indonesia.*)$/i;
            let seriesSegment = null;
            for (const seg of segments) {
                if (skipLabels.test(seg)) continue;
                if (/EP\s*\d+|Ep\s*\d+|S\d+EP\d+/i.test(seg)) { seriesSegment = seg; break; }
            }

            if (seriesSegment) {
                // B1: S[N]EP[N] compact — "Battle Through the Heavens S9EP254(185)"
                const compactM = seriesSegment.match(/^(.+?)\s+S(\d+)EP(\d+)(?:\(\d+\))?/i);
                if (compactM) {
                    animeName = cleanTitle(compactM[1]);
                    const sn = parseInt(compactM[2], 10);
                    episode  = parseInt(compactM[3], 10);
                    if (sn > 1 && animeName) animeName += ` Season ${sn}`;
                }

                // B2: S[N] EP[N] spaced — "Martial Universe S6 EP11" / "Versatile Mage S6 EP 12"
                if (!animeName || !episode) {
                    const spacedM = seriesSegment.match(/^(.+?)\s+S(\d+)\s+EP\s*(\d+)/i);
                    if (spacedM) {
                        animeName = cleanTitle(spacedM[1]);
                        const sn = parseInt(spacedM[2], 10);
                        episode  = parseInt(spacedM[3], 10);
                        if (sn > 1 && animeName) animeName += ` Season ${sn}`;
                    }
                }

                // B3: plain EP[N] — "The Ace Censor EP26" / "Fox Spirit Matchmaker EP 69"
                if (!animeName || !episode) {
                    const plainM = seriesSegment.match(
                        /^(.+?)\s+EP\s*(\d+)(?:\s*Part\s*\d+)?(?:\(\d+\))?/i
                    );
                    if (plainM) {
                        animeName = cleanTitle(plainM[1]);
                        episode   = parseInt(plainM[2], 10);
                    }
                }
            }
        }

        if (!animeName || !episode || isNaN(episode)) return null;
        return [{ animeName, episode, title: t, url, video_id, is_donghua: true, is_marathon: true }];
    };

    // ── 3d. POPS Movingtoon Parser ────────────────────────────────────────────
    //
    // Handles POPS Movingtoon channel (Detective Conan, Kizuna no Allele,
    // My Brother is A T-Rex, Bad Luck, Survival Diary of a Villainess,
    // The Flower of Dynasties, The Lost).
    //
    // All parseable titles share a single pattern:
    //   SeriesName [Part N | N] [ - ] Eps[.]? N[.] : Episode Title
    //
    // The episode title is stored as chapter_title so the player can display
    // it in the episode list alongside the number — each episode has its own
    // named title just like a real anime episode listing.
    //
    // Filtered: COMBINED EPISODE, UNCUT VERSION, SPESIAL EPISODE (multi-ep),
    //   [FULL EPISODE], Trailer/Teaser, BEST/TOP SCENE/MOMENT/CUT, HIGHLIGHT,
    //   Horror Animation / Animasi Horor, SEGERA TAYANG, Sunday Morning, OFFICIAL

    const parseConan = (t, url, block) => {
        if (_pf.conan(t)) return null;

        const video_id = extractVideoId(url);
        if (!video_id) return null;

        // Strip "Anime - " prefix noise (e.g. "Anime - Bad Luck Eps 29: ...")
        let s = t.replace(/^Anime\s*-\s*/i, '').trim();

        // ── Core match ────────────────────────────────────────────────────────
        // Matches:  SeriesName [ - ] Eps[.]? N[.] : Episode Title
        // Handles Ep/Eps, optional dot, optional leading dash separator
        const m = s.match(/^(.+?)\s+(?:-\s+)?Eps?\.?\s*(\d+)\.?\s*:\s*(.+)/i);
        if (!m) return null;

        let animeName      = m[1].replace(/\s+-\s*$/, '').trim(); // trim trailing dash if any
        const episode      = parseInt(m[2], 10);
        const chapter_title = m[3].trim();

        if (isNaN(episode) || !chapter_title) return null;

        return [{ animeName, episode, chapter_title, title: t, url, video_id }];
    };

    // ── 4. Pipeline Dispatcher ────────────────────────────────────────────────

    const parseContent = (content) => {
        const pairs = extractPairs(content);
        const flatVideos = [];

        for (const pair of pairs) {
            const { title, url, rawBlock } = pair;

            // Global Drop Filter: skip English dubs, PVs, membership walls (ULTRA), and members-only content
            if (_globalFilter(title)) continue;

            let parsedArray = null;

            // 1. Route ALL Indonesian dubs to parseDub first
            if (/(id\s*dub|id-dub|bahasa\s*indonesia)/i.test(title) || /【Dub Indonesia】/.test(title)) {
                parsedArray = parseDub(title, url, rawBlock);
            }
            // 2. Channel Specific Routing (now allow JP dub only when dub present)
            else if (/【Ani-One Indonesia】/.test(title)) {
                if (/\b\w+\s*dub\b/i.test(title) && !/(jp\s*dub|japanese\s*dub)/i.test(title)) continue;
                parsedArray = parseAniOne(title, url, rawBlock);
            } else if (/【Ani-One Asia】|【Ani-One】/i.test(title)) {
                if (/\b\w+\s*dub\b/i.test(title) && !/(jp\s*dub|japanese\s*dub)/i.test(title)) continue;
                parsedArray = parseAniOneAsia(title, url, rawBlock);
            } else if (/【Ani-Mi Asia】/.test(title)) {
                if (/\b\w+\s*dub\b/i.test(title) && !/(jp\s*dub|japanese\s*dub)/i.test(title)) continue;
                parsedArray = parseAniMiAsia(title, url, rawBlock);
            }
            // 3. Other channels
            else if (/(id\s*dub|id-dub|bahasa\s*indonesia)/i.test(title)) {
                // (redundant catch — already handled above, but kept harmlessly)
                parsedArray = parseDub(title, url, rawBlock);
            } else if (/\[Takarir Indonesia\]/i.test(title) || /Muse Indonesia/i.test(title)) {
                parsedArray = parseTakarir(title, url, rawBlock);
            } else if (/It's Anime/i.test(title)) {
                parsedArray = parseItsAnime(title, url, rawBlock);
            } else if (/TROPICS ENTERTAINMENT/.test(title) || /【Subtitle Indonesia】/.test(title)) {
                parsedArray = parseTropics(title, url, rawBlock);
            } else if (/YOUKU ANIMATION|YOUKU ANIME|优酷动漫|Animation-YOUKU|\| YOUKU\b/i.test(title)) {
                parsedArray = parseYouku(title, url, rawBlock);
            } else if (/YUEWEN ANIMATION|Yuewen Animation/i.test(title)) {
                parsedArray = parseYuewen(title, url, rawBlock);
            } else if (
                /^DETECTIVE CONAN\b|^KIZUNA NO ALLELE\b|^My Brother is.+T-Rex\b|^My Brother Is.+T-Rex\b/i.test(title) ||
                /^Bad Luck\s+Eps?\b|^Anime\s*-\s*Bad Luck\b/i.test(title) ||
                /^Survival Diary of a Villainess\b|^The Flower of Dynasties\b|^The Lost\s+Eps?\b/i.test(title)
            ) {
                parsedArray = parseConan(title, url, rawBlock);
            }
            // Custom parsers from config — checked last, after all built-in parsers
            else {
                const customParsers = _config.customParsers || [];
                for (const cp of customParsers) {
                    if (!cp.channelMatch) continue;
                    const matchRe = _toRegex(cp.channelMatch);
                    if (matchRe && matchRe.test(title)) {
                        parsedArray = _runCustomParser(cp, title, url, rawBlock);
                        break;
                    }
                }
            }

            if (parsedArray) flatVideos.push(...parsedArray);
        }

        return groupVideos(flatVideos);
    };

    // ── 5. Intelligent Grouping ───────────────────────────────────────────────

    // ── _malResolver hook ─────────────────────────────────────────────────────
    // Optional. Set from index.html BEFORE parseMultiple() is called:
    //   AnimeUpdater.setMalResolver(name => AnimeMetadata.findRecord(name))
    //
    // When set, each video is pre-annotated with its MAL ID before bucketing.
    // groupVideos then merges buckets sharing the same MAL ID (no conflict check
    // needed — same MAL ID = same show). Fixes:
    //   • Appraisal Skill: Ani-One Indonesia truncated name ≠ full Ani-One Asia name
    //   • 多羅羅 ep9 vs Dororo (CJK ↔ Latin alias)
    // update_data.js never requires metadata.js. Node CLI is unaffected.
    let _malResolver = null;
    const setMalResolver = (fn) => { _malResolver = (typeof fn === 'function') ? fn : null; };

    const groupVideos = (videos) => {
        // ── Phase 1: Annotate videos with MAL ID (video-level, before bucketing) ──
        // If _malResolver is set, look up each video's animeName in the offline DB.
        // We stamp only _malId — NOT _dbTitle — on each video.
        //
        // Why no _dbTitle: the DB canonical title is often Japanese ("Shiguang
        // Dailiren", "Tensei Kizoku...") which would override the user-facing
        // Indonesian channel name chosen later in Phase 5. The _malId is used
        // exclusively for grouping (Phase 3); the display name always comes from
        // the raw channel animeName (most-frequent Ani-One Indonesia name).
        //
        // Cache by animeName: 14K videos share ~600 unique names. Without a cache,
        // each call scans 181K titleIndex keys → ~2.7B ops → timeout.
        if (_malResolver) {
            const resolverCache = new Map();
            for (const v of videos) {
                let malId;
                if (resolverCache.has(v.animeName)) {
                    malId = resolverCache.get(v.animeName);
                } else {
                    const rec = _malResolver(v.animeName) || null;
                    malId = rec ? (rec.malId || null) : null;
                    resolverCache.set(v.animeName, malId);
                }
                if (malId) v._malId = malId;
            }
        }

        // ── Phase 2: Initial bucketing by normalised name ─────────────────────
        let buckets = [];
        for (const v of videos) {
            const norm = normalizeForCompare(v.animeName);
            let found = buckets.find(b => b.norm === norm);
            if (!found) {
                found = { norm, displayNames: new Set(), videos: [] };
                buckets.push(found);
            }
            found.displayNames.add(v.animeName);
            found.videos.push(v);
        }

        // ── Dub/sub bucket detector ───────────────────────────────────────────
        // A bucket is a "dub" bucket if any of its videos has animeName that ends
        // with "(Dub Indo)" or equivalent. Dub and sub buckets must NEVER merge —
        // they are separate cards even when they share a MAL ID or episode range.
        const bucketIsDub = b =>
            b.videos.some(v => /\(dub\s*indo\)/i.test(v.animeName));

        // ── Phase 3: MAL-ID merge (only when _malResolver was set) ────────────
        // Merges buckets that the offline DB identifies as the same show.
        // IMPORTANT: only merge sub+sub or dub+dub — never cross the dub/sub line.
        // This lets Ani-One Asia sub fill gaps in Ani-One Indonesia sub (ep 15!)
        // without accidentally joining dub eps 1-12 with sub eps 13-24.
        if (_malResolver) {
            // Separate MAL maps for sub and dub — they never share canonical slots
            const malMapSub = new Map();
            const malMapDub = new Map();
            for (let i = 0; i < buckets.length; i++) {
                const malId = buckets[i].videos.find(v => v._malId)?._malId;
                if (!malId) continue;
                const isDub = bucketIsDub(buckets[i]);
                const malMap = isDub ? malMapDub : malMapSub;
                if (!malMap.has(malId)) { malMap.set(malId, i); continue; }
                const ci = malMap.get(malId);
                // ── Episode conflict guard (same rule as Phase 4) ────────────
                // When the resolver maps two different seasons to the same malId
                // (e.g. all Iruma seasons share "Welcome to Demon School! Iruma-kun"
                // as a synonym → all resolve to S1's malId), a blind merge here
                // would silently overwrite earlier seasons with later ones during
                // buildEntry dedup. Apply the same < 2 conflict threshold Phase 4
                // uses: if the two buckets share ≥ 2 episode numbers they are
                // different seasons of the same franchise, not the same show with
                // a gap — keep them as separate entries.
                const epSetPhase3 = new Set(buckets[ci].videos.map(v => v.episode));
                let conflictsPhase3 = 0;
                for (const v of buckets[i].videos) { if (epSetPhase3.has(v.episode)) conflictsPhase3++; }
                if (conflictsPhase3 >= 2) continue;
                buckets[i].displayNames.forEach(n => buckets[ci].displayNames.add(n));
                buckets[ci].videos.push(...buckets[i].videos);
                buckets.splice(i, 1);
                i--;
            }
        }

        // ── Phase 4: Fuzzy merge with conflict threshold ───────────────────────
        // Bug 2 fix: guard includes() — ''.includes(x) === true always, so CJK
        // buckets with empty latin-norm would otherwise merge with everything.
        // Dub/sub guard: never fuzzy-merge a dub bucket with a sub bucket.
        let merged = true;
        while (merged) {
            merged = false;
            for (let i = 0; i < buckets.length; i++) {
                for (let j = i + 1; j < buckets.length; j++) {
                    const b1 = buckets[i], b2 = buckets[j];

                    // Never merge dub bucket with sub bucket
                    if (bucketIsDub(b1) !== bucketIsDub(b2)) continue;

                    let isRelated = b1.norm.length > 0 && b2.norm.length > 0 &&
                        (b1.norm.includes(b2.norm) || b2.norm.includes(b1.norm));
                    if (!isRelated && Math.abs(b1.norm.length - b2.norm.length) <= 3) {
                        if (levenshtein(b1.norm, b2.norm) <= 2) isRelated = true;
                    }
                    if (!isRelated) continue;

                    let conflicts = 0;
                    const epSet = new Set(b1.videos.map(v => v.episode));
                    for (const v2 of b2.videos) {
                        if (epSet.has(v2.episode)) conflicts++;
                    }
                    if (conflicts < 2) {
                        b2.displayNames.forEach(name => b1.displayNames.add(name));
                        b1.videos.push(...b2.videos);
                        b1.norm = b1.norm.length < b2.norm.length ? b1.norm : b2.norm;
                        buckets.splice(j, 1);
                        merged = true;
                        break;
                    }
                }
                if (merged) break;
            }
        }

        // ── Phase 5: Build finalMap — canonical name + dedup ─────────────────
        // ── Phase 5: Build finalMap — canonical name + dedup ─────────────────
        const finalMap = new Map();
        for (const b of buckets) {
            // Name priority:
            //   1. Offline DB canonical title (from MAL pre-annotation) — never truncated
            //   2. First Ani-One Indonesia video's animeName — preferred regional name
            //   3. Shortest displayName — legacy fallback
            // ── Name selection ───────────────────────────────────────────────
            // Priority:
            //   1. Most-frequent Ani-One Indonesia animeName (_aniOneId flag)
            //      - Frequency vote fixes minority variants (Shoshimin ep1 no-colon
            //        loses to ep2-22 with colon; 多羅羅 ep9 loses to 23 Dororo eps)
            //   2. Most-common displayName overall (fallback for non-Ani-One ID sources)
            //
            // _dbTitle is intentionally NOT used here. DB canonical titles are often
            // Japanese ("Shiguang Dailiren", "Tensei Kizoku...") which would replace
            // the user-facing Indonesian channel names. _malId is used only for
            // grouping (Phase 3); the display name always comes from the raw data.
            const aniOneFreq = new Map();
            for (const v of b.videos) {
                if (!v._aniOneId) continue;
                aniOneFreq.set(v.animeName, (aniOneFreq.get(v.animeName) || 0) + 1);
            }
            const aniOneIdName = aniOneFreq.size > 0
                ? [...aniOneFreq.entries()].sort((a, b) => b[1] - a[1])[0][0]
                : null;

            // Most-common displayName fallback (frequency, not length)
            const nameFreq = new Map();
            for (const v of b.videos) nameFreq.set(v.animeName, (nameFreq.get(v.animeName) || 0) + 1);
            const mostCommon = [...nameFreq.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
                            || Array.from(b.displayNames)[0];

            const bestName = aniOneIdName || mostCommon;

            // Dedup by video_id. When NO episode conflict (multiple sources for
            // the same episode number), prefer Ani-One Indonesia video for that slot.
            const uniqueVideos = new Map();
            // Pass 1: Ani-One Indonesia gets priority slots
            for (const v of b.videos) {
                if (!v._aniOneId) continue;
                const k = v.start_seconds !== undefined ? `${v.video_id}_ep${v.episode}` : v.video_id;
                if (!uniqueVideos.has(k)) uniqueVideos.set(k, v);
            }
            // Pass 2: fill remaining slots from other sources
            for (const v of b.videos) {
                const k = v.start_seconds !== undefined ? `${v.video_id}_ep${v.episode}` : v.video_id;
                if (!uniqueVideos.has(k)) uniqueVideos.set(k, v);
            }
            // Strip internal flags before storing
            const cleanVideos = new Map();
            for (const [k, v] of uniqueVideos) {
                const { _malId, _dbTitle, _aniOneId, ...rest } = v;
                cleanVideos.set(k, rest);
            }
            finalMap.set(bestName, cleanVideos);
        }

        return finalMap;
    };


    const parseMultiple = (contentArray) => {
        // Process each file separately to preserve format detection
        const allGroups = [];
        for (const content of contentArray) {
            allGroups.push(parseContent(content));
        }

        // Merge all groups into one Map
        const combined = new Map();
        for (const groups of allGroups) {
            groups.forEach((videoMap, animeName) => {
                if (!combined.has(animeName)) {
                    combined.set(animeName, new Map());
                }
                const dest = combined.get(animeName);
                videoMap.forEach((v, key) => {
                    if (!dest.has(key)) dest.set(key, v);
                });
            });
        }
        return combined;
    };

    // ── 6. Build Entry ────────────────────────────────────────────────────────

    const buildEntry = (name, videos) => {
        videos.sort((a, b) => a.episode - b.episode);

        const seen = {};
        videos = videos.filter(v => {
            const k = v.start_seconds !== undefined ? v.episode + '_' + v.start_seconds : v.episode;
            if (seen[k]) return false;
            seen[k] = true;
            return true;
        });

        const first = videos[0];

        // Safer marathon detection:
        // - If any video contains chapter timestamps (start_seconds) -> marathon
        // - Otherwise require >1 videos all explicitly flagged by parsers
        const hasChaptered = videos.some(v => v.start_seconds !== undefined);
        const allFlaggedMarathon = videos.length > 1 && videos.every(v => v.is_marathon === true);
        const isMarathon = hasChaptered || allFlaggedMarathon;

        const isDonghua = videos.some(v => v.is_donghua === true);

        return {
            name,
            videos,
            episode_count: videos.length,
            thumbnail_video_id: first ? first.video_id : null,
            min_episode: first ? first.episode : null,
            marathon_video_id: isMarathon ? first.video_id : null,
            marathon_title: isMarathon ? name : null,
            is_donghua: isDonghua
        };
    };

    // ── 7. Data Merging ───────────────────────────────────────────────────────

    const mergeData = (existingData, combinedGroups) => {
        const existing = (existingData && existingData.anime_list) ? existingData.anime_list : [];
        const existingMap = new Map(existing.map(e => [e.name, e]));
        const stats = { added: 0, updated: 0, removed: 0 };
        const newList = [];

        // 1. Process every anime that came from the parsed text files
        combinedGroups.forEach((videoMap, animeName) => {
            const newVideos = Array.from(videoMap.values());
            if (newVideos.length === 0) return;

            if (existingMap.has(animeName)) {
                // EXISTING ANIME: merge saved episodes + incoming episodes.
                // Incoming episodes overwrite the same episode slot (same key)
                // so re-uploads always pick up corrected video_ids.
                // Old episodes NOT present in the new file are kept (additive).
                stats.updated++;
                const oldAnime = existingMap.get(animeName);
                const videoDedup = new Map();

                // Add saved episodes first (lower priority)
                oldAnime.videos.forEach(v => {
                    const k = v.start_seconds !== undefined
                        ? v.episode + '_' + v.start_seconds
                        : String(v.episode);
                    videoDedup.set(k, v);
                });

                // Add incoming episodes (higher priority — overwrites same slot)
                newVideos.forEach(v => {
                    const k = v.start_seconds !== undefined
                        ? v.episode + '_' + v.start_seconds
                        : String(v.episode);
                    videoDedup.set(k, v);
                });

                newList.push(buildEntry(animeName, Array.from(videoDedup.values())));
                existingMap.delete(animeName); // mark as handled
            } else {
                // BRAND NEW ANIME
                stats.added++;
                newList.push(buildEntry(animeName, newVideos));
            }
        });

        // 2. Keep all old anime that were NOT in the uploaded file (non-destructive append)
        //    These show up as neither added nor updated — they just carry over.
        //    The SYNC confirm in index.html handles the case where the caller
        //    wants to remove them; it adds them back into combinedGroups before
        //    calling mergeData so they pass through branch 1 above unchanged.
        existingMap.forEach((oldAnime) => {
            newList.push(oldAnime);
        });

        // Count removals: entries still in existingMap were not touched at all.
        // In practice this is always 0 here because index.html's SYNC dialog
        // either adds them back to combinedGroups (append) or doesn't (sync).
        // We still expose stats.removed for Node CLI reporting.
        stats.removed = 0; // handled by caller's SYNC logic, not here

        newList.sort((a, b) => a.name.localeCompare(b.name));
        const now = (typeof Date !== 'undefined') ? new Date().toISOString().slice(0, 10) : 'unknown';

        return {
            data: { anime_list: newList, total_series: newList.length, last_updated: now },
            stats
        };
    };

    // ── 8. Storage ───────────────────────────────────────────────────────────

    const saveLocal = (dataObj) => {
        if (typeof localStorage === 'undefined') return false;
        try {
            localStorage.setItem(LS_KEY, JSON.stringify(dataObj));
            return true;
        } catch(e) {
            console.warn('AnimeUpdater: localStorage write failed —', e.message);
            return false;
        }
    };

    const loadLocal = () => {
        if (typeof localStorage === 'undefined') return null;
        try {
            const raw = localStorage.getItem(LS_KEY);
            return raw ? JSON.parse(raw) : null;
        } catch(e) { return null; }
    };

    const loadData = async () => {
        // 1. Try combined.txt from relative dir
        if (typeof fetch !== 'undefined') {
            try {
                const base = (typeof location !== 'undefined') ? location.href.replace(/\/[^\/]*$/, '/') : '';
                const r2 = await fetch(base + 'combined.txt', { cache: 'no-cache' });
                if (r2.ok) {
                    const txt = await r2.text();
                    const groups = parseContent(txt);
                    const merged = mergeData(null, groups);
                    console.log('AnimeUpdater: Loaded from relative combined.txt');
                    saveLocal(merged.data);
                    return merged.data;
                }
            } catch(e) {}
        }


        return null;
    };

    const saveData = async (dataObj, suggestedName = 'anime_data.json') => {
        const json = JSON.stringify(dataObj, null, 2);

        if (typeof window !== 'undefined' && window.showSaveFilePicker) {
            try {
                const handle = await window.showSaveFilePicker({
                    suggestedName,
                    types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }]
                });
                const writable = await handle.createWritable();
                await writable.write(json);
                await writable.close();
                return { ok: true, method: 'filePicker' };
            } catch(e) {
                if (e.name === 'AbortError') return { ok: false, method: 'cancelled' };
            }
        }

        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url; a.download = suggestedName;
        document.body.appendChild(a); a.click();
        setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
        return { ok: true, method: 'download' };
    };

    // ── Node.js auto-run ──────────────────────────────────────────────────────
    //
    // Supports two invocation styles:
    //   1. node update_data.js              — __dirname = script folder
    //   2. curl -sL .../update_data.js | node — __dirname is undefined (stdin)
    //      Falls back to process.cwd() so the script reads filtered*.txt from
    //      whichever directory you ran curl from.
    //
    // Optional metadata.js integration (MAL resolver):
    //   If metadata.js exists in the same directory, the script loads it and
    //   calls setMalResolver so groupVideos can merge buckets by MAL ID.
    //   metadata.js handles its own DB loading (local file → GitHub download).
    //   If metadata.js is unavailable or its DB load fails, parsing continues
    //   without the resolver (standard fuzzy grouping only).

    if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
        const fs   = require('fs');
        const path = require('path');

        // __dirname is undefined when piped via stdin (curl | node).
        // Fall back to process.cwd() so relative paths still resolve.
        const DIR = (typeof __dirname !== 'undefined' && __dirname)
            ? __dirname
            : process.cwd();

        const JSON_FILE = path.join(DIR, 'anime_data.json');

        const txtFiles = fs.readdirSync(DIR)
            .filter(f => /^filtered.*\.txt$/i.test(f))
            .sort()
            .map(f => path.join(DIR, f));

        console.log('Found ' + txtFiles.length + ' filtered*.txt file(s):');
        txtFiles.forEach(f => console.log('   ' + path.basename(f)));

        if (txtFiles.length === 0) {
            console.log('Nothing to do.');
            process.exit(0);
        }

        const contents = txtFiles.map(f => {
            console.log('Parsing ' + path.basename(f) + '...');
            return fs.readFileSync(f, 'utf8');
        });

        // ── Try to load metadata.js as MAL resolver ───────────────────────────
        // metadata.js is a sibling UMD module. We attempt to require it, ask it
        // to load the offline DB (with its own local→GitHub fallback), then wire
        // it up as the resolver. If anything fails we log a warning and continue
        // without the resolver.
        const metaPath = path.join(DIR, 'metadata.js');
        const _run = async () => {
            let resolverReady = false;

            if (fs.existsSync(metaPath)) {
                try {
                    const Meta = require(metaPath);
                    console.log('[MAL] metadata.js found — loading offline DB...');
                    await new Promise((resolve, reject) => {
                        // loadOfflineDb accepts a logCallback and returns a Promise.
                        // We pass a simple logger and give it 120 s to download.
                        const timer = setTimeout(() => reject(new Error('timeout')), 120000);
                        Meta.loadOfflineDb(msg => process.stdout.write('  ' + msg + '\n'))
                            .then(db => { clearTimeout(timer); resolve(db); })
                            .catch(err => { clearTimeout(timer); reject(err); });
                    });
                    // Wire up resolver. findRecord returns {malId, ...} or null.
                    setMalResolver(name => Meta.findRecord(name));
                    resolverReady = true;
                    console.log('[MAL] Resolver active — grouping with MAL-ID merge.');
                } catch(e) {
                    console.warn('[MAL] metadata.js load failed (' + e.message + ') — using standard grouping.');
                }
            } else {
                console.log('[MAL] metadata.js not found in ' + DIR + ' — using standard grouping.');
            }

            // ── Parse and merge ───────────────────────────────────────────────
            const combinedGroups = parseMultiple(contents);
            console.log('Parsed ' + combinedGroups.size + ' unique anime series.');

            if (resolverReady) {
                // After parsing with resolver active, clear it so future require()
                // calls (if any) start fresh.
                setMalResolver(null);
            }

            let existingData = null;
            if (fs.existsSync(JSON_FILE)) {
                existingData = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
                console.log('Loaded existing JSON: ' + existingData.anime_list.length + ' entries.');
            } else {
                console.log('No existing anime_data.json — creating fresh.');
            }

            const existingMap = existingData
                ? new Map(existingData.anime_list.map(e => [e.name, e]))
                : new Map();

            const result = mergeData(existingData, combinedGroups);
            const data = result.data, stats = result.stats;

            combinedGroups.forEach((_, name) => { if (!existingMap.has(name)) console.log('  + ADD: ' + name); });
            existingMap.forEach((_, name) => { if (!combinedGroups.has(name)) console.log('  - REMOVE: ' + name); });

            fs.writeFileSync(JSON_FILE, JSON.stringify(data, null, 2), 'utf8');
            const totalEps = data.anime_list.reduce((s, a) => s + a.episode_count, 0);
            console.log('\nDone! anime_data.json updated.');
            console.log('  Series: ' + data.total_series + ' | Episodes: ' + totalEps);
            console.log('  Added: ' + stats.added + ' | Updated: ' + stats.updated + ' | Removed: ' + stats.removed);
        };

        _run().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
    }

    return { parseContent, parseMultiple, mergeData, buildEntry, saveLocal, loadLocal, loadData, saveData, setMalResolver };
}));
