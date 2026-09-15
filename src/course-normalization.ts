export function normalizeCourse(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}
