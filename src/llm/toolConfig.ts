import type { ToolConfig } from "./types.js";

/**
 * 独立したツール群を1つのLLM呼び出しへまとめる。
 * 同名ツールは意図しない上書きを避けるため起動時に拒否する。
 */
export function mergeToolConfigs(
  ...configs: Array<ToolConfig | undefined>
): ToolConfig | undefined {
  const active = configs.filter((config): config is ToolConfig => config !== undefined);
  if (active.length === 0) return undefined;

  const owners = new Map<string, ToolConfig>();
  for (const config of active) {
    for (const definition of config.definitions) {
      if (owners.has(definition.name)) {
        throw new Error(`ツール名が重複しています: ${definition.name}`);
      }
      owners.set(definition.name, config);
    }
  }

  return {
    definitions: active.flatMap((config) => config.definitions),
    instructions: active.flatMap((config) => config.instructions ?? []),
    onCall: async (name, argsJson, signal) => {
      const owner = owners.get(name);
      if (!owner) throw new Error(`未知のツール: ${name}`);
      return owner.onCall(name, argsJson, signal);
    },
  };
}
