// Nested Emphasis Fixer for SillyTavern  (v1.2.0)
//
// Finds *italic spans* that contain another *italic* span and either
//   - "strip": removes the inner asterisks, or
//   - "style": swaps them for a styled <span class="nef-emph"> (see style.css)
//
// Two delivery methods (chosen automatically):
//   1. Render-time hook (messageFormatter.addHook): fixes text on its way to the
//      screen, never touches saved chat data. Only exists on newer/staging builds.
//   2. Fallback: rewrites the saved message on MESSAGE_RECEIVED / MESSAGE_SENT,
//      before it is rendered.

(() => {
    'use strict';

    const MODULE = 'nested_emphasis_fixer';
    const LOG = '[NestedEmphasisFixer]';
    const SPAN_CLASS = 'nef-emph';
    // Private-use characters: survive Markdown untouched; swapped for <span> after it.
    const MARK_OPEN = '\uE000';
    const MARK_CLOSE = '\uE001';
    const DEFAULTS = { enabled: true, mode: 'strip', style: 'glow', fixUser: true, preferRenderHook: true };

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

    const BREAK_TAG_RE = /^<\/?(br|p|div|hr|li|ul|ol|blockquote|h[1-6]|table|tr|td|th|pre)\b/i;

    /** What replaces an inner asterisk, per mode. */
    function delimiters(mode) {
        if (mode === 'style') return [`<span class="${SPAN_CLASS}">`, '</span>'];
        if (mode === 'marker') return [MARK_OPEN, MARK_CLOSE];
        return ['', '']; // strip
    }

    function fixParagraph(par, mode) {
        if (!par.includes('*')) return par;

        const codeRanges = [...par.matchAll(/`[^`\n]*`/g)].map((m) => [m.index, m.index + m[0].length]);

        // HTML tags (e.g. <font color="...">) must be invisible when judging what sits
        // next to an asterisk: in `done.*</font>` the `*` is really followed by whatever
        // comes after the tag, not by '<'. Line-break-like tags count as whitespace.
        const tags = [...par.matchAll(/<\/?[A-Za-z][^<>]*>/g)].map((m) => ({
            s: m.index,
            e: m.index + m[0].length,
            brk: BREAK_TAG_RE.test(m[0]),
        }));
        const insideTag = (i) => tags.some((t) => i >= t.s && i < t.e);
        const prevChar = (i) => {
            let j = i - 1;
            for (;;) {
                const t = tags.find((x) => x.e === j + 1);
                if (!t) return par[j];
                if (t.brk) return ' ';
                j = t.s - 1;
            }
        };
        const nextChar = (i) => {
            let j = i + 1;
            for (;;) {
                const t = tags.find((x) => x.s === j);
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
            if (codeRanges.some(([a, b]) => i >= a && i < b)) continue;
            if (insideTag(i)) continue; // e.g. an asterisk inside an attribute value
            if (par[i - 1] === '\\') continue;
            const role = classify(prevChar(i), nextChar(i));
            if (role) tokens.push({ i, role });
        }

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

    function fixText(text, mode) {
        if (typeof text !== 'string' || !text.includes('*')) return text;
        return text
            .split(/(```[\s\S]*?```)/g) // odd chunks = fenced code, untouched
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

    const markersToHtml = (s) =>
        s.includes(MARK_OPEN) || s.includes(MARK_CLOSE)
            ? s.split(MARK_OPEN).join(`<span class="${SPAN_CLASS}">`).split(MARK_CLOSE).join('</span>')
            : s;

    const SPAN_RE = new RegExp(`<span class="${SPAN_CLASS}">([\\s\\S]*?)</span>`, 'g');
    const stripSpans = (s) => (typeof s === 'string' ? s.replace(SPAN_RE, '$1') : s);

    /** Fix msg.mes and every stored swipe. Returns true if anything changed. */
    function fixMessage(msg, mode) {
        if (!msg || typeof msg.mes !== 'string') return false;
        let changed = false;

        const fixedMes = fixText(msg.mes, mode);
        if (fixedMes !== msg.mes) {
            msg.mes = fixedMes;
            changed = true;
        }
        if (Array.isArray(msg.swipes)) {
            msg.swipes = msg.swipes.map((s) => {
                const f = fixText(s, mode);
                if (f !== s) changed = true;
                return f;
            });
        }
        return changed;
    }

    // Allow running the core in Node for tests; harmless inside SillyTavern.
    if (typeof module !== 'undefined' && module.exports) {
        module.exports = { fixText, fixMessage, stripSpans, markersToHtml };
    }

    /* ------------------------------------------------------------------ *
     *  SillyTavern integration
     * ------------------------------------------------------------------ */

    if (typeof SillyTavern === 'undefined') return;

    const state = { renderHookInstalled: false };

    function loadSettings() {
        const { extensionSettings } = SillyTavern.getContext();
        if (!extensionSettings[MODULE]) extensionSettings[MODULE] = {};
        for (const [k, v] of Object.entries(DEFAULTS)) {
            if (extensionSettings[MODULE][k] === undefined) extensionSettings[MODULE][k] = v;
        }
        return extensionSettings[MODULE];
    }

    const save = () => SillyTavern.getContext().saveSettingsDebounced();
    const applyStyleAttr = (s) => { document.body.dataset.nefStyle = s.style; };
    const usingRenderHook = (s) => state.renderHookInstalled && s.preferRenderHook;

    /** Method 1: render-time hook (documented as a staging-branch feature). */
    function tryInstallRenderHook(ctx) {
        const mf = ctx.messageFormatter;
        if (!mf || typeof mf.addHook !== 'function') return false;
        const stage = mf.stage || {};
        try {
            mf.addHook(
                (mes, c) => {
                    const s = loadSettings();
                    if (!s.enabled || !s.preferRenderHook) return mes;
                    if (c && c.isUser && !s.fixUser) return mes;
                    return fixText(mes, s.mode === 'style' ? 'marker' : 'strip');
                },
                { stage: stage.AFTER_REGEX ?? 'afterRegex' },
            );
            mf.addHook((mes) => markersToHtml(mes), { stage: stage.AFTER_MARKDOWN ?? 'afterMarkdown' });
            return true;
        } catch (err) {
            console.warn(LOG, 'messageFormatter hook registration failed, using fallback:', err);
            return false;
        }
    }

    /** Method 2: fix the saved message before it is rendered. */
    function onMessageFixEvent(isUserEvent) {
        return (messageId) => {
            const s = loadSettings();
            if (!s.enabled || usingRenderHook(s)) return;
            if (isUserEvent && !s.fixUser) return;
            const { chat } = SillyTavern.getContext();
            const changed = fixMessage(chat[messageId], s.mode);
            if (changed) console.debug(LOG, 'fixed message', messageId);
        };
    }

    async function scanChat() {
        const s = loadSettings();
        const ctx = SillyTavern.getContext();
        let count = 0;
        ctx.chat.forEach((msg, i) => {
            if (fixMessage(msg, s.mode)) {
                count++;
                if (typeof ctx.updateMessageBlock === 'function') ctx.updateMessageBlock(i, msg);
            }
        });
        if (count > 0 && typeof ctx.saveChat === 'function') await ctx.saveChat();
        toastr.success(`Nested Emphasis Fixer: rewrote ${count} message(s).`);
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
                    <small id="nef_status" class="nef-row"></small>
                    <label class="checkbox_label nef-row">
                        <input type="checkbox" id="nef_enabled">
                        <span>Enabled</span>
                    </label>
                    <label class="checkbox_label nef-row">
                        <input type="checkbox" id="nef_fixuser">
                        <span>Also fix my own messages</span>
                    </label>
                    <label class="checkbox_label nef-row">
                        <input type="checkbox" id="nef_hook">
                        <span>Prefer render-time hook when available</span>
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

        const refreshStatus = () => {
            $('#nef_status').text(
                usingRenderHook(s)
                    ? 'Active method: render-time hook (saved messages are not modified).'
                    : 'Active method: rewriting messages as they arrive/are sent (render-time hook ' +
                      (state.renderHookInstalled ? 'available but turned off).' : 'not available in this version).'),
            );
        };
        const refreshTest = () => {
            const t = String($('#nef_test_in').val());
            $('#nef_test_strip').text(fixText(t, 'strip'));
            $('#nef_test_style').text(fixText(t, 'style'));
        };

        $('#nef_enabled').prop('checked', s.enabled).on('change', function () { s.enabled = $(this).prop('checked'); save(); });
        $('#nef_fixuser').prop('checked', s.fixUser).on('change', function () { s.fixUser = $(this).prop('checked'); save(); });
        $('#nef_hook').prop('checked', s.preferRenderHook).on('change', function () {
            s.preferRenderHook = $(this).prop('checked');
            save();
            refreshStatus();
        });
        $('#nef_mode').val(s.mode).on('change', function () { s.mode = $(this).val(); save(); });
        $('#nef_style').val(s.style).on('change', function () { s.style = $(this).val(); applyStyleAttr(s); save(); });
        $('#nef_test_in').on('input', refreshTest);
        $('#nef_scan').on('click', scanChat);
        refreshStatus();
        refreshTest();
    }

    jQuery(() => {
        const ctx = SillyTavern.getContext();
        const s = loadSettings();
        applyStyleAttr(s);

        state.renderHookInstalled = tryInstallRenderHook(ctx);
        buildSettingsUi(s);

        const { eventSource, event_types } = ctx;
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageFixEvent(false));
        eventSource.on(event_types.MESSAGE_SENT, onMessageFixEvent(true));

        // Keep stored styled <span>s out of what the model sees (they cost tokens and
        // the model might imitate the HTML). Event names per SillyTavern's events.js.
        if (event_types.CHAT_COMPLETION_PROMPT_READY) {
            eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (data) => {
                if (!data || !Array.isArray(data.chat)) return;
                for (const m of data.chat) {
                    if (typeof m.content === 'string') m.content = stripSpans(m.content);
                }
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
