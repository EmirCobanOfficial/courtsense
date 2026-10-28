// Hard spending cap for live Muse Spark calls. Every request is priced at its worst case before it is sent:
// input tokens <= request bytes + framing overhead (a token always covers at least one byte of its text) and
// output tokens <= max_output_tokens (reasoning tokens count against it). A request whose worst case would pass
// the cap is refused, and so is video, image or file input, whose token count cannot be bounded in advance.
import type OpenAI from "openai";

export const PRICE = { input: 1.25 / 1e6, output: 4.25 / 1e6 }; // USD per token, Muse Spark 1.3 on dev.meta.ai
const OVERHEAD_TOKENS = 2000;

export class BudgetError extends Error {}

export type LedgerEntry = { worstUsd: number; costUsd: number; inputTokens: number; outputTokens: number; failed?: boolean };
export type Ledger = { capUsd: number; spentUsd: number; calls: number; refused: number; entries: LedgerEntry[]; lastInput?: unknown };
type Client = Pick<OpenAI, "responses">;
type Create = (params: unknown, options?: unknown) => Promise<OpenAI.Responses.Response>;

export function worstCaseUsd(params: Record<string, unknown>): number {
  return (Buffer.byteLength(JSON.stringify(params)) + OVERHEAD_TOKENS) * PRICE.input + Number(params.max_output_tokens) * PRICE.output;
}

export function budgetClient(inner: Client, capUsd: number): { client: Client; ledger: Ledger } {
  const ledger: Ledger = { capUsd, spentUsd: 0, calls: 0, refused: 0, entries: [] };
  const create = async (params: Record<string, unknown>, options?: unknown) => {
    const body = JSON.stringify(params);
    const refuse = (why: string) => {
      ledger.refused++;
      throw new BudgetError(`budget mode: ${why}`);
    };
    if (/"input_(video|image|file)"/.test(body)) refuse("video, image and file input are disabled because their token count cannot be bounded before the call");
    const maxOut = Number(params.max_output_tokens);
    if (!Number.isFinite(maxOut) || maxOut <= 0) refuse("max_output_tokens must be set");
    if (params.stream) refuse("streaming requests are not supported");
    const worstUsd = worstCaseUsd(params);
    if (ledger.spentUsd + worstUsd > capUsd) refuse(`worst case $${worstUsd.toFixed(4)} would pass the $${capUsd} cap (spent $${ledger.spentUsd.toFixed(4)})`);
    ledger.lastInput = params.input;
    let res: OpenAI.Responses.Response;
    try {
      res = await (inner.responses.create as unknown as Create)(params, options);
    } catch (e) {
      // a failed call may still be billed: count its worst case
      ledger.calls++;
      ledger.spentUsd += worstUsd;
      ledger.entries.push({ worstUsd, costUsd: worstUsd, inputTokens: 0, outputTokens: 0, failed: true });
      throw e;
    }
    const u = res.usage;
    const costUsd = u ? u.input_tokens * PRICE.input + u.output_tokens * PRICE.output : worstUsd;
    ledger.calls++;
    ledger.spentUsd += costUsd;
    ledger.entries.push({ worstUsd, costUsd, inputTokens: u?.input_tokens ?? 0, outputTokens: u?.output_tokens ?? 0 });
    return res;
  };
  return { client: { responses: { create } } as unknown as Client, ledger };
}
