import { describe, expect, it } from "vitest";
import { sanitizeDescription } from "../../src/canvas/normalize-assignment.ts";
import {
  TABLE_ROW_MARKER,
  TABLE_SEPARATOR_MARKER,
  descriptionPlainText,
  parseDescriptionMarkdown,
  parseInline,
} from "../../src/description-document.ts";
import { PARAGRAPH_TEXT_LIMIT, paragraph, splitText, toggle } from "../../src/notion/blocks.ts";
import { descriptionBlocks } from "../../src/notion/description-blocks.ts";
import {
  DESCRIPTION_HASH_VERSION,
  MANAGED_DESCRIPTION_TITLE,
  descriptionHashVersion,
  isOutdatedDescriptionHash,
  managedDescriptionHash,
  replaceManagedDescription,
} from "../../src/notion/descriptions.ts";
import { blockText } from "../../src/notion/managed-section.ts";
import { applyPlan } from "../../src/sync/reconcile.ts";
import type { SyncPlan } from "../../src/types.ts";
import { config, FakeGateway } from "../helpers.ts";

type RichText = Array<Record<string, unknown>>;

function richText(block: Record<string, unknown>): RichText {
  return (block[block.type as string] as { rich_text: RichText }).rich_text;
}

function plainRuns(markdown: string): Array<[string, string]> {
  return parseDescriptionMarkdown(markdown).map((node) => [
    node.kind,
    node.kind === "code" ? node.text : node.runs.map((run) => run.text).join(""),
  ]);
}

describe("description document parsing", () => {
  it("unescapes the punctuation turndown protects", () => {
    expect(parseInline("2 \\* 3 = 6, Snake\\_case, 1\\. not a list, \\[x\\]")).toEqual([
      {
        text: "2 * 3 = 6, Snake_case, 1. not a list, [x]",
        bold: false,
        italic: false,
        code: false,
      },
    ]);
  });

  it("parses nested emphasis, code spans, and links", () => {
    const runs = parseInline(
      "**_both_** `a_b` [**bold link**](https://e.com) _see [x](https://a.com/b_c)_",
    );
    expect(runs).toEqual([
      { text: "both", bold: true, italic: true, code: false },
      { text: " ", bold: false, italic: false, code: false },
      { text: "a_b", bold: false, italic: false, code: true },
      { text: " ", bold: false, italic: false, code: false },
      { text: "bold link", bold: true, italic: false, code: false, link: "https://e.com" },
      { text: " ", bold: false, italic: false, code: false },
      { text: "see ", bold: false, italic: true, code: false },
      { text: "x", bold: false, italic: true, code: false, link: "https://a.com/b_c" },
    ]);
  });

  it("leaves unmatched delimiters and brackets as literal text", () => {
    expect(
      parseInline("a * b [not a link] `open")
        .map((run) => run.text)
        .join(""),
    ).toBe("a * b [not a link] `open");
  });

  it("parses every block kind and flattens nested lists", () => {
    const markdown = [
      "## Week 3",
      "",
      "Intro line  ",
      "continued after a hard break",
      "",
      "-   First",
      "    -   Nested",
      "-   Second",
      "",
      "1.  Step one",
      "2.  Step two",
      "",
      "> Quoted **text**",
      "",
      "```",
      "def f(x):",
      "    return x",
      "```",
      "",
      `${TABLE_ROW_MARKER}| Col A | Col B |`,
      TABLE_SEPARATOR_MARKER,
      `${TABLE_ROW_MARKER}| 1 \\| one | 2 |`,
      "",
      "#### Deep heading",
    ].join("\n");
    expect(plainRuns(markdown)).toEqual([
      ["heading", "Week 3"],
      ["paragraph", "Intro line\ncontinued after a hard break"],
      ["bulleted", "First"],
      ["bulleted", "Nested"],
      ["bulleted", "Second"],
      ["numbered", "Step one"],
      ["numbered", "Step two"],
      ["quote", "Quoted text"],
      ["code", "def f(x):\n    return x"],
      ["paragraph", "Col A | Col B"],
      ["paragraph", "1 | one | 2"],
      ["heading", "Deep heading"],
    ]);
    const nodes = parseDescriptionMarkdown(markdown);
    expect(nodes[0]).toMatchObject({ level: 2 });
    expect(nodes[nodes.length - 1]).toMatchObject({ level: 3 });
    expect(nodes[9]).toMatchObject({
      runs: [{ text: "Col A", bold: true }, { text: " | " }, { text: "Col B", bold: true }],
    });
  });

  it("keeps multi-paragraph list items in one item and lazy lines in one paragraph", () => {
    expect(plainRuns("-   First\n\n    Second paragraph\n-   Next")).toEqual([
      ["bulleted", "First\nSecond paragraph"],
      ["bulleted", "Next"],
    ]);
    expect(plainRuns("one\ntwo")).toEqual([["paragraph", "one two"]]);
  });

  it("derives one plain text from the same blocks", () => {
    expect(descriptionPlainText(parseDescriptionMarkdown("# A\n\nb  \nc\n\n- d"))).toBe("A b c d");
    expect(parseDescriptionMarkdown("   \n\n")).toEqual([]);
  });
});

describe("Canvas HTML to Notion blocks", () => {
  it("renders sanitized Canvas HTML without exposing Markdown syntax", () => {
    const html =
      "<h2>Reading</h2><p>Read <strong>chapters 1-2</strong>, answer 2 * 3 = 6 questions on " +
      '<a href="https://example.edu/x?a=1&amp;b=2">the site</a> &lt; snake_case</p>' +
      "<ul><li>One</li><li>Two <code>f()</code></li></ul><p>Line one<br>Line two</p>" +
      '<p><a href="/relative">relative</a> <a href="javascript:alert(1)">bad</a></p>';
    const { markdown, plainText } = sanitizeDescription(html);
    const blocks = descriptionBlocks(markdown ?? "");
    expect(blocks.map((block) => block.type)).toEqual([
      "heading_2",
      "paragraph",
      "bulleted_list_item",
      "bulleted_list_item",
      "paragraph",
      "paragraph",
    ]);
    expect(richText(blocks[1]!)).toEqual([
      { type: "text", text: { content: "Read " } },
      { type: "text", text: { content: "chapters 1-2" }, annotations: { bold: true } },
      { type: "text", text: { content: ", answer 2 * 3 = 6 questions on " } },
      {
        type: "text",
        text: { content: "the site", link: { url: "https://example.edu/x?a=1&b=2" } },
      },
      { type: "text", text: { content: " < snake_case" } },
    ]);
    expect(richText(blocks[3]!)).toEqual([
      { type: "text", text: { content: "Two " } },
      { type: "text", text: { content: "f()" }, annotations: { code: true } },
    ]);
    expect(blockText(blocks[4]!)).toBe("Line one\nLine two");
    // Relative and unsafe links keep their text but never become Notion links.
    expect(richText(blocks[5]!)).toEqual([{ type: "text", text: { content: "relative bad" } }]);
    for (const block of blocks) expect(blockText(block)).not.toMatch(/\\[*_.\-[\]]|\*\*|^#|\]\(/);
    expect(plainText).toBe(
      "Reading Read chapters 1-2, answer 2 * 3 = 6 questions on the site < snake_case One Two f() Line one Line two relative bad",
    );
  });

  it("renders tables one row per paragraph with a bold header", () => {
    const { markdown } = sanitizeDescription(
      "<table><thead><tr><th>Part</th><th>Points</th></tr></thead>" +
        "<tbody><tr><td>Essay | draft</td><td>10</td></tr></tbody></table>",
    );
    const blocks = descriptionBlocks(markdown ?? "");
    expect(blocks.map(blockText)).toEqual(["Part | Points", "Essay | draft | 10"]);
    expect(richText(blocks[0]!)[0]).toMatchObject({ annotations: { bold: true } });
    expect(richText(blocks[1]!)[0]).not.toHaveProperty("annotations");
  });

  it("preserves literal pipe-wrapped text instead of treating it as a table", () => {
    const { markdown, plainText } = sanitizeDescription("<p>| important |</p><p>| --- |</p>");
    const blocks = descriptionBlocks(markdown ?? "");
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph"]);
    expect(blocks.map(blockText)).toEqual(["| important |", "| --- |"]);
    expect(plainText).toBe("| important | | --- |");
  });

  it("renders code blocks as Notion code blocks", () => {
    const { markdown } = sanitizeDescription("<pre><code>x = 1\ny = 2</code></pre>");
    const [block] = descriptionBlocks(markdown ?? "");
    expect(block).toEqual({
      object: "block",
      type: "code",
      code: {
        rich_text: [{ type: "text", text: { content: "x = 1\ny = 2" } }],
        language: "plain text",
      },
    });
  });

  it("uses a placeholder for blank descriptions", () => {
    expect(descriptionBlocks("")).toEqual([paragraph("No description provided.")]);
    expect(descriptionBlocks(" \n ")).toEqual([paragraph("No description provided.")]);
  });

  it("splits long runs at word boundaries into rich text items, never mid-word", () => {
    const words = Array.from({ length: 900 }, (_, index) => `word${index}`).join(" ");
    const [block, ...rest] = descriptionBlocks(`**${words}**`);
    expect(rest).toEqual([]);
    const items = richText(block!);
    expect(items.length).toBeGreaterThan(1);
    expect(items.map((item) => (item.text as { content: string }).content).join("")).toBe(words);
    for (const [position, item] of items.entries()) {
      const content = (item.text as { content: string }).content;
      expect(content.length).toBeLessThanOrEqual(PARAGRAPH_TEXT_LIMIT);
      // Every cut lands after a space, so no word is ever divided between items.
      if (position < items.length - 1) expect(content).toMatch(/\S $/);
      expect(item).toMatchObject({ annotations: { bold: true } });
    }
    expect(blockText(block!)).toBe(words);
  });

  it("continues a block that needs more than 100 rich text items in further blocks", () => {
    const markdown = Array.from({ length: 150 }, (_, index) => `**b${index}** p${index}`).join(" ");
    const blocks = descriptionBlocks(markdown);
    expect(blocks.map((block) => block.type)).toEqual(["paragraph", "paragraph", "paragraph"]);
    expect(blocks.map((block) => richText(block).length)).toEqual([100, 100, 100]);
    expect(blocks.map(blockText).join("")).toBe(
      Array.from({ length: 150 }, (_, index) => `b${index} p${index}`).join(" "),
    );
  });

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(PARAGRAPH_TEXT_LIMIT - 1)}😀${"b".repeat(PARAGRAPH_TEXT_LIMIT - 1)}😀`;
    const pieces = splitText(text);
    expect(pieces.join("")).toBe(text);
    for (const piece of pieces) {
      expect(piece.length).toBeLessThanOrEqual(PARAGRAPH_TEXT_LIMIT);
      expect(piece).not.toMatch(/\p{Surrogate}/u);
    }
  });
});

describe("managed description hashes", () => {
  it("versions the hash and recognizes older formats", () => {
    const hash = managedDescriptionHash("Read **chapter 1**");
    expect(DESCRIPTION_HASH_VERSION).toBe("canvas-description:v3");
    expect(descriptionHashVersion(hash)).toBe(DESCRIPTION_HASH_VERSION);
    expect(isOutdatedDescriptionHash(hash)).toBe(false);
    expect(isOutdatedDescriptionHash(undefined)).toBe(false);
    expect(isOutdatedDescriptionHash("not-a-hash")).toBe(false);
    expect(isOutdatedDescriptionHash(managedDescriptionHash("x", "canvas-description:v2"))).toBe(
      true,
    );
  });

  it("depends on the rendered blocks, not the Markdown spelling", () => {
    expect(managedDescriptionHash("Read **chapter 1**")).toBe(
      managedDescriptionHash("Read __chapter 1__"),
    );
    expect(managedDescriptionHash("Read **chapter 1**")).not.toBe(
      managedDescriptionHash("Read chapter 1"),
    );
    expect(managedDescriptionHash("")).toBe(managedDescriptionHash(undefined));
  });
});

describe("managed description verification with native blocks", () => {
  const markdown =
    "## Reading\n\nRead **chapters 1-2** on [the site](https://example.edu/x).\n\n-   One\n-   Two\n\n```\ncode\n```";

  it("writes rich blocks once and then verifies them as Notion reads them back", async () => {
    const gateway = new FakeGateway();
    expect(await replaceManagedDescription(gateway, "page", markdown)).toEqual({
      repaired: true,
      replaced: true,
    });
    const marker = gateway.blocks.get("page")!.find((block) => block.type === "toggle")!;
    const children = gateway.blocks.get(marker.id as string)!;
    expect(children.map((block) => block.type)).toEqual([
      "heading_2",
      "paragraph",
      "bulleted_list_item",
      "bulleted_list_item",
      "code",
    ]);
    expect(children[1]!.paragraph).toMatchObject({
      rich_text: [
        { plain_text: "Read ", annotations: { bold: false } },
        { plain_text: "chapters 1-2", annotations: { bold: true } },
        { plain_text: " on " },
        { plain_text: "the site", href: "https://example.edu/x" },
        { plain_text: "." },
      ],
    });

    const writes = gateway.writes.length;
    expect(await replaceManagedDescription(gateway, "page", markdown)).toEqual({
      repaired: false,
      replaced: false,
    });
    expect(gateway.writes).toHaveLength(writes);
  });

  it("repairs a section whose styling or links drifted even when the text is unchanged", async () => {
    const drifts: Array<[number, (item: Record<string, unknown>) => void]> = [
      // "chapters 1-2" loses its bold annotation.
      [1, (item) => Object.assign(item, { annotations: { bold: false } })],
      // "the site" loses its link.
      [3, (item) => Object.assign(item, { text: { content: "the site", link: null } })],
    ];
    for (const [position, drift] of drifts) {
      const gateway = new FakeGateway();
      await replaceManagedDescription(gateway, "page", markdown);
      const marker = gateway.blocks.get("page")!.find((block) => block.type === "toggle")!;
      const item = richText(gateway.blocks.get(marker.id as string)![1]!)[position]!;
      expect(blockText({ type: "p", p: { rich_text: [item] } })).toBe(
        position === 1 ? "chapters 1-2" : "the site",
      );
      drift(item);
      expect(await replaceManagedDescription(gateway, "page", markdown)).toEqual({
        repaired: true,
        replaced: true,
      });
    }
  });
});

describe("description format upgrades", () => {
  function upgradePlan(descriptionMarkdown: string | undefined): SyncPlan {
    const source = { uid: "uid", title: "Assignment", inferredType: "Other" as const };
    return {
      coursesToCreate: [],
      coursesToUpdate: [],
      assignmentsToCreate: [],
      assignmentsToUpdate: [
        {
          pageId: "page",
          source: { ...source, ...(descriptionMarkdown ? { descriptionMarkdown } : {}) },
          courseKey: "page:course",
          properties: {},
          verifyDescription: true,
          descriptionHash: managedDescriptionHash(descriptionMarkdown),
          descriptionHashNeedsUpdate: true,
          missingEvidenceCleared: false,
        },
      ],
      assignmentsMissingEvidenceToUpdate: [],
      assignmentsToRemove: [],
      missingCandidatesObserved: 0,
      unchanged: 0,
      skipped: 0,
      warnings: [],
    };
  }

  function seedLegacyPage(gateway: FakeGateway, legacyBody: string): void {
    // The v2 representation: raw Markdown text in one paragraph under the managed toggle.
    gateway.seedBlock("page", {
      ...toggle(MANAGED_DESCRIPTION_TITLE, [paragraph(legacyBody)]),
      id: "managed",
    });
    gateway.seedPage("assignments", "page", {
      "Canvas Description Hash": {
        rich_text: [{ plain_text: `canvas-description:v2:${"0".repeat(64)}` }],
      },
    });
  }

  it("rewrites a legacy Markdown body once and only then writes the new hash", async () => {
    const gateway = new FakeGateway();
    seedLegacyPage(gateway, "Read **chapter 1**");
    const execution = await applyPlan(gateway, config(), upgradePlan("Read **chapter 1**"));
    expect(execution.appliedOperations.map((operation) => operation.kind)).toEqual([
      "assignment-description-update",
      "assignment-description-hash-update",
    ]);
    expect(execution.appliedOperations[0]?.description).toEqual({ repaired: true, replaced: true });

    const marker = gateway.blocks.get("page")!.find((block) => block.type === "toggle")!;
    expect(richText(gateway.blocks.get(marker.id as string)![0]!)).toMatchObject([
      { plain_text: "Read " },
      { plain_text: "chapter 1", annotations: { bold: true } },
    ]);
    const hashWrite = gateway.writes.findIndex(
      (write) =>
        write.kind === "update" && JSON.stringify(write.value).includes("Canvas Description Hash"),
    );
    const lastBlockWrite = gateway.writes.map((write) => write.kind).lastIndexOf("delete");
    expect(hashWrite).toBeGreaterThan(lastBlockWrite);
    expect(JSON.stringify(gateway.writes[hashWrite]!.value)).toContain(
      managedDescriptionHash("Read **chapter 1**"),
    );
  });

  it("upgrades an unchanged placeholder body with a metadata write alone", async () => {
    const gateway = new FakeGateway();
    seedLegacyPage(gateway, "No description provided.");
    const execution = await applyPlan(gateway, config(), upgradePlan(undefined));
    expect(execution.appliedOperations[0]?.description).toEqual({
      repaired: false,
      replaced: false,
    });
    expect(gateway.writes.map((write) => write.kind)).toEqual(["update"]);
    expect(JSON.stringify(gateway.writes[0]!.value)).toContain(managedDescriptionHash(undefined));
  });
});
