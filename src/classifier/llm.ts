import { ACTION_TYPES, SITUATION_STATES, type Classification } from '../domain.ts';
import { classifyWithRules } from './rules.ts';
import { validateClassification } from './validate.ts';

// Optional AI classifier. The model only interprets unstructured text into the
// closed vocabulary below. It never sets authority, approval, or state transitions:
// those are decided by deterministic code after this function returns.

export const LLM_MODEL = process.env.SITUATION_MODEL_LLM ?? 'claude-opus-5-5';

const OUTPUT_SCHEMA = {
  type: 'object',
  properties: {
    state: { type: 'string', enum: [...SITUATION_STATES] },
    action_type: { type: 'string', enum: [...ACTION_TYPES] },
    summary: { type: 'string' },
    next_action: { type: 'string' },
    trigger: { type: 'string' },
    rationale: { type: 'string' },
  },
  required: ['state', 'action_type', 'summary', 'next_action', 'trigger', 'rationale'],
  additionalProperties: false,
};

const SYSTEM_PROMPT = `You classify operational events for an operations team into a Situation Model.

States (choose exactly one, using this priority order when several apply):
- DECISIONS: a consequential choice needs authorized human judgment (pricing, contract or scope changes, policy exceptions, access/permission grants).
- WAITING: progress depends on an external person, event, or system that has not yet responded.
- WATCHING: a condition worth monitoring with no current impact and no action required yet.
- NEXT: legitimate work whose trigger or due date is in the future.
- NOW: action is required currently.

Action types (the downstream action this item would eventually need; "none" if only monitoring or waiting with nothing to do):
send_customer_reply, send_status_update, schedule_followup, issue_refund, publish_announcement,
restart_service, change_commercial_terms, grant_access, none.

You do not decide who is allowed to act. Do not reason about permissions; that is handled elsewhere.
Keep summary under 120 characters. next_action is one concrete step. trigger is the dependency, date or
threshold that would change the state, or an empty string.`;

export function llmAvailable(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export type FallbackReason = 'api_error' | 'refusal' | 'no_text' | 'malformed_json' | 'invalid_output';

export interface LlmResult {
  classification: Classification;
  classifier: string;
  fallback?: { reason: FallbackReason; detail: string };
}

export interface LlmRequest {
  model: string;
  max_tokens: number;
  system: string;
  output_config: { effort: 'low'; format: { type: 'json_schema'; schema: Record<string, unknown> } };
  messages: { role: 'user'; content: string }[];
}

export interface LlmResponse {
  stop_reason: string | null;
  content: { type: string; text?: string }[];
}

/** The only surface of the Claude API this app uses. Injectable so fallback paths are testable offline. */
export interface LlmClient {
  create(request: LlmRequest): Promise<LlmResponse>;
}

let defaultClient: LlmClient | undefined;

async function anthropicClient(): Promise<LlmClient> {
  if (!defaultClient) {
    const { default: Anthropic } = await import('@anthropic-ai/sdk');
    // Short timeout: intake must degrade to rules quickly, not hang on an unreachable API.
    const sdk = new Anthropic({ timeout: 20_000, maxRetries: 1 });
    defaultClient = { create: (request) => sdk.messages.create(request) };
  }
  return defaultClient;
}

/** Classifies with Claude; on any error, refusal, or invalid output, falls back to the rules classifier. */
export async function classifyWithLlm(text: string, client?: LlmClient): Promise<LlmResult> {
  let reason: FallbackReason;
  let detail: string;
  try {
    const response = await (client ?? (await anthropicClient())).create({
      model: LLM_MODEL,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      output_config: { effort: 'low', format: { type: 'json_schema', schema: OUTPUT_SCHEMA } },
      messages: [{ role: 'user', content: `Operational event:\n${text}` }],
    });

    const block = response.content.find((b) => b.type === 'text');
    if (response.stop_reason === 'refusal') {
      [reason, detail] = ['refusal', 'model refused'];
    } else if (typeof block?.text !== 'string') {
      [reason, detail] = ['no_text', `no text block (stop_reason ${response.stop_reason})`];
    } else {
      let parsed: unknown;
      try {
        parsed = JSON.parse(block.text);
      } catch {
        parsed = undefined;
      }
      if (parsed === undefined) {
        [reason, detail] = ['malformed_json', 'response was not valid JSON'];
      } else {
        const result = validateClassification(parsed);
        if (result.ok) return { classification: result.value, classifier: `llm:${LLM_MODEL}` };
        [reason, detail] = ['invalid_output', result.errors.join('; ')];
      }
    }
  } catch (err) {
    [reason, detail] = ['api_error', err instanceof Error ? err.message : String(err)];
  }
  const fallback = classifyWithRules(text);
  return {
    classification: { ...fallback, rationale: `${fallback.rationale} (LLM fallback, ${reason}: ${detail})` },
    classifier: 'rules (llm fallback)',
    fallback: { reason, detail },
  };
}
