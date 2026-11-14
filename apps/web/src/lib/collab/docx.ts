// Minimal .docx (Office Open XML) writer: a title, an inline picture of the board, then every text
// box as real, editable paragraphs (bold/italic/underline runs, bullets and numbered lists).
// Pure logic, no dependencies; the ZIP container comes from zip.ts. Opens in Word, Google Docs,
// LibreOffice and Pages.

import { parseRichText } from './richtext.js';
import { buildZip } from './zip.js';

export interface DocxTextBox {
  /** Markdown-like text (see richtext.ts). */
  text: string;
  /** #rrggbb */
  color: string;
  /** Font size on the board (world units). */
  size: number;
}

export interface DocxInput {
  title: string;
  image?: { png: Uint8Array; width: number; height: number };
  boxes: DocxTextBox[];
  /** Board text color that should map to the document's default (automatic) color. */
  defaultColor?: string;
  /** Heading above the text paragraphs; null for none. Defaults to "Text on the board". */
  textHeading?: string | null;
}

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';
const NS_R = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_WP = 'http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';
const NS_PIC = 'http://schemas.openxmlformats.org/drawingml/2006/picture';
const REL = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const XML_DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

// Characters XML 1.0 can't contain at all (they're dropped, not escaped).
const INVALID_XML = /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu;

export function xmlEscape(s: string): string {
  return s
    .replace(INVALID_XML, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// A4 page with 2cm margins, in twentieths of a point (twips); 1 twip = 635 EMU.
const PAGE_W = 11906;
const PAGE_H = 16838;
const MARGIN = 1134;
const EMU_PER_TWIP = 635;
const MAX_IMG_W = (PAGE_W - 2 * MARGIN) * EMU_PER_TWIP;
const MAX_IMG_H = (PAGE_H - 2 * MARGIN - 1800) * EMU_PER_TWIP;

/** Board font size (world units, 14..48 typical) to half-points for Word. */
function halfPoints(size: number): number {
  const pt = Math.min(Math.max(8 + size * 0.25, 10), 28);
  return Math.round(pt * 2);
}

function hex(color: string): string | null {
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.slice(1).toUpperCase() : null;
}

interface Numbering {
  /** One `w:num` per numbered list so each list restarts at its own first number. */
  lists: { numId: number; start: number }[];
}

const BULLET_NUM_ID = 1;
/** Separate numbered lists in one document (each needs its own numbering entry). */
const MAX_NUMBERED_LISTS = 500;

function runXml(text: string, b: boolean, i: boolean, u: boolean, color: string | null, sz: number): string {
  // Child order follows the schema (CT_RPr): b, i, color, sz, szCs, u.
  const rPr =
    (b ? '<w:b/><w:bCs/>' : '') +
    (i ? '<w:i/><w:iCs/>' : '') +
    (color ? `<w:color w:val="${color}"/>` : '') +
    `<w:sz w:val="${sz}"/><w:szCs w:val="${sz}"/>` +
    (u ? '<w:u w:val="single"/>' : '');
  return `<w:r><w:rPr>${rPr}</w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function boxXml(box: DocxTextBox, numbering: Numbering, defaultColor: string | undefined): string {
  const color = box.color.toLowerCase() === defaultColor?.toLowerCase() ? null : hex(box.color);
  const sz = halfPoints(box.size);
  let out = '';
  let currentList: number | null = null;
  for (const line of parseRichText(box.text)) {
    let pPr = '';
    if (line.kind === 'bullet') {
      pPr = `<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${BULLET_NUM_ID}"/></w:numPr></w:pPr>`;
      currentList = null;
    } else if (line.kind === 'number') {
      if (currentList === null) {
        if (numbering.lists.length < MAX_NUMBERED_LISTS) {
          currentList = numbering.lists.length + 2;
          numbering.lists.push({ numId: currentList, start: Math.min(Math.max(line.num ?? 1, 1), 32767) });
        } else {
          // Past the cap, further lists continue the last one (keeps the file small and valid).
          currentList = numbering.lists.length + 1;
        }
      }
      pPr = `<w:pPr><w:pStyle w:val="ListParagraph"/><w:numPr><w:ilvl w:val="0"/><w:numId w:val="${currentList}"/></w:numPr></w:pPr>`;
    } else {
      currentList = null;
    }
    const runs = line.runs.map((r) => runXml(r.text, r.b, r.i, r.u, color, sz)).join('');
    out += `<w:p>${pPr}${runs}</w:p>`;
  }
  return out;
}

function imageXml(img: { width: number; height: number }): string {
  const ratio = img.height / Math.max(img.width, 1);
  let cx = MAX_IMG_W;
  let cy = Math.round(cx * ratio);
  if (cy > MAX_IMG_H) {
    cy = MAX_IMG_H;
    cx = Math.round(cy / ratio);
  }
  cx = Math.max(cx, 1);
  cy = Math.max(cy, 1);
  return (
    '<w:p><w:r><w:drawing>' +
    `<wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/>` +
    '<wp:docPr id="1" name="Whiteboard" descr="Picture of the whole whiteboard"/>' +
    '<wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr>' +
    `<a:graphic><a:graphicData uri="${NS_PIC}"><pic:pic>` +
    '<pic:nvPicPr><pic:cNvPr id="1" name="board.png"/><pic:cNvPicPr/></pic:nvPicPr>' +
    '<pic:blipFill><a:blip r:embed="rIdImg"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill>' +
    `<pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr>` +
    '</pic:pic></a:graphicData></a:graphic></wp:inline>' +
    '</w:drawing></w:r></w:p>'
  );
}

/** word/document.xml and word/numbering.xml for the input. */
export function buildDocumentParts(input: DocxInput): { documentXml: string; numberingXml: string } {
  const numbering: Numbering = { lists: [] };
  let body = `<w:p><w:pPr><w:pStyle w:val="Title"/></w:pPr><w:r><w:t xml:space="preserve">${xmlEscape(input.title)}</w:t></w:r></w:p>`;
  if (input.image) body += imageXml(input.image);
  if (input.boxes.length) {
    const heading = input.textHeading === undefined ? 'Text on the board' : input.textHeading;
    if (heading) body += `<w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>${xmlEscape(heading)}</w:t></w:r></w:p>`;
    input.boxes.forEach((box, i) => {
      if (i > 0) body += '<w:p/>';
      body += boxXml(box, numbering, input.defaultColor);
    });
  }
  body += `<w:sectPr><w:pgSz w:w="${PAGE_W}" w:h="${PAGE_H}"/><w:pgMar w:top="${MARGIN}" w:right="${MARGIN}" w:bottom="${MARGIN}" w:left="${MARGIN}" w:header="709" w:footer="709" w:gutter="0"/></w:sectPr>`;

  const documentXml =
    XML_DECL +
    `<w:document xmlns:w="${NS_W}" xmlns:r="${NS_R}" xmlns:wp="${NS_WP}" xmlns:a="${NS_A}" xmlns:pic="${NS_PIC}">` +
    `<w:body>${body}</w:body></w:document>`;

  const lvl = (fmt: string, text: string) =>
    `<w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="${fmt}"/><w:lvlText w:val="${text}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>`;
  const numberingXml =
    XML_DECL +
    `<w:numbering xmlns:w="${NS_W}">` +
    `<w:abstractNum w:abstractNumId="0"><w:multiLevelType w:val="singleLevel"/>${lvl('bullet', '•')}</w:abstractNum>` +
    `<w:abstractNum w:abstractNumId="1"><w:multiLevelType w:val="singleLevel"/>${lvl('decimal', '%1.')}</w:abstractNum>` +
    `<w:num w:numId="${BULLET_NUM_ID}"><w:abstractNumId w:val="0"/></w:num>` +
    numbering.lists
      .map(
        (l) =>
          `<w:num w:numId="${l.numId}"><w:abstractNumId w:val="1"/><w:lvlOverride w:ilvl="0"><w:startOverride w:val="${l.start}"/></w:lvlOverride></w:num>`
      )
      .join('') +
    '</w:numbering>';

  return { documentXml, numberingXml };
}

const STYLES_XML =
  XML_DECL +
  `<w:styles xmlns:w="${NS_W}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Calibri" w:cs="Calibri"/>' +
  '<w:sz w:val="22"/><w:szCs w:val="22"/></w:rPr></w:rPrDefault>' +
  '<w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="264" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/><w:szCs w:val="40"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:keepNext/><w:spacing w:before="360" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:szCs w:val="28"/></w:rPr></w:style>' +
  '<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:qFormat/>' +
  '<w:pPr><w:spacing w:after="60"/><w:ind w:left="720"/></w:pPr></w:style>' +
  '</w:styles>';

/** The complete .docx file. */
export function buildDocx(input: DocxInput, when = new Date()): Uint8Array<ArrayBuffer> {
  const { documentXml, numberingXml } = buildDocumentParts(input);
  const contentTypes =
    XML_DECL +
    '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    '<Default Extension="png" ContentType="image/png"/>' +
    '<Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>' +
    '<Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>' +
    '<Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>' +
    '</Types>';
  const rootRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rId1" Type="${REL}/officeDocument" Target="word/document.xml"/>` +
    '</Relationships>';
  const docRels =
    XML_DECL +
    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
    `<Relationship Id="rIdStyles" Type="${REL}/styles" Target="styles.xml"/>` +
    `<Relationship Id="rIdNum" Type="${REL}/numbering" Target="numbering.xml"/>` +
    (input.image ? `<Relationship Id="rIdImg" Type="${REL}/image" Target="media/board.png"/>` : '') +
    '</Relationships>';

  return buildZip(
    [
      { name: '[Content_Types].xml', data: contentTypes },
      { name: '_rels/.rels', data: rootRels },
      { name: 'word/document.xml', data: documentXml },
      { name: 'word/styles.xml', data: STYLES_XML },
      { name: 'word/numbering.xml', data: numberingXml },
      { name: 'word/_rels/document.xml.rels', data: docRels },
      ...(input.image ? [{ name: 'word/media/board.png', data: input.image.png }] : []),
    ],
    when
  );
}
