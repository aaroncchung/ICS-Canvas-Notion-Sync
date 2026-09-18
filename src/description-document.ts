/**
 * Parses the Markdown that turndown produces from sanitized Canvas HTML into a small document
 * model: a flat list of blocks that carry styled inline runs. Both the Notion managed section and
 * the searchable plain-text excerpt derive from this model, so they always agree.
 *
 * The dialect is deliberately narrow: ATX headings, `-` bullets, `1.` numbers, `>` quotes,
 * fenced code, tagged table rows, `**strong**`, `_emphasis_`, `` `code` ``, `[text](url)` links,
 * and backslash escapes. The model is flat because the managed section is verified block by
 * block; nested lists flatten to siblings and table rows become one paragraph each.
 */

export interface InlineRun {
  text: string;
  bold: boolean;
  italic: boolean;
  code: boolean;
  link?: string;
}

export type DescriptionNode =
  | { kind: "paragraph" | "bulleted" | "numbered" | "quote"; runs: InlineRun[] }
  | { kind: "heading"; level: 1 | 2 | 3; runs: InlineRun[] }
  | { kind: "code"; text: string };

interface InlineStyle {
  bold: boolean;
  italic: boolean;
  code: boolean;
  link?: string;
}

const PLAIN: InlineStyle = { bold: false, italic: false, code: false };
const ASCII_PUNCTUATION = /[!"#$%&'()*+,\-./:;<=>?@[\\\]^_`{|}~]/;
const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*)|[ \t]*)$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})/;
const QUOTE = /^ {0,3}> ?(.*)$/;
const BULLET = /^( {0,3})([-*+])(?:([ \t]+)(.*)|$)/;
const ORDERED = /^( {0,3})(\d{1,9})[.)](?:([ \t]+)(.*)|$)/;
/**
 * Control-delimited tags distinguish generated table syntax from literal pipe-wrapped text. Canvas
 * input has its control characters stripped before conversion, so only the table rules emit them
 * and cell content needs no escaping: a pipe in a cell, even inside inline code, stays a pipe.
 */
export const TABLE_ROW_MARKER = "\u001eC2N_TABLE_ROW\u001f";
export const TABLE_SEPARATOR_MARKER = "\u001eC2N_TABLE_SEPARATOR\u001f";
export const TABLE_CELL_SEPARATOR = "\u001f";
/** Stands in for a line break inside a cell, because a row must stay on one line. */
export const TABLE_CELL_LINE_BREAK = "\u001d";
/** Backstop: generated syntax that ends up anywhere but a row's own line must never be shown. */
const STRAY_TABLE_SYNTAX = new RegExp(
  `${TABLE_ROW_MARKER}|${TABLE_SEPARATOR_MARKER}|[^\\P{Cc}\\t\\n]`,
  "gu",
);
/** Turndown renders `<br>` as two trailing spaces; that is the only hard break it emits. */
const HARD_BREAK = / {2,}$/;

function isTableRow(line: string): boolean {
  return line.startsWith(TABLE_ROW_MARKER);
}

function isTableSeparator(line: string): boolean {
  return line === TABLE_SEPARATOR_MARKER;
}

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function indentation(line: string): number {
  return line.length - line.trimStart().length;
}

function startsBlock(line: string): boolean {
  return (
    HEADING.test(line) ||
    FENCE.test(line) ||
    QUOTE.test(line) ||
    BULLET.test(line) ||
    ORDERED.test(line) ||
    isTableRow(line) ||
    isTableSeparator(line)
  );
}

function run(text: string, style: InlineStyle): InlineRun {
  return {
    text,
    bold: style.bold,
    italic: style.italic,
    code: style.code,
    ...(style.link !== undefined ? { link: style.link } : {}),
  };
}

function sameStyle(left: InlineRun, right: InlineRun): boolean {
  return (
    left.bold === right.bold &&
    left.italic === right.italic &&
    left.code === right.code &&
    left.link === right.link
  );
}

/** Drops empty runs and merges neighbours that share a style, producing one normal form. */
export function normalizeRuns(runs: InlineRun[]): InlineRun[] {
  const result: InlineRun[] = [];
  for (const item of runs) {
    if (!item.text) continue;
    const previous = result[result.length - 1];
    if (previous && sameStyle(previous, item)) previous.text += item.text;
    else result.push({ ...item });
  }
  return result;
}

/** Returns the index just past the code span opened at `start`, or undefined when unclosed. */
function codeSpanEnd(text: string, start: number): number | undefined {
  let length = 0;
  while (text[start + length] === "`") length += 1;
  let index = start + length;
  while (index < text.length) {
    if (text[index] !== "`") {
      index += 1;
      continue;
    }
    let closing = 0;
    while (text[index + closing] === "`") closing += 1;
    if (closing === length) return index + closing;
    index += closing;
  }
  return;
}

interface LinkSpan {
  label: string;
  url: string;
  end: number;
}

/** Recognizes `[label](destination "title")` starting at `start`, honouring escapes and nesting. */
function linkSpan(text: string, start: number): LinkSpan | undefined {
  let depth = 0;
  let index = start;
  let labelEnd = -1;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === "`") index = codeSpanEnd(text, index) ?? index + 1;
    else if (char === "[") {
      depth += 1;
      index += 1;
    } else if (char === "]") {
      depth -= 1;
      if (depth === 0) {
        labelEnd = index;
        break;
      }
      index += 1;
    } else index += 1;
  }
  if (labelEnd < 0 || text[labelEnd + 1] !== "(") return;
  depth = 0;
  index = labelEnd + 2;
  while (index < text.length) {
    const char = text[index];
    if (char === "\\") index += 2;
    else if (char === "(") {
      depth += 1;
      index += 1;
    } else if (char === ")") {
      if (depth === 0) break;
      depth -= 1;
      index += 1;
    } else index += 1;
  }
  if (text[index] !== ")") return;
  let destination = text.slice(labelEnd + 2, index).trim();
  const titled = destination.match(/^(.*?)[ \t]+(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')$/);
  if (titled?.[1] !== undefined) destination = titled[1].trim();
  if (destination.startsWith("<") && destination.endsWith(">")) {
    destination = destination.slice(1, -1);
  }
  return {
    label: text.slice(start + 1, labelEnd),
    url: destination.replace(/\\([!-/:-@[-`{-~])/g, "$1"),
    end: index + 1,
  };
}

/** Index just past the atomic span at `index` (escape, code span, or link), else `index + 1`. */
function skipSpan(text: string, index: number): number {
  const char = text[index];
  if (char === "\\") return Math.min(index + 2, text.length);
  if (char === "`") return codeSpanEnd(text, index) ?? index + 1;
  if (char === "[") return linkSpan(text, index)?.end ?? index + 1;
  return index + 1;
}

function closingDelimiter(text: string, delimiter: string, from: number): number {
  let index = from;
  while (index < text.length) {
    if (text.startsWith(delimiter, index)) return index;
    index = skipSpan(text, index);
  }
  return -1;
}

function emphasis(
  text: string,
  index: number,
  style: InlineStyle,
): { runs: InlineRun[]; end: number } | undefined {
  for (const delimiter of ["**", "__", "*", "_"]) {
    if (!text.startsWith(delimiter, index)) continue;
    const contentStart = index + delimiter.length;
    const close = closingDelimiter(text, delimiter, contentStart);
    if (close <= contentStart) return;
    const flag = delimiter.length === 2 ? "bold" : "italic";
    return {
      runs: parseInline(text.slice(contentStart, close), { ...style, [flag]: true }),
      end: close + delimiter.length,
    };
  }
  return;
}

function codeSpanContent(span: string): string {
  const content = span.replace(/\n/g, " ");
  return content.length > 2 && content.startsWith(" ") && content.endsWith(" ") && content.trim()
    ? content.slice(1, -1)
    : content;
}

/** Converts one line of inline Markdown into styled runs. */
export function parseInline(source: string, style: InlineStyle = PLAIN): InlineRun[] {
  const text = source.replace(STRAY_TABLE_SYNTAX, "");
  const runs: InlineRun[] = [];
  let buffer = "";
  let index = 0;
  const flush = () => {
    if (buffer) runs.push(run(buffer, style));
    buffer = "";
  };
  while (index < text.length) {
    const char = text[index]!;
    const next = text[index + 1];
    if (char === "\\" && next !== undefined && ASCII_PUNCTUATION.test(next)) {
      buffer += next;
      index += 2;
      continue;
    }
    if (char === "`") {
      const end = codeSpanEnd(text, index);
      if (end !== undefined) {
        let length = 0;
        while (text[index + length] === "`") length += 1;
        flush();
        runs.push(
          run(codeSpanContent(text.slice(index + length, end - length)), { ...style, code: true }),
        );
        index = end;
        continue;
      }
    }
    if (char === "[") {
      const link = linkSpan(text, index);
      if (link) {
        flush();
        runs.push(...parseInline(link.label, { ...style, link: link.url }));
        index = link.end;
        continue;
      }
    }
    if (char === "*" || char === "_") {
      const styled = emphasis(text, index, style);
      if (styled) {
        flush();
        runs.push(...styled.runs);
        index = styled.end;
        continue;
      }
    }
    buffer += char;
    index += 1;
  }
  flush();
  return normalizeRuns(runs);
}

function paragraphText(lines: string[]): string {
  let text = "";
  for (const [position, line] of lines.entries()) {
    const trimmed = line.trim();
    if (position > 0) text += HARD_BREAK.test(lines[position - 1]!) ? "\n" : " ";
    text += trimmed.replace(HARD_BREAK, "").trimEnd();
  }
  return text;
}

/** Trims the outer whitespace of a run list, which an empty first or last table cell leaves. */
function trimRuns(runs: InlineRun[]): InlineRun[] {
  const result = runs.map((item) => ({ ...item }));
  const first = result[0];
  if (first) first.text = first.text.trimStart();
  const last = result[result.length - 1];
  if (last) last.text = last.text.trimEnd();
  return normalizeRuns(result);
}

/**
 * A cell holds ordinary block Markdown (a list, a heading, several paragraphs), so it is parsed as
 * blocks and folded onto one line; block syntax never shows up as cell text.
 */
function tableCellRuns(cell: string, header: boolean): InlineRun[] {
  const runs = parseBlocks(cell.split(TABLE_CELL_LINE_BREAK))
    .filter((node) => node.kind === "code" || node.runs.length > 0)
    .flatMap((node, position) => [
      ...(position > 0 ? [run(" ", PLAIN)] : []),
      ...(node.kind === "code" ? [run(node.text, { ...PLAIN, code: true })] : node.runs),
    ]);
  return normalizeRuns(
    runs.map((item) => ({
      ...item,
      text: item.text.replace(/\s*\n\s*/g, " "),
      bold: item.bold || header,
    })),
  );
}

/** One paragraph per row, cells joined by ` | `; a row whose cells are all empty yields nothing. */
function tableRowNode(line: string, header: boolean): DescriptionNode | undefined {
  const cells = line
    .slice(TABLE_ROW_MARKER.length)
    .split(TABLE_CELL_SEPARATOR)
    .map((cell) => tableCellRuns(cell, header));
  if (cells.every((cell) => cell.length === 0)) return;
  const runs = cells.flatMap((cell, position) =>
    position > 0 ? [run(" | ", PLAIN), ...cell] : cell,
  );
  return { kind: "paragraph", runs: trimRuns(runs) };
}

function quoteNode(node: DescriptionNode): DescriptionNode {
  if (node.kind === "code")
    return { kind: "quote", runs: [run(node.text, { ...PLAIN, code: true })] };
  const runs =
    node.kind === "heading" ? node.runs.map((item) => ({ ...item, bold: true })) : node.runs;
  return { kind: "quote", runs };
}

function listItemNodes(kind: "bulleted" | "numbered", body: string[]): DescriptionNode[] {
  const item: DescriptionNode = { kind, runs: [] };
  const result: DescriptionNode[] = [item];
  for (const node of parseBlocks(body)) {
    if (node.kind === "paragraph" || node.kind === "heading") {
      if (item.runs.length && node.runs.length) item.runs.push(run("\n", PLAIN));
      item.runs.push(...node.runs);
      item.runs = normalizeRuns(item.runs);
    } else result.push(node);
  }
  return result;
}

function parseBlocks(lines: string[]): DescriptionNode[] {
  const nodes: DescriptionNode[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    if (isBlank(line)) {
      index += 1;
      continue;
    }

    const fence = line.match(FENCE);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]!;
        const closing = candidate.match(FENCE);
        if (
          closing &&
          closing[1]![0] === marker[0] &&
          closing[1]!.length >= marker.length &&
          candidate.slice(closing[0].length).trim() === ""
        ) {
          index += 1;
          break;
        }
        body.push(candidate);
        index += 1;
      }
      const text = body.join("\n").replace(/\s+$/, "");
      if (text) nodes.push({ kind: "code", text });
      continue;
    }

    const heading = line.match(HEADING);
    if (heading) {
      const title = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "").trim();
      const level = Math.min(heading[1]!.length, 3) as 1 | 2 | 3;
      const runs = parseInline(title);
      if (runs.length) nodes.push({ kind: "heading", level, runs });
      index += 1;
      continue;
    }

    if (QUOTE.test(line)) {
      const body: string[] = [];
      while (index < lines.length) {
        const candidate = lines[index]!;
        const quoted = candidate.match(QUOTE);
        if (quoted) body.push(quoted[1]!);
        else if (!isBlank(candidate) && !startsBlock(candidate) && body.length)
          body.push(candidate);
        else break;
        index += 1;
      }
      nodes.push(...parseBlocks(body).map(quoteNode));
      continue;
    }

    const bullet = line.match(BULLET);
    const ordered = bullet ? undefined : line.match(ORDERED);
    const listMatch = bullet ?? ordered;
    if (listMatch) {
      const indent = listMatch[1]!.length;
      const spaces = listMatch[3]?.length ?? 1;
      // An ordered marker is its digits plus the delimiter, which the pattern does not capture.
      const markerLength = listMatch[2]!.length + (ordered ? 1 : 0);
      const contentIndent = indent + markerLength + (spaces > 4 ? 1 : spaces);
      const body: string[] = [listMatch[4] ?? ""];
      index += 1;
      while (index < lines.length) {
        const candidate = lines[index]!;
        if (isBlank(candidate)) {
          const following = lines.slice(index + 1).find((value) => !isBlank(value));
          if (following === undefined || indentation(following) < indent + 2) break;
          body.push("");
          index += 1;
          continue;
        }
        const candidateIndent = indentation(candidate);
        if (candidateIndent >= indent + 2) {
          body.push(candidate.slice(Math.min(candidateIndent, contentIndent)));
        } else if (!startsBlock(candidate) && body[body.length - 1] !== "") {
          body.push(candidate);
        } else break;
        index += 1;
      }
      nodes.push(...listItemNodes(bullet ? "bulleted" : "numbered", body));
      continue;
    }

    if (isTableRow(line) || isTableSeparator(line)) {
      // A separator marks the row before it as a header, wherever in the table that row sits.
      const rows: string[] = [];
      const headerRows = new Set<number>();
      while (index < lines.length) {
        const candidate = lines[index]!;
        if (isTableSeparator(candidate)) headerRows.add(rows.length - 1);
        else if (isTableRow(candidate)) rows.push(candidate);
        else break;
        index += 1;
      }
      for (const [position, row] of rows.entries()) {
        const node = tableRowNode(row, headerRows.has(position));
        if (node) nodes.push(node);
      }
      continue;
    }

    const body: string[] = [line];
    index += 1;
    while (index < lines.length && !isBlank(lines[index]!) && !startsBlock(lines[index]!)) {
      body.push(lines[index]!);
      index += 1;
    }
    const runs = parseInline(paragraphText(body));
    if (runs.length) nodes.push({ kind: "paragraph", runs });
  }
  return nodes;
}

/** Parses a description into flat blocks; a blank description yields no blocks. */
export function parseDescriptionMarkdown(markdown: string): DescriptionNode[] {
  return parseBlocks(markdown.replace(/\r\n?/g, "\n").split("\n")).filter(
    (node) => node.kind === "code" || node.runs.length > 0,
  );
}

export function nodeText(node: DescriptionNode): string {
  return node.kind === "code" ? node.text : node.runs.map((item) => item.text).join("");
}

/** The whitespace-normalized visible text of a description, block by block. */
export function descriptionPlainText(nodes: DescriptionNode[]): string {
  return nodes.map(nodeText).join(" ").replace(/\s+/g, " ").trim();
}
