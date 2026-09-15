function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : undefined;
}

export function pageId(page: Record<string, unknown>): string {
  if (typeof page.id !== "string") throw new Error("Notion returned a page without an ID");
  return page.id;
}

export function pageProperties(page: Record<string, unknown>): Record<string, unknown> {
  return object(page.properties) ?? {};
}

function property(properties: Record<string, unknown>, name: string): Record<string, unknown> {
  return object(properties[name]) ?? {};
}

function richTextContent(values: unknown): string {
  if (!Array.isArray(values)) return "";
  return values
    .map((item) => {
      const record = object(item);
      return typeof record?.plain_text === "string" ? record.plain_text : "";
    })
    .join("");
}

export function readTitle(properties: Record<string, unknown>, name: string): string {
  return richTextContent(property(properties, name).title);
}

export function readRichText(
  properties: Record<string, unknown>,
  name: string,
): string | undefined {
  return richTextContent(property(properties, name).rich_text) || undefined;
}

export function readUrl(properties: Record<string, unknown>, name: string): string | undefined {
  const value = property(properties, name).url;
  return typeof value === "string" ? value : undefined;
}

export function readDate(properties: Record<string, unknown>, name: string): string | undefined {
  const value = object(property(properties, name).date)?.start;
  return typeof value === "string" ? value : undefined;
}

export function readCheckbox(properties: Record<string, unknown>, name: string): boolean {
  return property(properties, name).checkbox === true;
}

export function readNumber(properties: Record<string, unknown>, name: string): number | undefined {
  const value = property(properties, name).number;
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function readSelect(properties: Record<string, unknown>, name: string): string | undefined {
  const value = object(property(properties, name).select)?.name;
  return typeof value === "string" ? value : undefined;
}

export function readRelation(properties: Record<string, unknown>, name: string): string[] {
  const relation = property(properties, name).relation;
  if (!Array.isArray(relation)) return [];
  return relation.flatMap((item) => {
    const id = object(item)?.id;
    return typeof id === "string" ? [id] : [];
  });
}

export const text = (value: string): Record<string, unknown> => ({
  rich_text: value ? [{ type: "text", text: { content: value.slice(0, 2000) } }] : [],
});
export const title = (value: string): Record<string, unknown> => ({
  title: [{ type: "text", text: { content: value.slice(0, 2000) } }],
});
export const date = (value?: string | null): Record<string, unknown> => ({
  date: value ? { start: value } : null,
});
export const url = (value?: string | null): Record<string, unknown> => ({ url: value ?? null });
export const select = (value: string): Record<string, unknown> => ({ select: { name: value } });
export const status = (value: string): Record<string, unknown> => ({ status: { name: value } });
export const checkbox = (value: boolean): Record<string, unknown> => ({ checkbox: value });
export const relation = (pageIdValue: string): Record<string, unknown> => ({
  relation: [{ id: pageIdValue }],
});
export const number = (value?: number | null): Record<string, unknown> => ({
  number: value ?? null,
});
