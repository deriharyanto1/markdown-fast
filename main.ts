// Driver for the markdown-render-speed entry.
// Reads /input/cases.json, renders each case with parse() from parse.js,
// and writes /output/html.json. Written from scratch for this entry.
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { parse } from './parse.js';

const input = JSON.parse(readFileSync('/input/cases.json', 'utf8'));
const out = new Array(input.length);
for (let i = 0; i < input.length; i++) {
  out[i] = parse(input[i].markdown);
}
mkdirSync('/output', { recursive: true });
writeFileSync('/output/html.json', JSON.stringify(out));
