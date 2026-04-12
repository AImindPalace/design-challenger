import AjvModule from "ajv";
import type { ErrorObject } from "ajv";

// Handle CJS default export under Node16 module resolution
const Ajv = AjvModule.default ?? AjvModule;
import type { ChallengerOutput, JudgeOutput } from "./types.js";
import type { VerificationResult, WriterDispositionEntry } from "../types.js";

const ajv = new Ajv({ allErrors: true });

const evidenceSchema = {
  type: "object",
  properties: {
    type: { type: "string", enum: ["file", "url", "git_commit"] },
    location: { type: "string" },
    lines: { type: "string" },
    summary: { type: "string" },
  },
  required: ["type", "location", "summary"],
  additionalProperties: false,
} as const;

const findingSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    summary: { type: "string" },
    severity: { type: "string", enum: ["CRITICAL", "IMPORTANT", "MINOR"] },
    assumption_id: { type: "integer" },
    counter_design_divergence: { type: "boolean" },
    upstream_issue: { type: "boolean" },
    upstream_source: { type: "string" },
    evidence: { type: "array", items: evidenceSchema },
    evidence_type: { type: "string", enum: ["codebase", "external"] },
    evidence_verified: { type: "boolean" },
    recommendation: { type: "string" },
  },
  required: [
    "id",
    "summary",
    "severity",
    "counter_design_divergence",
    "upstream_issue",
    "evidence",
    "evidence_type",
    "recommendation",
  ],
  additionalProperties: false,
} as const;

const assumptionSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    text: { type: "string" },
    source: { type: "string" },
    status: { type: "string", enum: ["verified", "falsified", "untested"] },
    evidence: { type: "string" },
  },
  required: ["id", "text", "source", "status", "evidence"],
  additionalProperties: false,
} as const;

const divergencePointSchema = {
  type: "object",
  properties: {
    id: { type: "integer" },
    writer_choice: { type: "string" },
    challenger_alternative: { type: "string" },
    reasoning: { type: "string" },
  },
  required: ["id", "writer_choice", "challenger_alternative", "reasoning"],
  additionalProperties: false,
} as const;

const counterDesignSchema = {
  type: "object",
  properties: {
    summary: { type: "string" },
    divergence_points: { type: "array", items: divergencePointSchema },
    writer_strengths: { type: "string" },
  },
  required: ["summary", "divergence_points", "writer_strengths"],
  additionalProperties: false,
} as const;

// Schema for ChallengerOutput
const challengerOutputSchema = {
  type: "object",
  properties: {
    round: { type: "integer" },
    protocol_phase: {
      type: "string",
      enum: [
        "exploration",
        "counter_design_hypothesis_tester",
        "skeptical_verifier",
        "pre_mortem",
      ],
    },
    counter_design: counterDesignSchema,
    steelman: { type: "string" },
    assumptions: { type: "array", items: assumptionSchema },
    findings: { type: "array", items: findingSchema },
    pass: { type: "boolean" },
  },
  required: [
    "round",
    "protocol_phase",
    "assumptions",
    "findings",
    "pass",
  ],
  additionalProperties: false,
} as const;

// Schema for JudgeOutput
const judgeOutputSchema = {
  type: "object",
  properties: {
    forwarded_findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          original_id: { type: "integer" },
          adjusted_severity: {
            type: "string",
            enum: ["CRITICAL", "IMPORTANT", "MINOR"],
          },
          rationale: { type: "string" },
        },
        required: ["original_id", "adjusted_severity", "rationale"],
        additionalProperties: false,
      },
    },
    filtered_findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          original_id: { type: "integer" },
          reason: { type: "string" },
          rationale: { type: "string" },
        },
        required: ["original_id", "reason", "rationale"],
        additionalProperties: false,
      },
    },
  },
  required: ["forwarded_findings", "filtered_findings"],
  additionalProperties: false,
} as const;

// Schema for VerificationResult
const verificationResultSchema = {
  type: "object",
  properties: {
    claim: { type: "string" },
    verified: { type: "boolean" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
    evidence: { type: "string" },
    source_checked: { type: "string" },
  },
  required: ["claim", "verified", "confidence", "evidence", "source_checked"],
  additionalProperties: false,
} as const;

// Schema for WriterDispositionEntry[]
const writerDispositionsSchema = {
  type: "array",
  items: {
    type: "object",
    properties: {
      finding_id: { type: "integer" },
      disposition: { type: "string", enum: ["addressed", "rejected"] },
      detail: { type: "string" },
    },
    required: ["finding_id", "disposition", "detail"],
    additionalProperties: false,
  },
} as const;

// Compile validators
const validators = {
  challenger_output: ajv.compile<ChallengerOutput>(challengerOutputSchema),
  judge_output: ajv.compile<JudgeOutput>(judgeOutputSchema),
  verification_result: ajv.compile<VerificationResult>(verificationResultSchema),
  writer_dispositions: ajv.compile<WriterDispositionEntry[]>(writerDispositionsSchema),
};

export class ValidationError extends Error {
  constructor(
    message: string,
    public messageType: string,
    public schema: object,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

function getSchema(type: string): object {
  const schemas: Record<string, object> = {
    challenger_output: challengerOutputSchema,
    judge_output: judgeOutputSchema,
    verification_result: verificationResultSchema,
    writer_dispositions: writerDispositionsSchema,
  };
  return schemas[type] ?? {};
}

export function validateMessage<T>(type: string, data: unknown): T {
  const validate = validators[type as keyof typeof validators];
  if (!validate) throw new Error(`Unknown message type: ${type}`);
  if (validate(data)) return data as T;
  const errors = (validate.errors as ErrorObject[] | null | undefined)
    ?.map((e: ErrorObject) => `${e.instancePath} ${e.message}`)
    .join("; ");
  throw new ValidationError(
    `Validation failed for ${type}: ${errors}`,
    type,
    getSchema(type),
  );
}

// Export schemas so they can be embedded in retry prompts
export {
  challengerOutputSchema,
  judgeOutputSchema,
  verificationResultSchema,
  writerDispositionsSchema,
};
