// Draws the README diagrams as light and dark SVGs: node docs/diagrams.mjs docs
import fs from 'node:fs'
import path from 'node:path'

const [outDir] = process.argv.slice(2)
fs.mkdirSync(outDir, { recursive: true })

const LIGHT = '--fg:#F3E8CD;--muted:#C0B69F;--box:#11100E;--line:#665C47;--acc:#F3E8CD;--accbg:#1C1913;--ok:#E4D4AD;--okbg:#1C1913;--bad:#CAB78E;--badbg:#211B12;--page:#090909'
const DARK = '--fg:#F3E8CD;--muted:#C0B69F;--box:#11100E;--line:#665C47;--acc:#F3E8CD;--accbg:#1C1913;--ok:#E4D4AD;--okbg:#1C1913;--bad:#CAB78E;--badbg:#211B12;--page:#090909'
const base = `
text{font-family:Georgia,'Times New Roman',serif}
.box{fill:var(--box);stroke:var(--line);stroke-width:1}
.box.acc{fill:var(--accbg);stroke:var(--acc)}
.box.ok{fill:var(--okbg);stroke:var(--ok)}
.box.bad{fill:var(--badbg);stroke:var(--bad)}
.box.dash{fill:none;stroke-dasharray:4 3}
.ttl{font-size:13px;font-weight:600;fill:var(--fg)}
.ttl.ok{fill:var(--ok)}.ttl.bad{fill:var(--bad)}.ttl.acc{fill:var(--acc)}
.sub{font-size:11.5px;fill:var(--muted)}
.mono{font-family:ui-monospace,SFMono-Regular,"Cascadia Mono",Consolas,Menlo,monospace}
.lane{font-size:11px;font-weight:600;letter-spacing:.09em;fill:var(--muted)}
.lbl{font-size:11px;fill:var(--muted)}
.lbl.acc{fill:var(--acc)}.lbl.bad{fill:var(--bad)}.lbl.ok{fill:var(--ok)}
.arr{stroke:var(--muted);stroke-width:1.4;fill:none;marker-end:url(#a)}
.arr.acc{stroke:var(--acc);marker-end:url(#aa)}
.arr.bad{stroke:var(--bad);marker-end:url(#ab)}
.arr.dash{stroke-dasharray:4 3}
.ah{fill:var(--muted)}.ah.acc{fill:var(--acc)}.ah.bad{fill:var(--bad)}
.axis{stroke:var(--line);stroke-width:2}
.dot{fill:var(--page);stroke:var(--muted);stroke-width:2}
.dot.ok{fill:var(--ok);stroke:var(--ok)}
.dot.acc{fill:var(--acc);stroke:var(--acc)}
.dot.dash{stroke-dasharray:3 2}
.halo{fill:none;stroke:var(--acc);stroke-width:1.5;opacity:.45}
.check{stroke:var(--page);stroke-width:2;fill:none;stroke-linecap:round;stroke-linejoin:round}
`

const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
const marker = (id, cls) => `<marker id="${id}" viewBox="0 0 10 10" refX="8.5" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 1L9 5L0 9z" class="ah ${cls}"/></marker>`

function inlineStyles(svg) {
 const css=svg.match(/<style>([\s\S]*?)<\/style>/)?.[1]??"";
 const vars=Object.fromEntries([...css.matchAll(/(--[\w-]+):([^;}]+)/g)].map(m=>[m[1],m[2]]));
 const rules=[...css.matchAll(/([^{}]+)\{([^{}]+)\}/g)].filter(m=>m[1].trim()!=="svg");
 return svg.replace(/<style>[\s\S]*?<\/style>\n?/,"").replace(/<(text|rect|path|circle)(\s[^>]*?)(\/?)>/g,(full,tag,attrs,end)=>{
  const classes=(attrs.match(/\bclass="([^"]*)"/)?.[1]??"").split(/\s+/), values={};
  for(const rule of rules){
   const [element,...required]=rule[1].trim().split(".");
   if((element===""||element===tag)&&required.every(c=>classes.includes(c))){
    for(const part of rule[2].split(";")){
     const i=part.indexOf(":");
     if(i>0)values[part.slice(0,i).trim()]=part.slice(i+1).trim().replace(/var\((--[\w-]+)\)/g,(_,k)=>vars[k]);
    }
   }
  }
  for(const [key,value] of Object.entries(values)){
   attrs=attrs.replace(new RegExp(`\\s${key}="[^"]*"`,"g"),"")+` ${key}="${value.replaceAll('"',"&quot;")}"`;
  }
  return `<${tag}${attrs}${end}>`;
 });
}

// GitHub picks between the two with <picture>, following the theme the reader chose.
function svg(name, w, h, title, body) {
  for (const [theme, vars] of [['light', LIGHT], ['dark', DARK]]) {
    const css = `svg{${vars}}${base}`
    const doc = `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${esc(title)}">
<title>${esc(title)}</title>
<style>${css}</style>
<defs>${marker('a', '')}${marker('aa', 'acc')}${marker('ab', 'bad')}</defs>
<rect width="100%" height="100%" fill="#090909"/>
${body.join('\n')}
</svg>
`
    fs.writeFileSync(path.join(outDir, `${name}-${theme}.svg`), inlineStyles(doc))
  }
}

const text = (x, y, s, cls, anchor = 'middle') => `<text x="${x}" y="${y}" text-anchor="${anchor}" class="${cls}">${esc(s)}</text>`

function box(x, y, w, h, title, sub, kind = '', { mono = false, monoTitle = false } = {}) {
  const cx = x + w / 2
  const cy = y + h / 2
  const out = [`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="2" class="box ${kind}"/>`]
  out.push(text(cx, sub ? cy - 3 : cy + 4.5, title, `ttl ${kind}${monoTitle ? ' mono' : ''}`))
  if (sub) out.push(text(cx, cy + 14, sub, `sub${mono ? ' mono' : ''}`))
  return out.join('')
}

const arrow = (d, cls = '') => `<path d="${d}" class="arr ${cls}"/>`

// A row of equal boxes joined by arrows; returns each box's left x.
function row(xs, y, w, h, items) {
  const out = []
  items.forEach(([title, sub, kind, opts], i) => {
    out.push(box(xs[i], y, w, h, title, sub, kind, opts))
    if (i < items.length - 1) out.push(arrow(`M${xs[i] + w + 2} ${y + h / 2}H${xs[i + 1] - 3}`))
  })
  return out
}

// ---- 1. Timeline overview -------------------------------------------------
{
  const y = 150
  const marks = [
    { x: 100, kind: 'manual', id: 'a3f9c1', desc: 'whole workspace' },
    { x: 240, kind: 'auto', id: 'b0b0b0', desc: '3 files, before edits' },
    { x: 380, kind: 'test', id: '7e57ed', desc: 'tests passed', dot: 'ok' },
    { x: 520, kind: 'shell', id: 'c4d1e9', desc: 'before git reset' },
    { x: 660, kind: 'undo', id: 'u0a1b2', desc: 'saved by a rollback', dot: 'dash' },
  ]
  const b = [`<line x1="30" y1="${y}" x2="870" y2="${y}" class="axis"/>`]
  b.push(text(30, y + 24, 'earlier', 'lbl', 'start'))
  for (const m of marks) {
    b.push(text(m.x, 92, m.kind, `ttl${m.dot === 'ok' ? ' ok' : ''}`))
    b.push(text(m.x, 110, m.desc, `sub${m.dot === 'ok' ? ' lbl ok' : ''}`))
    b.push(text(m.x, 127, m.id, 'sub mono'))
    b.push(`<circle cx="${m.x}" cy="${y}" r="8" class="dot ${m.dot ?? ''}"/>`)
    if (m.dot === 'ok') b.push(`<path d="M${m.x - 3.6} ${y + 0.2}l2.6 2.6 4.8-5.2" class="check"/>`)
  }
  b.push(text(820, 92, 'now', 'ttl acc'))
  b.push(text(820, 110, 'your files', 'sub'))
  b.push(`<circle cx="820" cy="${y}" r="13" class="halo"/><circle cx="820" cy="${y}" r="7" class="dot acc"/>`)
  b.push(arrow(`M812 ${y + 12}Q600 270 389 ${y + 11}`, 'acc'))
  b.push(text(600, 238, 'roll back to the last verified checkpoint: preview first, undo point saved', 'lbl acc'))
  svg('timeline', 900, 256, 'A project timeline of checkpoints: manual, auto, a verified test checkpoint, a shell snapshot and an undo point, with a rollback from now to the verified checkpoint', b)
}

// ---- 2. Capture ----------------------------------------------------------
{
  const xs = [40, 250, 460, 670]
  const w = 170
  const b = [text(40, 28, 'FILE EDITS', 'lane', 'start')]
  b.push(...row(xs, 42, w, 60, [
    ['Agent edits a file', 'Edit, Write, MultiEdit'],
    ['Save its content first', 'once per file per turn', 'acc'],
    ['Permission, then edit', 'the edit runs as usual'],
    ['Protected', 'a rollback restores it', 'ok'],
  ]))
  b.push(arrow('M545 103V129'))
  b.push(text(553, 120, 'refused', 'lbl', 'start'))
  b.push(box(460, 132, w, 34, 'Save dropped', '', ''))

  b.push(text(40, 206, 'SHELL COMMANDS', 'lane', 'start'))
  b.push(...row(xs, 220, w, 60, [
    ['Agent runs a command', 'Bash or PowerShell'],
    ['Looks destructive?', 'rm, mv, git reset, sed -i'],
    ['Snapshot first', 'bounded: 5,000 files', 'acc'],
    ['Command runs', 'shown above the prompt'],
  ]))
  b.push(text(438, 241, 'yes', 'lbl'))
  b.push(arrow('M335 281C335 322 755 322 755 284'))
  b.push(text(545, 325, 'no', 'lbl'))
  svg('capture', 880, 340, 'How edits and shell commands are protected', b)
}

// ---- 3. Rollback ---------------------------------------------------------
{
  const xs = [30, 208, 386, 564, 742]
  const w = 148
  const b = [...row(xs, 36, w, 64, [
    ['Preview', 'nothing written yet'],
    ['Confirm', '--confirm <token>', '', { mono: true }],
    ['Re-check files', 'same as the preview?'],
    ['Save undo point', 'of the files it changes', 'acc'],
    ['Write files', 'temp file, then rename', 'ok'],
  ])]
  b.push(text(549, 27, 'unchanged', 'lbl'))
  b.push(arrow('M460 101V139', 'bad'))
  b.push(text(468, 124, 'changed', 'lbl bad', 'start'))
  b.push(box(386, 142, w, 46, 'Stop', 'and show a fresh preview', 'bad'))
  b.push(arrow('M385 165H104V103'))
  b.push(text(244, 181, 'preview again', 'lbl'))
  b.push(arrow('M638 101V139', 'dash'))
  b.push(box(564, 142, w, 46, 'Undo any time', '/zeit-undo', 'dash', { mono: true }))
  svg('rollback', 920, 206, 'Rollback: preview, confirm with the token, re-check, save an undo point, then write', b)
}

// ---- 4. Verify -----------------------------------------------------------
{
  const xs = [40, 250, 460, 670]
  const w = 170
  const b = [...row(xs, 36, w, 64, [
    ['Snapshot', 'the whole workspace'],
    ['Run your tests', 'a command from .zeit.json'],
    ['Check the result', 'passed, files unchanged'],
    ['Marked verified', 'kept through retention', 'ok'],
  ])]
  b.push(text(650, 27, 'both true', 'lbl'))
  b.push(arrow('M545 101V139', 'acc'))
  b.push(text(553, 124, 'otherwise', 'lbl acc', 'start'))
  b.push(box(460, 142, w, 46, 'Rollback offered', 'to the last verified one', 'acc'))
  svg('verify', 880, 206, 'Verified checkpoints: snapshot, run tests, check, mark verified or offer a rollback', b)
}

// ---- 5. Storage ----------------------------------------------------------
{
  const rowsY = [56, 100, 144, 188]
  const h = 34
  const files = ['src/app.ts', 'src/util.ts', 'README.md']
  const hashes = ['3f2a9c', '9c1d07', 'e07b44']
  const b = [
    text(30, 40, 'YOUR PROJECT', 'lane', 'start'),
    text(330, 40, 'OBJECTS  ·  gzip, by content', 'lane', 'start'),
    text(630, 40, 'CHECKPOINTS', 'lane', 'start'),
  ]
  files.forEach((f, i) => {
    const y = rowsY[i]
    b.push(`<rect x="30" y="${y}" width="220" height="${h}" rx="6" class="box"/>`, text(46, y + 22, f, 'sub mono', 'start'))
    b.push(`<rect x="330" y="${y}" width="220" height="${h}" rx="6" class="box"/>`, text(346, y + 22, hashes[i], 'ttl mono', 'start'), text(534, y + 22, f, 'sub', 'end'))
    b.push(arrow(`M252 ${y + h / 2}H326`))
  })
  const ey = rowsY[3]
  b.push(`<rect x="30" y="${ey}" width="220" height="${h}" rx="6" class="box bad"/>`, text(46, ey + 22, '.env', 'sub mono', 'start'))
  b.push(`<rect x="330" y="${ey}" width="220" height="${h}" rx="6" class="box bad dash"/>`, text(440, ey + 22, 'never saved: looks like a secret', 'lbl bad'))

  const cards = [
    { y: 56, id: 'a3f9c1', sub: 'manual · 3 files', to: [0, 1, 2] },
    { y: 144, id: 'b0b0b0', sub: 'auto · 2 files', to: [1, 2] },
  ]
  for (const c of cards) {
    b.push(box(630, c.y, 220, 78, c.id, c.sub, '', { monoTitle: true }))
    for (const i of c.to) b.push(arrow(`M628 ${c.y + 39}L554 ${rowsY[i] + h / 2}`))
  }
  b.push(text(440, 254, 'An unchanged file is stored once, however many checkpoints point to it.', 'lbl'))
  b.push(text(440, 274, 'Windows: %LOCALAPPDATA%\\zeit-checkpoints   ·   macOS, Linux: ~/.local/share/zeit-checkpoints   ·   or $ZEIT_HOME', 'lbl mono'))
  svg('storage', 880, 290, 'Storage: project files are stored by content in objects; checkpoints point to them; secrets are never saved', b)
}
