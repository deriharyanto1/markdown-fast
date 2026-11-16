# markdown-fast

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/deriharyanto1/markdown-fast/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/deriharyanto1/markdown-fast/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A fast, dependency-free CommonMark + GFM (marked 18.1.3-compatible) Markdown
renderer written from scratch in JavaScript. Built for the [markdown-render-speed-02 bounty](https://make.fun/bounty/markdown-render-speed-02) on make.fun.

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
