import type {
  CourseCreate,
  CourseRecord,
  CourseUpdate,
  ExternalAssignment,
  PlanningOperationCounters,
  PlanWarning,
} from "../types.js";
import {
  addCanvasCourseIdToIndex,
  addCourseToIndex,
  buildCourseIndex,
  matchCourseFromIndex,
  matchCourseMetadata,
  normalizeCourse,
  type CourseMatch,
} from "./course-matcher.js";

interface CourseEntry {
  key: string;
  record: CourseRecord;
  sources: ExternalAssignment[];
  create?: CourseCreate;
  unnamed?: boolean;
  update?: CourseUpdate;
  redirect?: CourseEntry;
  conflict?: Extract<CourseMatch, { kind: "conflict" }>;
  ambiguous?: Extract<CourseMatch, { kind: "ambiguous" }>;
}

interface Ambiguity {
  source: ExternalAssignment;
  match: Extract<CourseMatch, { kind: "ambiguous" }>;
  destination?: CourseEntry;
}

/** Course evidence the catalog can act on; an unidentified source carries none. */
export type CourseEvidence = Exclude<CourseMatch, { kind: "unidentified" }>;

export type CourseResolution =
  | { kind: "resolved"; courseKey: string; pageId?: string }
  | { kind: "blocked"; warning?: PlanWarning };

function evidenceKeys(name?: string, code?: string, id?: string): string[] {
  return [
    ...[name, code]
      .filter((value): value is string => Boolean(value))
      .map((value) => `label:${normalizeCourse(value)}`),
    ...(id ? [`id:${id}`] : []),
  ];
}

/** A run-local catalog. Only course identity is provisional; assignment work is never queued here. */
export class CourseCatalog {
  private readonly entries = new Map<string, CourseEntry>();
  private readonly byPageId = new Map<string, CourseEntry>();
  private readonly originalIndex;
  private readonly index;
  private sequence = 0;
  private readonly ambiguities: Ambiguity[] = [];

  public constructor(
    courses: CourseRecord[],
    aliases: Record<string, string>,
    private readonly timestamp: string,
    counters?: PlanningOperationCounters,
  ) {
    this.originalIndex = buildCourseIndex(courses, aliases);
    for (const course of courses) {
      const key = `page:${course.pageId}`;
      const entry: CourseEntry = { key, record: { ...course }, sources: [] };
      this.entries.set(key, entry);
      this.byPageId.set(course.pageId, entry);
    }
    this.index = buildCourseIndex(
      [...this.entries.values()].map((entry) => entry.record),
      aliases,
      counters,
    );
  }

  public match(source: ExternalAssignment): CourseMatch {
    const match = matchCourseFromIndex(source, this.index, this.timestamp);
    if (match.kind !== "matched" || match.courseKey.startsWith("page:")) return match;
    const original = matchCourseFromIndex(source, this.originalIndex, this.timestamp);
    if (original.kind === "create" || original.kind === "unidentified") return match;
    return original;
  }

  /** Returns a deferred decision, evaluated only after all course evidence has been collected. */
  public accept(source: ExternalAssignment, match: CourseEvidence): () => CourseResolution {
    if (match.kind === "ambiguous") {
      const ambiguity: Ambiguity = { source, match };
      this.ambiguities.push(ambiguity);
      return () =>
        ambiguity.destination
          ? this.resolution(ambiguity.destination)
          : { kind: "blocked", warning: this.ambiguousWarning(match) };
    }
    let entry: CourseEntry;
    if (match.kind === "create") {
      const create = { ...match.course };
      entry = {
        key: create.key,
        create,
        unnamed: !source.courseName && !source.courseCode,
        sources: [],
        record: {
          pageId: `planned-course:${++this.sequence}`,
          title: create.title,
          ...(create.courseCode ? { courseCode: create.courseCode } : {}),
          ...(create.canvasCourseId ? { canvasCourseId: create.canvasCourseId } : {}),
          ...(create.canvasUrl ? { url: create.canvasUrl } : {}),
        },
      };
      this.entries.set(entry.key, entry);
      this.byPageId.set(entry.record.pageId, entry);
      addCourseToIndex(this.index, entry.record, entry.key);
    } else {
      entry = this.entries.get(match.courseKey)!;
      this.observe(entry, match);
    }
    const accepted = entry;
    entry.sources.push(source);
    return () => this.resolution(this.destination(accepted));
  }

  /** Resolve late course evidence before any assignment decisions or metrics are emitted. */
  public settle(): void {
    // A strong existing-course match can teach a label to otherwise unresolved sources in
    // either feed order. Keep multiple destinations ambiguous instead of choosing the first.
    const labels = new Map<string, Set<CourseEntry>>();
    const teach = (source: ExternalAssignment, target: CourseEntry): void => {
      for (const key of evidenceKeys(source.courseName, source.courseCode, source.canvasCourseId)) {
        const values = labels.get(key) ?? new Set<CourseEntry>();
        values.add(target);
        labels.set(key, values);
      }
    };
    for (const entry of this.entries.values()) {
      const final = this.destination(entry);
      if (final.create) continue;
      for (const source of entry.sources) teach(source, final);
    }
    for (const { source, match } of this.ambiguities) {
      for (const course of match.courses) {
        const entry = this.byPageId.get(course.pageId);
        if (entry && !entry.create) teach(source, entry);
      }
    }
    for (const entry of this.entries.values()) {
      if (!entry.create || entry.redirect || entry.conflict) continue;
      const destinations = new Set<CourseEntry>();
      for (const key of evidenceKeys(
        entry.record.title,
        entry.record.courseCode,
        entry.record.canvasCourseId,
      )) {
        for (const target of labels.get(key) ?? []) destinations.add(target);
      }
      if (destinations.size > 1) {
        entry.ambiguous = {
          kind: "ambiguous",
          method: "resolved-course",
          courses: [...destinations].map((value) => value.record),
        };
        continue;
      }
      if (!destinations.size) continue;
      const target = [...destinations][0]!;
      // Validate all observations before redirecting; conflicting evidence remains blocked.
      for (const source of entry.sources) this.observe(target, this.metadata(source, target));
      entry.redirect = target;
    }
    // Enrichment can leave a provisional course and an existing one sharing a Canvas ID in the
    // live index. Once redirects are known, candidates that collapse to one destination resolve.
    for (const ambiguity of this.ambiguities) {
      const destinations = new Set<CourseEntry>();
      for (const course of ambiguity.match.courses) {
        const entry = this.byPageId.get(course.pageId);
        if (entry) destinations.add(this.destination(entry));
      }
      if (destinations.size !== 1) continue;
      const target = [...destinations][0]!;
      this.observe(target, this.metadata(ambiguity.source, target));
      ambiguity.destination = target;
    }
  }

  private metadata(source: ExternalAssignment, target: CourseEntry): CourseMatch {
    return matchCourseMetadata(
      source,
      target.record,
      target.key,
      "resolved-course",
      this.timestamp,
    );
  }

  private observe(entry: CourseEntry, match: CourseMatch): void {
    if (match.kind === "conflict") entry.conflict ??= match;
    else if (match.kind === "matched" && match.update && !entry.conflict) {
      this.enrich(entry, match.update);
    }
  }

  private destination(entry: CourseEntry): CourseEntry {
    // A conflict is terminal even if a later label would redirect this provisional course.
    return entry.conflict || entry.ambiguous ? entry : (entry.redirect ?? entry);
  }

  private resolution(final: CourseEntry): CourseResolution {
    if (final.conflict) return { kind: "blocked" };
    if (final.ambiguous) {
      return {
        kind: "blocked",
        warning: {
          code: "ambiguous-course",
          message:
            "Source course labels resolved to multiple existing courses; assignment changes were blocked",
          details: final.ambiguous.courses.map((course) => course.pageId),
        },
      };
    }
    return {
      kind: "resolved",
      courseKey: final.key,
      ...(final.create ? {} : { pageId: final.record.pageId }),
    };
  }

  private ambiguousWarning(match: Extract<CourseMatch, { kind: "ambiguous" }>): PlanWarning {
    return {
      code: "ambiguous-course",
      message:
        match.method === "configured-alias"
          ? "Applicable configured-alias mappings resolved to multiple courses; assignment changes were blocked"
          : `Multiple courses matched at the ${match.method} confidence level`,
      // Provisional identities are run-local and never meaningful to a reader.
      details: match.courses
        .filter((course) => !this.byPageId.get(course.pageId)?.create)
        .map((course) => course.pageId),
    };
  }

  private enrich(entry: CourseEntry, update: CourseUpdate): void {
    if (update.canvasCourseId && !entry.record.canvasCourseId) {
      entry.record.canvasCourseId = update.canvasCourseId;
      addCanvasCourseIdToIndex(this.index, entry.record, update.canvasCourseId);
    }
    if (update.canvasUrl) entry.record.url = update.canvasUrl;
    if (entry.create) {
      if (update.canvasCourseId) entry.create.canvasCourseId = update.canvasCourseId;
      if (update.canvasUrl) entry.create.canvasUrl = update.canvasUrl;
    } else {
      entry.update = { ...entry.update, ...update };
    }
  }

  public finish(usedKeys: ReadonlySet<string>): {
    creates: CourseCreate[];
    updates: CourseUpdate[];
    warnings: PlanWarning[];
    conflicts: number;
  } {
    const creates: CourseCreate[] = [];
    const updates: CourseUpdate[] = [];
    const warnings: PlanWarning[] = [];
    let conflicts = 0;
    for (const entry of this.entries.values()) {
      if (entry.conflict) {
        conflicts += 1;
        warnings.push({
          code: "course-metadata-conflict",
          message: `Course metadata conflicted in ${entry.conflict.fields.join(" and ")}; assignment work was blocked`,
          details: [entry.record.pageId],
        });
      }
      if (entry.conflict || entry.ambiguous || entry.redirect || !usedKeys.has(entry.key)) continue;
      if (entry.create) {
        creates.push(entry.create);
        if (entry.unnamed) {
          warnings.push({
            code: "unnamed-course",
            message: "A course lacked a usable name and will use a generated Canvas Course label",
          });
        }
      } else if (entry.update) updates.push(entry.update);
    }
    return { creates, updates, warnings, conflicts };
  }
}
