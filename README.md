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
| Prefer render-time hook | Use SillyTavern's message-formatting hook when your version has it (see below). |
| Fix method | *Strip* inner asterisks, or *Replace with styled emphasis*. |
| Styled emphasis look | Glow / Reverse italics / Bold / Dotted underline (changes apply instantly to existing messages). |
| Try it | Paste text to preview the result of both methods. |
| Rewrite saved messages | Applies the current method to the whole open chat and saves it. |

## How it works

For each paragraph, every lone `*` is classified as an opener or closer using Markdown's
flanking rules (HTML tags are treated as invisible, line-break tags as whitespace). A stack pairs them
up; any pair opened while another italic is already open is "inner" and gets fixed.

It deliberately does nothing when it can't be sure:

- italics that are never closed in the paragraph
- `**bold**` runs (these already nest fine inside italics)
- code spans and fenced code blocks
- escaped `\*`, asterisks inside HTML attributes, and ambiguous mid-word asterisks
- list bullets

### Two delivery methods (automatic)

1. **Render-time hook**: if your SillyTavern version provides `messageFormatter.addHook`
   (documented as a staging-branch feature), text is fixed on its way to the screen and your saved
   chat is never modified. This also fixes streaming previews.
2. **Fallback**: otherwise the saved message is rewritten when it arrives (or when you send it),
   before it is rendered. While a reply is still streaming it may briefly render with the original
   asterisks.

The settings panel shows which method is active. In styled mode, the span HTML is stripped back out
of the prompt so the model never sees it.

## Notes

- SillyTavern's sanitizer prefixes class names in message HTML with `custom-`; the stylesheet
  targets both spellings.
- If your setup escapes HTML tags in messages ("encode tags"), styled mode will show the span as
  text; use *Strip* instead.

## License

GNU Affero General Public License v3.0 (AGPL-3.0). See [LICENSE](LICENSE).
