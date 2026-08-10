import { registerCoreCommands } from "./core";
import { registerPreferenceCommands } from "./preferences";
import { registerResearchCommands } from "./research";
import { registerTrendCommands } from "./trends";

export function registerDigestCommands(): void {
  registerCoreCommands();
  registerPreferenceCommands();
  registerTrendCommands();
  registerResearchCommands();
}
