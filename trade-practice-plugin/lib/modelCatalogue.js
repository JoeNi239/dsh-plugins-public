const modelInfoCache = new Map()
const catalogueCache = { at: 0, data: null }

export function modelSelection(ctx) {
  let provider = (process.env.TRADE_PRACTICE_PROVIDER || '').trim()
  let model = (process.env.TRADE_PRACTICE_MODEL || '').trim()
  let reasoningEffort = ''
  try {
    const selection = ctx.get('agentDefaultModel')?.currentSelection?.()
    if (selection) {
      provider = provider || selection.provider || selection.providerId || ''
      model = model || selection.model || selection.modelId || selection.id || ''
      reasoningEffort = selection.reasoningEffort || selection.effort || ''
    }
  } catch {}
  return { provider, model, reasoningEffort: reasoningEffort || undefined }
}

async function resolveModelInfoCached(ctx, provider, model) {
  const key = `${provider}\u0000${model}`
  const cached = modelInfoCache.get(key)
  if (cached && Date.now() - cached.at < 5 * 60 * 1000) {
    return cached.info
  }
  const llm = ctx.get('llm')
  if (!llm) {
    throw new Error('LLM service unavailable')
  }
  const info = await llm.resolveModelInfo(provider, model)
  modelInfoCache.set(key, { at: Date.now(), info })
  return info
}

export async function modelCatalogue(ctx) {
  const llm = ctx.get('llm')
  let groups = null
  let fallbackDefault = null
  try {
    const controller = ctx.get('sessionController')
    if (controller && typeof controller.modelCatalog === 'function') {
      const catalog = await controller.modelCatalog()
      if (catalog && Array.isArray(catalog.groups)) {
        groups = catalog.groups
        fallbackDefault = catalog.default || null
      }
    }
  } catch {}

  if (!groups) {
    if (!llm) {
      return { providers: [], default: null, failures: [] }
    }
    groups = []
    for (const provider of llm.listProviders()) {
      let models = []
      try {
        models = await llm.listModels(provider.id)
      } catch {}
      groups.push({ id: provider.id, name: provider.name || provider.id, models })
    }
  }

  const providers = []
  const failures = []
  for (const group of groups) {
    const entries = []
    for (const model of (group.models || []).slice(0, 40)) {
      let info = null
      try {
        info = llm ? await resolveModelInfoCached(ctx, group.id, model.id) : null
      } catch (error) {
        failures.push({
          provider: group.id,
          model: model.id,
          error: error && error.message ? error.message : String(error),
        })
      }
      const reasoning = model.reasoning || (info && info.reasoning) || null
      entries.push({
        provider: group.id,
        id: model.id,
        name: model.name || (info && info.name) || model.id,
        description: model.description,
        modalities: info && Array.isArray(info.inputModalities) ? info.inputModalities : null,
        reasoning: reasoning
          ? {
              defaultEffort: reasoning.defaultEffort || null,
              efforts: (reasoning.efforts || []).map((effort) => ({
                id: effort.id,
                name: effort.name || effort.id,
                description: effort.description,
              })),
            }
          : null,
      })
    }
    providers.push({ id: group.id, name: group.name || group.id, models: entries })
  }
  return { providers, default: fallbackDefault, failures }
}

export async function getModelCatalogueResponse(ctx, refresh) {
  if (refresh || !catalogueCache.data || Date.now() - catalogueCache.at > 60 * 1000) {
    catalogueCache.data = await modelCatalogue(ctx)
    catalogueCache.at = Date.now()
  }
  return {
    ok: true,
    default: catalogueCache.data.default || modelSelection(ctx),
    providers: catalogueCache.data.providers,
    failures: catalogueCache.data.failures || [],
  }
}
