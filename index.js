// Nested Emphasis Fixer for SillyTavern  (v1.4.0)
//
// Finds *italic spans* that contain another *italic* span and either
//   - "strip": removes the inner asterisks, or
//   - "style": swaps them for a styled <span class="nef-emph"> (see style.css)
//
// Ephemerality (modelled on SillyTavern's Regex extension):
//   - Alter Chat Display:    fix text as it is rendered (needs the messageFormatter hook,
//                            a newer/staging feature). Saved chat is not modified.
//   - Alter Outgoing Prompt: fix the history sent to the model (via generate_interceptor).
//                            Saved chat is not modified.
//   - Neither checked:       rewrite the saved message itself when it arrives / is sent
//                            (irreversible). This only ever happens when the user chose it:
//                            a missing render hook no longer silently falls back to it.

(() => {
    'use strict';

    const MODULE = 'nested_emphasis_fixer';
    const LOG = '[NestedEmphasisFixer]';
    const SPAN_CLASS = 'nef-emph';
    // Private-use characters: survive Markdown untouched; swapped for <span> after it.
    const MARK_OPEN = '';
    const MARK_CLOSE = '';
    const MARKER_RE = /[]/g;
    const DEFAULTS = { enabled: true, mode: 'strip', style: 'glow', fixUser: true, alterDisplay: true, alterPrompt: true };

    /* ------------------------------------------------------------------ *
     *  Core logic (pure functions, no SillyTavern dependencies)
     * ------------------------------------------------------------------ */

    const isWs = (ch) => ch === undefined || /\s/.test(ch);
    const isPunct = (ch) => ch !== undefined && /[\p{P}\p{S}]/u.test(ch);

    /**
     * Markdown-style flanking rules for a lone '*':
     *   "open"  -> can only start emphasis  (e.g. ` *word`)
     *   "close" -> can only end emphasis    (e.g. `word* `)
     *   null    -> ambiguous (`a*b`) or stray (` * `): ignored, to stay safe
     */
    function classify(prev, next) {
        const left = !isWs(next) && (!isPunct(next) || isWs(prev) || isPunct(prev));
        const right = !isWs(prev) && (!isPunct(prev) || isWs(next) || isPunct(next));
        if (left && !right) return 'open';
        if (right && !left) return 'close';
        return null;
    }

    const TAG_RE = /<\/?[A-Za-z][^<>]*>/g;
    const BREAK_TAG_RE = /^<\/?(br|p|div|hr|li|ul|ol|blockquote|h[1-6]|table|tr|td|th|pre)\b/i;

    /** What replaces an inner asterisk, per mode. */
    function delimiters(mode) {
        if (mode === 'style') return [`<span class="${SPAN_CLASS}">`, '</span>'];
        if (mode === 'marker') return [MARK_OPEN, MARK_CLOSE];
        return ['', '']; // strip
    }

    /**
     * Marks every character that sits inside an inline code span. Follows CommonMark:
     * a run of N backticks is closed by the next run of exactly N backticks, so
     * ``a ` b`` is one code span. Linear time.
     */
    function inlineCodeMask(par) {
        const mask = new Uint8Array(par.length);
        if (!par.includes('`')) return mask;
        const runs = [];
        for (const m of par.matchAll(/`+/g)) runs.push({ s: m.index, e: m.index + m[0].length, n: m[0].length });
        // nextSame[k] = index of the next run with the same length (or -1)
        const nextSame = new Int32Array(runs.length).fill(-1);
        const seen = new Map();
        for (let k = runs.length - 1; k >= 0; k--) {
            const j = seen.get(runs[k].n);
            if (j !== undefined) nextSame[k] = j;
            seen.set(runs[k].n, k);
        }
        for (let k = 0; k < runs.length;) {
            const j = nextSame[k];
            if (j < 0) { k++; continue; }
            mask.fill(1, runs[k].s, runs[j].e);
            k = j + 1;
        }
        return mask;
    }

    function fixParagraph(par, mode) {
        if (!par.includes('*')) return par;

        const inCode = inlineCodeMask(par);

        // HTML tags (e.g. <font color="...">) must be invisible when judging what sits
        // next to an asterisk: in `done.*</font>` the `*` is really followed by whatever
        // comes after the tag, not by '<'. Line-break-like tags count as whitespace.
        // Lookups are O(1) (mask + maps) so the whole pass stays linear in the paragraph.
        const inTag = new Uint8Array(par.length);
        const tagByStart = new Map();
        const tagByEnd = new Map();
        if (par.includes('<')) {
            for (const m of par.matchAll(TAG_RE)) {
                const t = { s: m.index, e: m.index + m[0].length, brk: BREAK_TAG_RE.test(m[0]) };
                inTag.fill(1, t.s, t.e);
                tagByStart.set(t.s, t);
                tagByEnd.set(t.e, t);
            }
        }
        // Each walk only crosses the tags between this asterisk and the nearest
        // real character, so every tag is crossed at most twice in total.
        const prevChar = (i) => {
            let j = i - 1;
            for (;;) {
                const t = tagByEnd.get(j + 1);
                if (!t) return par[j];
                if (t.brk) return ' ';
                j = t.s - 1;
            }
        };
        const nextChar = (i) => {
            let j = i + 1;
            for (;;) {
                const t = tagByStart.get(j);
                if (!t) return par[j];
                if (t.brk) return ' ';
                j = t.e;
            }
        };

        // Collect single-asterisk delimiters (runs of 2+ are bold; left alone)
        const tokens = [];
        for (const m of par.matchAll(/\*+/g)) {
            if (m[0].length !== 1) continue;
            const i = m.index;
            if (inCode[i]) continue;
            if (inTag[i]) continue; // e.g. an asterisk inside an attribute value
            if (par[i - 1] === '\\') continue;
            const role = classify(prevChar(i), nextChar(i));
            if (role) tokens.push({ i, role });
        }
        if (tokens.length < 4) return par; // a nested pair needs at least 4 delimiters

        // Pair them with a stack. A pair whose opener was pushed while another
        // opener was already open is "inner".
        const stack = [];
        const inner = [];
        for (const t of tokens) {
            if (t.role === 'open') {
                stack.push(t);
            } else {
                const opener = stack.pop();
                if (opener && stack.length > 0) {
                    inner.push({ i: opener.i, kind: 'open' }, { i: t.i, kind: 'close' });
                }
            }
        }

        // Unclosed italics somewhere => can't be sure what was intended. Don't touch.
        if (stack.length > 0 || inner.length === 0) return par;

        const [openStr, closeStr] = delimiters(mode);
        inner.sort((a, b) => a.i - b.i);
        let out = '';
        let last = 0;
        for (const { i, kind } of inner) {
            out += par.slice(last, i) + (kind === 'open' ? openStr : closeStr);
            last = i + 1;
        }
        return out + par.slice(last);
    }

    // Fenced code (``` or ~~~). An unclosed fence runs to the end of the text, as in
    // CommonMark (and as while a reply is still streaming).
    const FENCE_RE = /(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g;

    function fixText(text, mode) {
        if (typeof text !== 'string' || !text.includes('*')) return text;
        return text
            .split(FENCE_RE) // odd chunks = fenced code, untouched
            .map((chunk, idx) => {
                if (idx % 2 === 1) return chunk;
                // Emphasis can't cross blank lines, so handle each paragraph separately
                return chunk
                    .split(/(\n[ \t]*\n)/)
                    .map((p, j) => (j % 2 === 1 ? p : fixParagraph(p, mode)))
                    .join('');
            })
            .join('');
    }

    /**
     * Small LRU cache for the render hook: chat loads, swipes and updateMessageBlock
     * re-render the same text many times.
     */
    const CACHE_MAX = 64;
    const cache = new Map();
    function fixTextCached(text, mode) {
        if (typeof text !== 'string' || !text.includes('*')) return text;
        const key = mode + '\u0000' + text;
        const hit = cache.get(key);
        if (hit !== undefined) {
            cache.delete(key);
            cache.set(key, hit);
            return hit;
        }
        const out = fixText(text, mode);
        cache.set(key, out);
        if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
        return out;
    }

    /**
     * Turns our private-use markers into <span>s after Markdown. Only markers in text
     * content are converted, and only in matched pairs: a marker that ended up inside a
     * tag (e.g. a link URL produced by Markdown) or without a partner is dropped, so the
     * output can never break an attribute or leave unbalanced tags.
     */
    function markersToHtml(s) {
        if (typeof s !== 'string' || !(s.includes(MARK_OPEN) || s.includes(MARK_CLOSE))) return s;
        const OPEN = `<span class="${SPAN_CLASS}">`;
        const out = [];
        const openIdx = []; // positions in `out` of still-unmatched openers
        let inTag = false;
        let quote = '';
        let buf = '';
        const flush = () => { if (buf) { out.push(buf); buf = ''; } };
        for (let i = 0; i < s.length; i++) {
            const ch = s[i];
            if (inTag) {
                if (quote) { if (ch === quote) quote = ''; }
                else if (ch === '"' || ch === "'") quote = ch;
                else if (ch === '>') inTag = false;
                if (ch !== MARK_OPEN && ch !== MARK_CLOSE) buf += ch;
                continue;
            }
            // Only a real tag start (`<a`, `</a`, `<!--`) opens a tag; a stray `a < b` does not.
            if (ch === '<' && /[A-Za-z\/!]/.test(s[i + 1] || '')) { inTag = true; buf += ch; continue; }
            if (ch === MARK_OPEN) {
                flush();
                openIdx.push(out.length);
                out.push(OPEN);
            } else if (ch === MARK_CLOSE) {
                if (openIdx.length) {
                    flush();
                    openIdx.pop();
                    out.push('</span>');
                }
            } else {
                buf += ch;
            }
        }
        flush();
        for (const k of openIdx) out[k] = ''; // unmatched opener
        return out.join('');
    }

    /**
     * Removes our own <span class="nef-emph"> wrappers (and only their matching
     * </span>) in one linear pass. Handles nested spans and unclosed openers.
     */
    const SPAN_TAG_RE = /<span\b[^<>]*>|<\/span\s*>/gi;
    const OUR_SPAN_RE = new RegExp(`^<span\\s+class=(["'])(?:custom-)?${SPAN_CLASS}\\1\\s*>$`, 'i');
    function stripSpans(s) {
        if (typeof s !== 'string' || !s.includes(SPAN_CLASS)) return s;
        const stack = [];
        let out = '';
        let last = 0;
        for (const m of s.matchAll(SPAN_TAG_RE)) {
            const tag = m[0];
            let drop;
            if (tag[1] === '/') {
                drop = stack.length ? stack.pop() : false;
            } else {
                drop = OUR_SPAN_RE.test(tag);
                stack.push(drop);
            }
            if (drop) {
                out += s.slice(last, m.index);
                last = m.index + tag.length;
            }
        }
        return out + s.slice(last);
    }

    /**
     * Ephemeral prompt fix. Replaces each changed message in `chat` (the array handed to a
     * generate_interceptor) with a modified COPY, so the original message objects, and
     * therefore the saved chat, are never altered. System/hidden messages are skipped.
     */
    function fixPromptChat(chat, { fixUser = true } = {}) {
        let changed = 0;
        for (let i = 0; i < chat.length; i++) {
            const m = chat[i];
            if (!m || m.is_system || typeof m.mes !== 'string') continue;
            if (m.is_user && !fixUser) continue;
            const fixed = stripSpans(fixText(m.mes, 'strip'));
            if (fixed === m.mes) continue;
            chat[i] = { ...m, mes: fixed };
            changed++;
        }
        return changed;
    }

    /**
     * Fix msg.mes (and the swipe it shows). With allSwipes, every stored swipe is fixed
     * too; that is only needed for the explicit "rewrite saved messages" action.
     * Returns true if anything changed.
     */
    function fixMessage(msg, mode, { allSwipes = false } = {}) {
        if (!msg || typeof msg.mes !== 'string') return false;
        let changed = false;

        const before = msg.mes;
        const fixedMes = fixText(before, mode);
        if (fixedMes !== before) {
            msg.mes = fixedMes;
            changed = true;
        }
        if (Array.isArray(msg.swipes)) {
            if (allSwipes) {
                msg.swipes = msg.swipes.map((s) => {
                    const f = fixText(s, mode);
                    if (f !== s) changed = true;
                    return f;
                });
            } else {
                const id = msg.swipe_id;
                const cur = Number.isInteger(id) ? msg.swipes[id] : undefined;
                if (typeof cur === 'string') {
                    const f = cur === before ? msg.mes : fixText(cur, mode);
                    if (f !== cur) {
                        msg.swipes[id] = f;
                        changed = true;
                    }
                }
            }
        }
        return changed;
    }

    // Allow running the core in Node for tests; harmless inside SillyTavern.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { fixText, fixTextCached, fixMessage, fixPromptChat, stripSpans, markersToHtml };
    }

    /* ------------------------------------------------------------------ *
     *  SillyTavern integration
     * ------------------------------------------------------------------ */

    if (typeof SillyTavern === 'undefined') return;

    const state = { renderHookInstalled: false, scanning: false };

    /** Reads (and once, migrates) the settings object. Called at start-up only. */
    function loadSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        const cur = extensionSettings[MODULE];
        // Migrate the 1.1/1.2 "preferRenderHook" option to "Alter Chat Display".
        if ('preferRenderHook' in cur) {
            if (cur.alterDisplay === undefined) cur.alterDisplay = cur.preferRenderHook;
            delete cur.preferRenderHook;
        }
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (cur[k] === undefined) cur[k] = v;
        }
        return cur;
    }

    // Loaded once; the settings UI mutates this same object. Hot paths (render hook,
    // prompt interceptor) read it directly instead of calling getContext() every time.
    let settings = null;
    const getSettings = () => settings ?? (settings = loadSettings());

    const save = () => SillyTavern.getContext().saveSettingsDebounced();
    const applyStyleAttr = (s) => { document.body.dataset.nefStyle = s.style; };

    /** What actually happens, given the Ephemerality checkboxes and what this build supports. */
    function plan(s) {
        const hook = state.renderHookInstalled;
        return {
            displayViaHook: s.alterDisplay && hook,
            // Same rule as the Regex extension: neither box = edit the saved text.
            // Never used as a silent fallback for a missing render hook.
            rewriteSaved: !s.alterDisplay && !s.alterPrompt,
            prompt: s.alterPrompt,
        };
    }

    function describePlan(s) {
        const p = plan(s);
        const parts = [];
        if (p.displayViaHook) parts.push('Chat display is fixed as it is rendered.');
        if (p.prompt) parts.push('The outgoing prompt is fixed.');
        if (p.rewriteSaved) parts.push('Saved messages are rewritten (irreversible).');
        if (s.alterDisplay && !state.renderHookInstalled) {
            parts.push('Alter Chat Display needs a newer SillyTavern (message formatting hook), so the chat display is NOT fixed. Saved messages are left untouched; uncheck both boxes if you want them rewritten instead.');
        }
        if (!p.rewriteSaved && p.displayViaHook !== p.prompt) {
            parts.push('You will see one thing and the model will see another.');
        }
        if (!p.displayViaHook && !p.prompt && !p.rewriteSaved) parts.push('Nothing is being fixed.');
        return parts.join(' ');
    }

    /** Alter Chat Display: render-time hook (documented as a staging-branch feature). */
    function tryInstallRenderHook(ctx) {
        const mf = ctx.messageFormatter;
        if (!mf || typeof mf.addHook !== 'function') return false;
        const stage = mf.stage || {};
        try {
            mf.addHook(
                (mes, c) => {
                    if (typeof mes !== 'string') return mes;
                    // Our markers must only ever come from us: drop any that are already
                    // in the text (from the model, a card, or pasted input).
                    if (mes.includes(MARK_OPEN) || mes.includes(MARK_CLOSE)) mes = mes.replace(MARKER_RE, '');
                    const s = getSettings();
                    if (!s.enabled || !s.alterDisplay) return mes;
                    if (c && c.isUser && !s.fixUser) return mes;
                    return fixTextCached(mes, s.mode === 'style' ? 'marker' : 'strip');
                },
                { stage: stage.AFTER_REGEX ?? 'afterRegex' },
            );
            mf.addHook((mes) => markersToHtml(mes), { stage: stage.AFTER_MARKDOWN ?? 'afterMarkdown' });
            return true;
        } catch (err) {
            console.warn(LOG, 'messageFormatter hook registration failed:', err);
            return false;
        }
    }

    /** Neither box checked: fix the saved message before it renders. */
    function onMessageFixEvent(isUserEvent) {
        return (messageId) => {
            const s = getSettings();
            if (!s.enabled || !plan(s).rewriteSaved) return;
            if (isUserEvent && !s.fixUser) return;
            const msg = SillyTavern.getContext().chat[messageId];
            if (!msg || msg.is_system) return;
            if (fixMessage(msg, s.mode)) console.debug(LOG, 'rewrote message', messageId);
        };
    }

    /**
     * Alter Outgoing Prompt: called by SillyTavern before each generation, because the manifest
     * names it in "generate_interceptor". Works for chat- and text-completion APIs alike and only
     * ever sees chat messages (never character cards or system prompts).
     */
    globalThis.nestedEmphasisFixerInterceptor = async function (chat /*, contextSize, abort, type */) {
        try {
            const s = getSettings();
            if (!s.enabled || !s.alterPrompt || !Array.isArray(chat)) return;
            const n = fixPromptChat(chat, { fixUser: s.fixUser });
            if (n) console.debug(LOG, `cleaned ${n} message(s) in the outgoing prompt`);
        } catch (err) {
            console.warn(LOG, 'prompt interceptor failed:', err);
        }
    };

    async function confirmAction(ctx, text) {
        if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE) {
            return Boolean(await ctx.callGenericPopup(text, ctx.POPUP_TYPE.CONFIRM));
        }
        return window.confirm(text);
    }

    async function scanChat() {
        if (state.scanning) return;
        const ctx = SillyTavern.getContext();
        if (!Array.isArray(ctx.chat) || ctx.chat.length === 0) {
            toastr.info('Nested Emphasis Fixer: no chat is open.');
            return;
        }
        const s = getSettings();
        const ok = await confirmAction(
            ctx,
            'Rewrite all saved messages (including every swipe) in the current chat with the current fix method? This changes the saved chat and cannot be undone.',
        );
        if (!ok) return;

        state.scanning = true;
        const $btn = $('#nef_scan').addClass('disabled');
        try {
            let count = 0;
            ctx.chat.forEach((msg, i) => {
                if (!msg || msg.is_system) return;
                if (msg.is_user && !s.fixUser) return;
                if (fixMessage(msg, s.mode, { allSwipes: true })) {
                    count++;
                    if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(i, msg);
                }
            });
            if (count > 0 && typeof ctx.saveChat === 'function') await ctx.saveChat();
            toastr.success(`Nested Emphasis Fixer: rewrote ${count} message(s).`);
        } catch (err) {
            console.error(LOG, 'rewriting saved messages failed:', err);
            toastr.error('Nested Emphasis Fixer: rewriting saved messages failed, see the console.');
        } finally {
            state.scanning = false;
            $btn.removeClass('disabled');
        }
    }

    /** Strips our span markup from a chat-completion message (string or multimodal parts). */
    function stripSpansFromMessage(m) {
        if (!m) return;
        if (typeof m.content === 'string') {
            m.content = stripSpans(m.content);
        } else if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part && typeof part.text === 'string') part.text = stripSpans(part.text);
            }
        }
    }

    function buildSettingsUi(s) {
        const html = `
        <div class="nef-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header">
                    <b>Nested Emphasis Fixer</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
                </div>
                <div class="inline-drawer-content">
                    <label class="checkbox_label nef-row">
                        <input type="checkbox" id="nef_enabled">
                        <span>Enabled</span>
                    </label>
                    <label class="checkbox_label nef-row">
                        <input type="checkbox" id="nef_fixuser">
                        <span>Also fix my own messages</span>
                    </label>
                    <div class="nef-row">
                        <label for="nef_mode">Fix method</label>
                        <select id="nef_mode" class="text_pole">
                            <option value="strip">Strip inner asterisks</option>
                            <option value="style">Replace with styled emphasis</option>
                        </select>
                    </div>
                    <div class="nef-row">
                        <label for="nef_style">Styled emphasis look</label>
                        <select id="nef_style" class="text_pole">
                            <option value="glow">Glow</option>
                            <option value="roman">Reverse italics (upright)</option>
                            <option value="bold">Bold upright</option>
                            <option value="underline">Dotted underline</option>
                        </select>
                    </div>
                    <div class="nef-row"><b>Ephemerality</b></div>
                    <label class="checkbox_label nef-row" title="Fix emphasis as messages are shown on screen. The saved chat is not modified.">
                        <input type="checkbox" id="nef_alter_display">
                        <span>Alter Chat Display</span>
                    </label>
                    <label class="checkbox_label nef-row" title="Fix emphasis in the chat history sent to the model. The saved chat is not modified.">
                        <input type="checkbox" id="nef_alter_prompt">
                        <span>Alter Outgoing Prompt</span>
                    </label>
                    <small class="nef-row">If neither box is checked, the fix is written into the saved messages themselves (irreversible).</small>
                    <small id="nef_status" class="nef-row"></small>
                    <div class="nef-row">
                        <label for="nef_test_in">Try it (type or paste text)</label>
                        <textarea id="nef_test_in" class="text_pole" rows="2">*this is a *test* of the italics fix.*</textarea>
                        <small>Strip: <code id="nef_test_strip"></code></small><br>
                        <small>Style: <code id="nef_test_style"></code></small>
                    </div>
                    <div class="nef-row">
                        <div id="nef_scan" class="menu_button">Rewrite saved messages in current chat</div>
                    </div>
                </div>
            </div>
        </div>`;
        $('#extensions_settings2').append(html);

        const refreshStatus = () => $('#nef_status').text(describePlan(s));
        let testTimer = 0;
        const refreshTest = () => {
            const t = String($('#nef_test_in').val());
            $('#nef_test_strip').text(fixText(t, 'strip'));
            $('#nef_test_style').text(fixText(t, 'style'));
        };
        // Debounced: large pastes are not re-processed on every keystroke.
        const refreshTestSoon = () => {
            clearTimeout(testTimer);
            testTimer = setTimeout(refreshTest, 150);
        };

        $('#nef_enabled').prop('checked', s.enabled).on('change', function () { s.enabled = $(this).prop('checked'); save(); });
        $('#nef_fixuser').prop('checked', s.fixUser).on('change', function () { s.fixUser = $(this).prop('checked'); save(); });
        $('#nef_alter_display').prop('checked', s.alterDisplay).on('change', function () {
            s.alterDisplay = $(this).prop('checked');
            save();
            refreshStatus();
        });
        $('#nef_alter_prompt').prop('checked', s.alterPrompt).on('change', function () {
            s.alterPrompt = $(this).prop('checked');
            save();
            refreshStatus();
        });
        $('#nef_mode').val(s.mode).on('change', function () { s.mode = $(this).val(); save(); });
        $('#nef_style').val(s.style).on('change', function () { s.style = $(this).val(); applyStyleAttr(s); save(); });
        $('#nef_test_in').on('input', refreshTestSoon);
        $('#nef_scan').on('click', scanChat);
        refreshStatus();
        refreshTest();
    }

    jQuery(() => {
        const ctx = SillyTavern.getContext();
        const s = getSettings();
        applyStyleAttr(s);

        state.renderHookInstalled = tryInstallRenderHook(ctx);
        buildSettingsUi(s);

        const { eventSource, event_types } = ctx;
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageFixEvent(false));
        eventSource.on(event_types.MESSAGE_SENT, onMessageFixEvent(true));

        // Safety net, independent of the Ephemerality settings: our own styled <span> markup
        // must never reach the model. Only spans with our exact class are removed, so the
        // rest of the prompt (cards, system prompt) is not otherwise changed.
        // (Event names per SillyTavern's events.js.)
        if (event_types.CHAT_COMPLETION_PROMPT_READY) {
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
                if (!data || !Array.isArray(data.chat)) return;
                for (const m of data.chat) stripSpansFromMessage(m);
            });
        }
        const textCompEvent = event_types.GENERATE_AFTER_COMBINE_PROMPTS;
        if (textCompEvent) {
            eventSource.on(textCompEvent, (data) => {
                if (data && typeof data.prompt === 'string') data.prompt = stripSpans(data.prompt);
            });
        }

        console.log(LOG, 'loaded. Render-time hook installed:', state.renderHookInstalled);
    });
})();
