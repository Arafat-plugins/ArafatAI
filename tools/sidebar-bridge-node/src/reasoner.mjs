import { buildLocalAgentReply, reason as localReason } from './local-planner.mjs';
import { reasonWithCodex } from './codex-provider.mjs';
import { reasonWithPythonCore } from './python-core-provider.mjs';

export function createReasoner(config = {}) {
  const provider = config.provider || 'codex';

  return async function reason(body = {}) {
    if (provider === 'local' || body.force_local === true || body.provider === 'local') {
      return localReason(body);
    }

    if (provider === 'python-core' || provider === 'python' || body.provider === 'python-core' || body.provider === 'python') {
      const pythonResult = await reasonWithPythonCore(body, config);
      if (pythonResult.ok || !config.allowLocalFallback) return pythonResult;

      const localResult = localReason(body);
      return {
        ...localResult,
        source: `${localResult.source}-after-python-core-${pythonResult.error || 'error'}`,
      };
    }

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
