// 阅读朗读（docs/reading-mode.md §13）：
// Web Speech API，零依赖；中文语音探针；分句队列；CSS Highlight 高亮当前句；跟随滚动。

export function createReadingTts(deps) {
    // deps: {
    //   getReader(): Element,
    //   getRate(): number, getPitch(): number, getVolume(): number,
    //   autoNext(): boolean,
    //   onFinishUnit(): void,     // 本章读完 → 自动续章
    //   onStateChange(playing): void,
    // }
    const synth = typeof speechSynthesis !== 'undefined' ? speechSynthesis : null;
    let sentences = []; // {text, range}
    let index = -1;
    let playing = false;
    let paused = false;
    let followTimer = 0;
    let followSuspendedUntil = 0;

    // probe 中文语音可用性（等 voiceschanged 最多 1.5s）
    function probe() {
        return new Promise((resolve) => {
            if (!synth) return resolve(false);
            const check = () => synth.getVoices().some((v) => /^zh/i.test(v.lang));
            if (check()) return resolve(true);
            let done = false;
            const finish = () => {
                if (done) return;
                done = true;
                resolve(check());
            };
            synth.addEventListener('voiceschanged', finish, {once: true});
            setTimeout(finish, 1500);
        });
    }

    function buildSentences(root) {
        const out = [];
        if (!root) return out;
        const blocks = root.querySelectorAll('p, h1, h2, h3, h4, h5, h6, li, blockquote, td');
        for (const el of blocks) {
            if (el.closest('.rd-tts-skip')) continue;
            // 单块内构建 字符偏移 → (node, offset) 映射
            const map = [];
            const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, {
                acceptNode(n) {
                    const p = n.parentElement;
                    return p && p.closest('.rd-tts-skip') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
                },
            });
            let n;
            let full = '';
            while ((n = walker.nextNode())) {
                map.push({node: n, start: full.length, end: full.length + n.nodeValue.length});
                full += n.nodeValue;
            }
            if (!full.trim()) continue;
            for (const seg of splitSentences(full)) {
                const range = document.createRange();
                const startPos = locate(map, seg.start);
                const endPos = locate(map, seg.end);
                if (!startPos || !endPos) continue;
                try {
                    range.setStart(startPos.node, startPos.offset);
                    range.setEnd(endPos.node, endPos.offset);
                } catch (e) {
                    continue;
                }
                out.push({text: seg.text, range});
            }
        }
        return out;
    }

    function locate(map, charOffset) {
        for (const m of map) {
            if (charOffset >= m.start && charOffset <= m.end) {
                return {node: m.node, offset: charOffset - m.start};
            }
        }
        return null;
    }

    function splitSentences(text) {
        const out = [];
        const re = /[^。！？!?…\n]+[。！？!?…]*\s*/g;
        let m;
        while ((m = re.exec(text)) !== null) {
            const seg = m[0];
            if (!seg.trim()) continue;
            if (seg.length <= 180) {
                out.push({text: seg, start: m.index, end: m.index + seg.length});
            } else {
                // 超长句按 180 字切
                for (let i = 0; i < seg.length; i += 180) {
                    const piece = seg.slice(i, i + 180);
                    if (!piece.trim()) continue;
                    out.push({text: piece, start: m.index + i, end: m.index + i + piece.length});
                }
            }
        }
        return out;
    }

    function highlightCurrent() {
        if (typeof CSS !== 'undefined' && CSS.highlights) {
            CSS.highlights.delete('rd-tts');
            const s = sentences[index];
            if (s && playing && typeof Highlight !== 'undefined') CSS.highlights.set('rd-tts', new Highlight(s.range));
        }
        if (playing && Date.now() > followSuspendedUntil) {
            const s = sentences[index];
            if (s) {
                const el = s.range.startContainer.parentElement;
                if (el) {
                    clearTimeout(followTimer);
                    followTimer = setTimeout(() => {
                        el.scrollIntoView({block: 'center', behavior: 'smooth'});
                    }, 60);
                }
            }
        }
    }

    function speakIndex(i) {
        if (!synth || i < 0 || i >= sentences.length) {
            finishUnit();
            return;
        }
        index = i;
        highlightCurrent();
        const u = new SpeechSynthesisUtterance(sentences[i].text);
        u.rate = Math.max(0.5, Math.min(2, deps.getRate ? deps.getRate() : 1));
        u.pitch = Math.max(0, Math.min(2, deps.getPitch ? deps.getPitch() : 1));
        u.volume = Math.max(0, Math.min(1, deps.getVolume ? deps.getVolume() : 1));
        u.onboundary = (ev) => {
            // 可用时按字推进高亮；不可用时保持整句高亮
            if (!playing || typeof ev.charIndex !== 'number') return;
            highlightUpTo(sentences[index], ev.charIndex);
        };
        u.onend = () => {
            if (!playing) return;
            speakIndex(i + 1);
        };
        u.onerror = () => {
            if (playing) speakIndex(i + 1);
        };
        synth.speak(u);
    }

    // highlightUpTo 把当前句高亮推进到第 charIndex 个字符处。
    function highlightUpTo(sentence, charIndex) {
        if (typeof CSS === 'undefined' || !CSS.highlights || !sentence) return;
        try {
            const range = sentence.range;
            const walker = document.createTreeWalker(
                range.commonAncestorContainer, NodeFilter.SHOW_TEXT, null);
            let acc = 0;
            const start = {node: range.startContainer, offset: range.startOffset};
            let end = null;
            let node;
            while ((node = walker.nextNode())) {
                if (!range.intersectsNode(node)) continue;
                let nodeStart = acc;
                let nodeEnd = acc + node.nodeValue.length;
                // 首尾节点需裁剪到 range 边界
                if (node === range.startContainer) nodeStart = acc + range.startOffset;
                if (node === range.endContainer) nodeEnd = acc + range.endOffset;
                if (charIndex <= nodeEnd - nodeStart) {
                    end = {node, offset: nodeStart + Math.min(charIndex, nodeEnd - nodeStart)};
                    break;
                }
                acc = nodeEnd;
            }
            if (!end) end = {node: range.endContainer, offset: range.endOffset};
            const r = document.createRange();
            r.setStart(start.node, start.offset);
            r.setEnd(end.node, end.offset);
            CSS.highlights.set('rd-tts', new Highlight(r));
        } catch (e) { /* 推进失败保持整句高亮 */ }
    }

    function finishUnit() {
        playing = false;
        paused = false;
        clearHighlight();
        if (deps.onStateChange) deps.onStateChange(false);
        if (deps.autoNext && deps.autoNext()) {
            if (deps.onFinishUnit) deps.onFinishUnit(); // 自动续章
        }
    }

    function clearHighlight() {
        if (typeof CSS !== 'undefined' && CSS.highlights) CSS.highlights.delete('rd-tts');
    }

    function stop() {
        if (synth) synth.cancel();
        playing = false;
        paused = false;
        index = -1;
        sentences = [];
        clearHighlight();
        if (deps.onStateChange) deps.onStateChange(false);
    }

    return {
        probe,
        // speakUnit 开始朗读当前正文
        speakUnit() {
            if (!synth) return false;
            stop();
            sentences = buildSentences(deps.getReader());
            if (!sentences.length) return false;
            playing = true;
            paused = false;
            if (deps.onStateChange) deps.onStateChange(true);
            speakIndex(0);
            return true;
        },
        resume() {
            if (synth && paused) {
                synth.resume();
                paused = false;
                playing = true;
                if (deps.onStateChange) deps.onStateChange(true);
            }
        },
        pause() {
            if (synth && playing && !paused) {
                synth.pause();
                paused = true;
                if (deps.onStateChange) deps.onStateChange(false);
            }
        },
        stop,
        suspendFollow(ms) {
            followSuspendedUntil = Date.now() + (ms || 3000);
        },
        get playing() { return playing; },
        get paused() { return paused; },
    };
}
