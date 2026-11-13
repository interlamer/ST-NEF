# Nested Emphasis Fixer

A SillyTavern extension that fixes broken rendering when a model puts `*emphasis*` inside an
already-italic `*span*`.

```
*This is some thought. Oops, something *important* is happening. And now rendering is broken.*
```

Markdown pairs the asterisks wrongly, so the italics break and stray asterisks show up.
This extension detects those collisions and either:

- **Strips** the inner asterisks (`*... something important is happening ...*`), or
- **Restyles** the inner word with a custom look: glow, reverse italics (upright), bold, or dotted underline.

It also works when the text is wrapped in HTML color tags such as `<font color="#ff6666">...</font>`.

## Install

In SillyTavern: **Extensions → Install extension**, paste

```
https://github.com/interlamer/ST-NEF
```

choose the install scope, and click Install. Updates are offered through the Extensions panel.

## Usage

Open **Extensions → Nested Emphasis Fixer**.

| Setting | What it does |
|---|---|
| Enabled | Master switch. |
| Also fix my own messages | Applies the fix to messages you send as well. |
| Fix method | *Strip* inner asterisks, or *Replace with styled emphasis*. |
| Styled emphasis look | Glow / Reverse italics / Bold / Dotted underline (changes apply instantly to existing messages). |
| Alter Chat Display | Fix emphasis as messages are rendered. The saved chat is not modified. |
| Alter Outgoing Prompt | Fix emphasis in the chat history sent to the model. The saved chat is not modified. |
| Try it | Paste text to preview the result of both fix methods. |
| Rewrite saved messages | Applies the current fix method to the whole open chat and saves it. |

### Ephemerality

The two checkboxes work like the ones in SillyTavern's built-in Regex extension:

| Alter Chat Display | Alter Outgoing Prompt | Result |
|---|---|---|
| ✔ | ✔ | Screen and prompt are both fixed; the saved chat is never changed. **(default)** |
| ✔ |  | Only the screen is fixed. You see one thing and the model sees another. |
|  | ✔ | Only the prompt is fixed. The model sees clean text; the screen is not fixed. |
|  |  | The fix is written into the saved messages themselves (irreversible). |

*Alter Chat Display* needs SillyTavern's message-formatting hook (documented as a staging-branch
feature at the time of writing). If your version doesn't have it, the chat display is simply not
fixed and the settings panel says so. Since 1.4.0 the extension no longer silently falls back to
rewriting saved messages: that only happens when you uncheck both boxes yourself. In that mode a
reply that is still streaming may briefly render with the original asterisks.

The status line under the checkboxes always describes what is actually happening.

## How it works

For each paragraph, every lone `*` is classified as an opener or closer using Markdown's
flanking rules (HTML tags are treated as invisible, line-break tags as whitespace). A stack pairs them
up; any pair opened while another italic is already open is "inner" and gets fixed.

It deliberately does nothing when it can't be sure:

- italics that are never closed in the paragraph
- `**bold**` runs (these already nest fine inside italics)
- code spans (any number of backticks) and fenced code blocks (```` ``` ```` or `~~~`)
- escaped `\*`, asterisks inside HTML attributes, and ambiguous mid-word asterisks
- list bullets

### Why the prompt matters

With only *Alter Chat Display*, the model still sees the original nested asterisks in its history,
which may encourage it to keep producing them. *Alter Outgoing Prompt* removes them from what the
model sees (chat messages only; character cards and system prompts are never fixed). As a safety
net, the extension's own `<span class="nef-emph">` markup is always stripped from the whole final
prompt, whatever the settings; nothing else in the prompt is changed by that step.

The *Rewrite saved messages* button asks for confirmation first, respects *Also fix my own
messages*, and skips system messages.

## Notes

- SillyTavern's sanitizer prefixes class names in message HTML with `custom-`; the stylesheet
  targets both spellings.
- If your setup escapes HTML tags in messages ("encode tags"), styled mode will show the span as
  text; use *Strip* instead.

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE).
