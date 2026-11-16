# markdown-fast

A fast, dependency-free CommonMark + GFM (marked 18.1.3-compatible) Markdown
renderer written from scratch in JavaScript.

- `parse.js` — the parser. `parse(markdown)` returns HTML byte-identical to
  `marked.parse(markdown)` with default options (gfm, no breaks, not
  pedantic, synchronous). Single-pass block and inline parsing, minimal
  allocation on hot paths.
- `main.ts` — the entry driver. Reads `/input/cases.json`, renders every
  case with `parse`, and writes `/output/html.json`.

## Usage

```js
import { parse } from './parse.js';
parse('# Hello\n\n**bold** and *italic*');
```

## License

MIT
