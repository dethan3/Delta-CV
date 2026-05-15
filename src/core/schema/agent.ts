import { z } from "zod";
import { HighlightSchema } from "./experience.ts";

export const ProjectMemorySchema = z.object({
  id: z.string(),
  repo: z.string(),
  title: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  activeMonths: z.number().int().positive(),
  category: z.string(),
  importance: z.number().min(0).max(1),
  signalScore: z.number().min(0).max(1),
  highlights: z.array(HighlightSchema),
  weakSignals: z.array(z.string()),
  stack: z.array(z.string()),
  tags: z.array(z.string()),
  evidenceEntryIds: z.array(z.string()),
});
export type ProjectMemory = z.infer<typeof ProjectMemorySchema>;

export const CapabilityClaimSchema = z.object({
  claim: z.string(),
  category: z.string(),
  technologies: z.array(z.string()),
  confidence: z.number().min(0).max(1),
  projectIds: z.array(z.string()),
  resumeUse: z.boolean(),
});
export type CapabilityClaim = z.infer<typeof CapabilityClaimSchema>;

export const SkillGroupSchema = z.object({
  category: z.string(),
  items: z.array(z.string()),
});
export type SkillGroup = z.infer<typeof SkillGroupSchema>;

export const ProjectSectionSchema = z.object({
  projectId: z.string(),
  title: z.string(),
  period: z.object({ from: z.string(), to: z.string() }),
  bullets: z.array(z.string()),
  stack: z.array(z.string()),
});
export type ProjectSection = z.infer<typeof ProjectSectionSchema>;

export const ResumeDraftSchema = z.object({
  version: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  login: z.string(),
  headline: z.string(),
  summary: z.string(),
  skills: z.array(SkillGroupSchema),
  selectedProjects: z.array(ProjectSectionSchema),
  otherExperience: z.array(z.string()),
  evidenceMap: z.record(z.string(), z.array(z.string())),
  styleNotes: z.string().optional(),
});
export type ResumeDraft = z.infer<typeof ResumeDraftSchema>;

export const CurateResultSchema = z.object({
  version: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  projects: z.array(ProjectMemorySchema),
  claims: z.array(CapabilityClaimSchema),
});
export type CurateResult = z.infer<typeof CurateResultSchema>;

export const CritiqueIssueSeveritySchema = z.enum(["error", "warning", "suggestion"]);
export type CritiqueIssueSeverity = z.infer<typeof CritiqueIssueSeveritySchema>;

export const CritiqueIssueCategorySchema = z.enum([
  "structure",
  "content",
  "language",
  "positioning",
  "length",
]);
export type CritiqueIssueCategory = z.infer<typeof CritiqueIssueCategorySchema>;

export const CritiqueIssueSchema = z.object({
  severity: CritiqueIssueSeveritySchema,
  category: CritiqueIssueCategorySchema,
  description: z.string(),
  location: z.string().optional(),
  suggestion: z.string(),
});
export type CritiqueIssue = z.infer<typeof CritiqueIssueSchema>;

export const CritiqueResultSchema = z.object({
  version: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  draftSlug: z.string(),
  overallScore: z.number().min(0).max(10),
  summary: z.string(),
  issues: z.array(CritiqueIssueSchema),
  passedChecks: z.array(z.string()),
});
export type CritiqueResult = z.infer<typeof CritiqueResultSchema>;

export const RevisionRecordSchema = z.object({
  version: z.number().int().positive(),
  generatedAt: z.string().datetime(),
  slug: z.string(),
  instruction: z.string(),
  previousDraftSlug: z.string(),
  draft: ResumeDraftSchema,
});
export type RevisionRecord = z.infer<typeof RevisionRecordSchema>;

export const JdSenioritySchema = z.enum([
  "junior",
  "mid",
  "senior",
  "staff",
  "principal",
  "unknown",
]);
export type JdSeniority = z.infer<typeof JdSenioritySchema>;

export const JdProfileSchema = z.object({
  version: z.literal(1),
  parsedAt: z.string().datetime(),
  slug: z.string(),
  jobTitle: z.string(),
  seniority: JdSenioritySchema,
  requiredSkills: z.array(z.string()),
  niceToHaveSkills: z.array(z.string()),
  keyResponsibilities: z.array(z.string()),
  targetProfile: z.string(),
});
export type JdProfile = z.infer<typeof JdProfileSchema>;
