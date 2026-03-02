(function(root, factory) {
    if (typeof module !== 'undefined' && module.exports) module.exports = factory();
    else root.AnimeUpdater = factory();
}(typeof globalThis !== 'undefined' ? globalThis : this, function() {

    const LS_KEY = 'anime_data';

    // ── Helper Utilities ──────────────────────────────────────────────────────

    const extractVideoId = (url) => {
        const m = (url || '').match(/[?&]v=([a-zA-Z0-9_-]+)/);
        return m ? m[1] : null;
    };

    const isLargeRange = (start, end) => (end - start) > 3;

    const cleanTitle = (name) => name.replace(/[\.\-~]+$/, '').trim();

    const normalizeForCompare = (name) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

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
                pairs.push({ title: lines[i], url: lines[j], rawBlock });
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
        // TROPICS Dub Style: 【Dub Indonesia】《WITCH WATCH วิทช์วอทช์》｜ตอนที่ 25｜TROPICS ENTERTAINMENT
        const tropicsM = t.match(/【Dub Indonesia】《(.+?)》｜(?:Episode|ตอนที่)\s*(\d+)｜/i);
        if (tropicsM) {
            const animeName = cleanTitle(tropicsM[1]).replace(/[《》]/g, '').trim();
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
            let animeName = cleanTitle(m[1]).replace(/[《》]/g, '').trim();
            const episode = parseFloat(m[2]);
            return [{ animeName: animeName + ' (Dub Indo)', episode, title: t, url, video_id: extractVideoId(url) }];
        }

        // Try a looser fallback: title with " (ID Dub)" style or bracketed dub tags
        const looseM = t.match(/^(.+?)\s*\((?:ID|ID\s*Dub|ID\s*Sub|dub)\)/i);
        if (looseM) {
            let animeName = cleanTitle(looseM[1]).replace(/[《》]/g, '').trim();
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
        if (/^FULL EPISODE/i.test(t)) return null;
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

        return [{ animeName, episode, title: t, url, video_id: extractVideoId(url) }];
    };

    const parseAniOneAsia = (t, url, block) => {
        if (/^FULL EPISODE/i.test(t)) return null;

        const nameM = t.match(/《(.+?)》/);
        if (!nameM) return null;
        let animeName = cleanTitle(nameM[1]);

        const epM = t.match(/#(\d+(?:\.\d+)?)/);
        if (!epM) return null;
        const episode = parseFloat(epM[1]);

        const betweenNameAndEp = t.substring(t.indexOf('》') + 1, t.indexOf('#')).trim();
        const seasonM = betweenNameAndEp.match(/Season\s+(\d+)/i);
        if (seasonM) animeName += ` Season ${seasonM[1]}`;

        // keep same shape, Ani-One Asia treated as marathon in earlier refactor where appropriate
        return [{ animeName, episode, title: t, url, video_id: extractVideoId(url), is_marathon: true }];
    };

    // Ani-Mi Asia parser
    const parseAniMiAsia = (t, url, block) => {
        // Drop: PV, Highlight, Special Screening, Full Episode
        if (/(PV|Highlight|Special Screening|FULL EPISODE)/i.test(t)) return null;

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
            if (/Semua Episode/i.test(t)) return null;
            if (/\(Live-Action\)/i.test(t)) return null;
            if (/PUI PUI MOLCAR/i.test(t)) return null;
    
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
        if (/Members Only/i.test(t)) return null;
        if (/(english\s*sub|en\s*sub|en-sub)/i.test(t)) return null;

        const nameM = t.match(/《(.+?)》/);
        if (!nameM) return null;
        const animeName = cleanTitle(nameM[1]);

        const epM = t.match(/Episode\s+(\d+)/i);
        if (!epM) return null;
        const episode = parseInt(epM[1], 10);

        return [{ animeName, episode, title: `${animeName} - Episode ${episode}`, url, video_id: extractVideoId(url) }];
    };

    const parseItsAnime = (t, url, block) => {
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
        // ── Content filters ──────────────────────────────────────────────
        if (/Highlight|精彩片段|精彩看点/i.test(t)) return null;
        if (/Trailer|Tralier|预告/i.test(t)) return null;   // covers 预告话 too
        if (/^精华版/.test(t)) return null;                  // digest/recap versions
        if (/\b(OP|ED|Opening|Ending)\b/i.test(t)) return null;
        if (/全漫同庆|合集|全集/.test(t)) return null;        // promos / batch compilations
        if (/EP\d+[-–]\d+|\d+[-–]\d+集/i.test(t)) return null; // EP range videos (EP01-66 etc)
        if (/VIETDUB|JPN\s*DUB/i.test(t)) return null;      // non-sub dubs we don't want
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
        // ── Content filters ──────────────────────────────────────────────────
        if (/Trailer|TRAILER/i.test(t)) return null;
        if (/Highlight|HIGHLIGHT/i.test(t)) return null;
        if (/\bClip\b|\bCLIP\b/i.test(t)) return null;
        if (/Versi Lengkap|Versi Full|Versi Lengkep/i.test(t)) return null;
        if (/\bFULL\b/i.test(t)) return null;         // compilations: FULL EPISODE, S3 FULL, (FULL)
        if (/EP\s?\d+\s?[-–]\s?\d+/i.test(t)) return null; // EP ranges like EP01-10

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
        // ── Content filters ───────────────────────────────────────────────────
        if (/COMBINED EPISODE/i.test(t)) return null;
        if (/UNCUT VERSION/i.test(t)) return null;
        if (/SPESIAL EPISODE/i.test(t)) return null;      // multi-ep number ranges
        if (/\[FULL EPISODE\]/i.test(t)) return null;
        if (/Trailer|TRAILER|Teaser|TEASER/i.test(t)) return null;
        if (/BEST SCENE|TOP SCENE|TOP MOMENT|BEST CUT|HIGHLIGHT/i.test(t)) return null;
        if (/Horror Animation|Animasi Horor/i.test(t)) return null;
        if (/SEGERA TAYANG/i.test(t)) return null;
        if (/Sunday Morning|SMA TALKS/i.test(t)) return null;
        if (/OFFICIAL/i.test(t)) return null;

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

            // Global Drop Filter: skip explicit English dubs, PVs, and membership (ULTRA)
            if (/(en\s*dub|en-dub|\bpv\b|ULTRA】)/i.test(title)) continue;

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

            if (parsedArray) flatVideos.push(...parsedArray);
        }

        return groupVideos(flatVideos);
    };

    // ── 5. Intelligent Grouping ───────────────────────────────────────────────

    const groupVideos = (videos) => {
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

        // Fuzzy Merging with conflict threshold
        let merged = true;
        while (merged) {
            merged = false;
            for (let i = 0; i < buckets.length; i++) {
                for (let j = i + 1; j < buckets.length; j++) {
                    const b1 = buckets[i], b2 = buckets[j];

                    // Direct containment OR fuzzy match (within 2 typos)
                    let isRelated = b1.norm.includes(b2.norm) || b2.norm.includes(b1.norm);
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
                        // Pick the shortest normalized name as the representative
                        b1.norm = b1.norm.length < b2.norm.length ? b1.norm : b2.norm;
                        buckets.splice(j, 1);
                        merged = true;
                        break;
                    }
                }
                if (merged) break;
            }
        }

        const finalMap = new Map();
        for (const b of buckets) {
            const namesArr = Array.from(b.displayNames);
            namesArr.sort((a, b) => a.length - b.length);
            const bestName = namesArr[0];

            const uniqueVideos = new Map();
            for (const v of b.videos) {
                const dedupKey = v.start_seconds !== undefined ? `${v.video_id}_ep${v.episode}` : v.video_id;
                if (!uniqueVideos.has(dedupKey)) uniqueVideos.set(dedupKey, v);
            }
            finalMap.set(bestName, uniqueVideos);
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

        combinedGroups.forEach((videoMap, animeName) => {
            const videos = Array.from(videoMap.values());
            if (videos.length === 0) return;
            newList.push(buildEntry(animeName, videos));
            if (!existingMap.has(animeName)) stats.added++;
            else stats.updated++;
        });

        existingMap.forEach((_, name) => {
            if (!combinedGroups.has(name)) stats.removed++;
        });

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

        // 2. Try combined.txt from GitHub
        if (typeof fetch !== 'undefined') {
            try {
                const githubUrl = 'https://raw.githubusercontent.com/nagamuslim/anime-collection/refs/heads/main/combined.txt';
                const r3 = await fetch(githubUrl, { cache: 'no-cache' });
                if (r3.ok) {
                    const txt = await r3.text();
                    const groups = parseContent(txt);
                    const merged = mergeData(null, groups);
                    console.log('AnimeUpdater: Loaded from GitHub combined.txt');
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

    if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
        const fs = require('fs');
        const path = require('path');
        const DIR = __dirname;
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

        const combinedGroups = parseMultiple(contents);
        console.log('Parsed ' + combinedGroups.size + ' unique anime series.');

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
    }

    return { parseContent, parseMultiple, mergeData, buildEntry, saveLocal, loadLocal, loadData, saveData };
}));
