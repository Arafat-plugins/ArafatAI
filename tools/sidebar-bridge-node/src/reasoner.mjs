import { buildLocalAgentReply, reason as localReason } from './local-planner.mjs';
import { reasonWithCodex } from './codex-provider.mjs';

export function createReasoner(config = {}) {
  const provider = config.provider || 'codex';

  return async function reason(body = {}) {
    if (provider === 'local') return localReason(body);

    const localDirect = buildLocalAgentReply(body, { allowQuestionFallback: false });
    if (localDirect) {
      return { ok: true, text: localDirect, source: 'node-local-planner', error: null };
    }

    const codexResult = await reasonWithCodex(body, config);
    if (codexResult.ok || !config.allowLocalFallback) return codexResult;

    const localResult = localReason(body);
    return {
      ...localResult,
      source: `${localResult.source}-after-codex-${codexResult.error || 'error'}`,
    };
  };
}
