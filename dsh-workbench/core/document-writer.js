/** Pure document writers shared by the plugin and standalone service. No filesystem or Host. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let value = i;
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    table[i] = value >>> 0;
  }
  return table;
})();

/** @returns CRC-32 of a buffer. */
function crc32(buffer) {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** @returns the current time encoded as MS-DOS date and time words. */
function dosDateTime(now = new Date()) {
  const time = (now.getHours() << 11) | (now.getMinutes() << 5) | Math.floor(now.getSeconds() / 2);
  const date = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  return { time, date };
}

/**
 * Build a ZIP archive using the stored (uncompressed) method. DOCX readers
 * accept stored entries, and avoiding DEFLATE keeps this writer auditable.
 * @param entries - array of { name, data }.
 * @returns ZIP bytes.
 */
export function zipStored(entries, options = {}) {
  const { time, date } = dosDateTime(options.date);
  const locals = [];
  const centrals = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // UTF-8 file name.
    local.writeUInt16LE(0, 8); // Stored.
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, data);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(0, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(data.length, 20);
    central.writeUInt32LE(data.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(0, 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += local.length + name.length + data.length;
  }

  const centralSize = centrals.reduce((size, part) => size + part.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralSize, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...locals, ...centrals, eocd]);
}

/** @returns XML-escaped text. */
function xmlEscape(text) {
  return text
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * Parse the small Markdown subset the Workbench documents use into blocks.
 * @param markdown - source.
 * @returns block list with kind and text.
 */
export function markdownBlocks(markdown) {
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  let inCode = false;
  let code = [];

  const flushCode = () => {
    if (code.length > 0) blocks.push({ kind: 'code', text: code.join('\n') });
    code = [];
  };

  for (const line of lines) {
    if (/^```/.test(line.trim())) {
      if (inCode) {
        flushCode();
        inCode = false;
      } else {
        inCode = true;
        code = [];
      }
      continue;
    }
    if (inCode) {
      code.push(line);
      continue;
    }
    if (line.trim() === '') {
      blocks.push({ kind: 'blank', text: '' });
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading !== null) {
      blocks.push({ kind: `h${heading[1].length}`, text: heading[2].trim() });
      continue;
    }
    if (/^\s*([-*_])\1{2,}\s*$/.test(line)) {
      blocks.push({ kind: 'hr', text: '' });
      continue;
    }
    const quote = /^>\s?(.*)$/.exec(line);
    if (quote !== null) {
      blocks.push({ kind: 'quote', text: quote[1].trim() });
      continue;
    }
    const task = /^\s*-\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task !== null) {
      blocks.push({ kind: 'bullet', text: `${task[1].toLowerCase() === 'x' ? '☑' : '☐'} ${task[2].trim()}` });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet !== null) {
      blocks.push({ kind: 'bullet', text: bullet[1].trim() });
      continue;
    }
    const numbered = /^\s*(\d+[.)])\s+(.*)$/.exec(line);
    if (numbered !== null) {
      blocks.push({ kind: 'number', text: `${numbered[1]} ${numbered[2].trim()}` });
      continue;
    }
    blocks.push({ kind: 'p', text: line.trim() });
  }
  flushCode();
  return blocks;
}

/** @returns a Word run with optional formatting. */
function wordRun(text, opts = {}) {
  const props = [];
  if (opts.bold) props.push('<w:b/>');
  if (opts.code) props.push('<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/>', '<w:color w:val="333333"/>');
  if (opts.size) props.push(`<w:sz w:val="${opts.size}"/>`);
  const rPr = props.length > 0 ? `<w:rPr>${props.join('')}</w:rPr>` : '';
  const preserve = /^\s|\s$/.test(text) ? ' xml:space="preserve"' : '';
  return `<w:r>${rPr}<w:t${preserve}>${xmlEscape(text)}</w:t></w:r>`;
}

/** @returns a Word paragraph. */
function wordParagraph(text, opts = {}) {
  const pPr = [];
  if (opts.align) pPr.push(`<w:jc w:val="${opts.align}"/>`);
  if (opts.indent) pPr.push(`<w:ind w:left="${opts.indent}"/>`);
  if (opts.spacing) pPr.push(`<w:spacing w:before="${opts.spacing[0]}" w:after="${opts.spacing[1]}"/>`);
  if (opts.shade) pPr.push('<w:shd w:val="clear" w:color="auto" w:fill="F4F5F7"/>');
  const props = pPr.length > 0 ? `<w:pPr>${pPr.join('')}</w:pPr>` : '';
  return `<w:p>${props}${wordRun(text, opts)}</w:p>`;
}

/**
 * Convert Markdown to a complete, simple DOCX document.
 * @param markdown - source Markdown.
 * @param title - document title used in metadata.
 * @returns DOCX bytes.
 */
export function buildDocx(markdown, title, options = {}) {
  const blocks = markdownBlocks(markdown);
  const body = [];
  for (const block of blocks) {
    if (block.kind === 'blank') {
      continue;
    }
    if (block.kind === 'hr') {
      body.push(
        '<w:p><w:pPr><w:pBdr><w:bottom w:val="single" w:sz="4" w:space="1" w:color="D9DCE3"/></w:pBdr></w:pPr></w:p>',
      );
      continue;
    }
    if (block.kind === 'code') {
      for (const line of block.text.split('\n')) {
        body.push(wordParagraph(line === '' ? ' ' : line, { code: true, size: 19, shade: true, spacing: [0, 0] }));
      }
      continue;
    }
    if (block.kind === 'h1') {
      body.push(wordParagraph(block.text, { bold: true, size: 40, spacing: [360, 160] }));
      continue;
    }
    if (block.kind === 'h2') {
      body.push(wordParagraph(block.text, { bold: true, size: 32, spacing: [280, 120] }));
      continue;
    }
    if (block.kind === 'h3') {
      body.push(wordParagraph(block.text, { bold: true, size: 26, spacing: [220, 100] }));
      continue;
    }
    if (block.kind === 'h4' || block.kind === 'h5' || block.kind === 'h6') {
      body.push(wordParagraph(block.text, { bold: true, size: 24, spacing: [180, 80] }));
      continue;
    }
    if (block.kind === 'bullet') {
      body.push(wordParagraph(`• ${block.text}`, { indent: 420, spacing: [0, 60] }));
      continue;
    }
    if (block.kind === 'number') {
      body.push(wordParagraph(block.text, { indent: 420, spacing: [0, 60] }));
      continue;
    }
    if (block.kind === 'quote') {
      body.push(wordParagraph(block.text, { indent: 420, spacing: [60, 60] }));
      continue;
    }
    body.push(wordParagraph(block.text, { spacing: [0, 100] }));
  }

  const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:body>${body.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1300" w:bottom="1200" w:left="1300" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr></w:body>
</w:document>`;

  const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
<Default Extension="xml" ContentType="application/xml"/>
<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
<Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
</Types>`;

  const rels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;

  const now = (options.date || new Date()).toISOString();
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
<dc:title>${xmlEscape(title)}</dc:title><dc:creator>DSH Workbench</dc:creator><cp:lastModifiedBy>DSH Workbench</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${now}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${now}</dcterms:modified>
</cp:coreProperties>`;

  const app = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"><Application>DSH Workbench</Application></Properties>`;

  return zipStored([
    { name: '[Content_Types].xml', data: contentTypes },
    { name: '_rels/.rels', data: rels },
    { name: 'docProps/core.xml', data: core },
    { name: 'docProps/app.xml', data: app },
    { name: 'word/document.xml', data: document },
  ], options);
}
