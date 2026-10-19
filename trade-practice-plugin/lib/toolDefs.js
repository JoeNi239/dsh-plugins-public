/**
 * Minimal model-facing text tool definition for plugin-scoped tools.
 * DSH expects `output.render`; the tool body returns `{ text }`.
 */
export function defineTextTool(definition) {
  return {
    name: definition.name,
    description: definition.description,
    parameters: definition.parameters,
    ...(definition.timeoutMs === undefined ? {} : { timeoutMs: definition.timeoutMs }),
    output: {
      schema: {
        type: 'object',
        properties: { text: { type: 'string' } },
        required: ['text'],
        additionalProperties: false,
      },
      render: (_args, value) => String(
        value && typeof value === 'object' && typeof value.text === 'string' ? value.text : '',
      ),
    },
    async execute(args, exec) {
      const text = await definition.execute(args, exec)
      return { text: String(text) }
    },
  }
}
